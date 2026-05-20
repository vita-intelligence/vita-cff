"""Portal endpoints for the standalone Specification surface.

The customer portal recently restructured from a single-page
"proposal contains everything" layout to separate Proposals and
Specs pages (so a customer with N specs across M proposals
doesn't drown in nested cards). This file backs those new
routes:

* ``GET /api/portal/specs/`` — list of every spec attached to
  any proposal owned by the logged-in client.
* ``GET /api/portal/specs/<sheet_id>/`` — single-spec detail
  with the same ``render_context`` shape the proposal-detail
  endpoint embeds, plus a thin ``proposal`` reference so the
  spec page can show "back to PROP-0123".

Ownership is enforced via the same ``ProposalLine`` join the
messaging endpoint uses, so the access rules are consistent
across surfaces.
"""

from __future__ import annotations

from typing import Any

from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView


def _client_proposals_qs(account):
    """Every proposal whose customer is the logged-in client's.

    Used by both the specs list (to join through lines) and the
    spec-detail ownership check.
    """

    from apps.proposals.models import Proposal
    return Proposal.objects.filter(customer_id=account.customer_id)


def _serialise_spec(sheet, proposal) -> dict[str, Any]:
    from apps.specifications.services import render_context as spec_render_context

    return {
        "id": str(sheet.id),
        "code": sheet.code or "",
        "document_kind": sheet.document_kind,
        "status": sheet.status,
        "formulation_name": (
            sheet.formulation_version.formulation.name
            if sheet.formulation_version_id
            else ""
        ),
        "formulation_version_number": (
            sheet.formulation_version.version_number
            if sheet.formulation_version_id
            else None
        ),
        "has_signature": bool(sheet.customer_signature_image),
        "customer_signed_at": (
            sheet.customer_signed_at.isoformat()
            if sheet.customer_signed_at is not None
            else None
        ),
        "proposal": {
            "id": str(proposal.id),
            "code": proposal.code or "",
            "status": proposal.status,
        } if proposal is not None else None,
    }


class SpecListView(PortalAPIView):
    """``GET /api/portal/specs/``.

    Returns every spec the client can see, keyed by proposal.
    Duplicates are removed (the same spec can appear on multiple
    proposal lines; we surface each spec once with its newest
    proposal reference).
    """

    def get(self, request: Request) -> Response:
        from apps.proposals.models import Proposal, ProposalLine
        from apps.specifications.models import SpecificationSheet

        proposal_qs = _client_proposals_qs(request.user)
        # Per-line attachments. A single SpecificationSheet may
        # appear on multiple proposals; we want the most recent
        # proposal to be the one we link back to.
        line_rows = (
            ProposalLine.objects
            .filter(
                proposal__in=proposal_qs,
                specification_sheet__isnull=False,
            )
            .select_related("proposal", "specification_sheet")
            .order_by("-proposal__updated_at")
        )
        seen: set[str] = set()
        rows: list[dict[str, Any]] = []
        for line in line_rows:
            sheet = line.specification_sheet
            if sheet is None:
                continue
            sid = str(sheet.id)
            if sid in seen:
                continue
            seen.add(sid)
            rows.append(_serialise_spec(sheet, line.proposal))

        # Legacy OneToOne path: ``Proposal.specification_sheet`` —
        # rare on new proposals but still in the schema.
        for proposal in (
            Proposal.objects
            .filter(pk__in=proposal_qs.values_list("pk", flat=True))
            .select_related("specification_sheet")
        ):
            sheet = proposal.specification_sheet
            if sheet is None:
                continue
            sid = str(sheet.id)
            if sid in seen:
                continue
            seen.add(sid)
            rows.append(_serialise_spec(sheet, proposal))
        return Response({"results": rows})


class SpecDetailView(PortalAPIView):
    """``GET /api/portal/specs/<sheet_id>/``.

    Returns the spec render context + the proposal it attaches to.
    Ownership: the spec must be linked (per-line OR legacy 1-to-1)
    to a proposal whose customer is the logged-in client's. Same
    leak-proof 404 contract as the messaging endpoint.
    """

    def get(self, request: Request, sheet_id: str) -> Response:
        from apps.proposals.models import Proposal, ProposalLine
        from apps.specifications.services import render_context as spec_render_context

        line = (
            ProposalLine.objects
            .select_related("proposal", "specification_sheet")
            .filter(
                specification_sheet_id=sheet_id,
                proposal__customer_id=request.user.customer_id,
            )
            .order_by("-proposal__updated_at")
            .first()
        )
        sheet = None
        proposal = None
        if line is not None:
            sheet = line.specification_sheet
            proposal = line.proposal
        else:
            legacy = (
                Proposal.objects
                .select_related("specification_sheet")
                .filter(
                    specification_sheet_id=sheet_id,
                    customer_id=request.user.customer_id,
                )
                .first()
            )
            if legacy is not None and legacy.specification_sheet is not None:
                sheet = legacy.specification_sheet
                proposal = legacy
        if sheet is None or proposal is None:
            raise NotFound("Specification not found.")

        payload = _serialise_spec(sheet, proposal)
        payload["render_context"] = spec_render_context(sheet)
        return Response(payload)
