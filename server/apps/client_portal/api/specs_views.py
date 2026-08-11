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
* ``GET /api/portal/specs/<sheet_id>/pdf/`` — server-rendered
  HTML preview the web-site portal iframes on its spec viewer.
  ``xframe_options_sameorigin`` opens the frame gate the same
  way ``ProposalPdfView`` does.

Ownership is enforced via the same ``ProposalLine`` join the
messaging endpoint uses, so the access rules are consistent
across surfaces.
"""

from __future__ import annotations

from typing import Any

from django.http import HttpResponse
from django.utils.decorators import method_decorator
from django.views.decorators.clickjacking import xframe_options_sameorigin
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView, _err
from apps.client_portal.models import PortalEvent
from apps.client_portal.queries import customer_ids_for_account
from apps.client_portal.services import record_portal_event


def _client_proposals_qs(account):
    """Every proposal owned by the logged-in client's customer rows.

    Used by both the specs list (to join through lines) and the
    spec-detail ownership check. ``customer_ids_for_account`` unions
    the FK target with sibling Customer rows sharing the account's
    email so existing duplicate-customer pairs keep surfacing every
    proposal until Phase 4's sweep collapses them.
    """

    from apps.proposals.models import Proposal
    return Proposal.objects.filter(
        customer_id__in=customer_ids_for_account(account),
    )


def _serialise_spec(sheet, proposal) -> dict[str, Any]:
    from apps.specifications.services import render_context as spec_render_context

    return {
        "id": str(sheet.id),
        "code": sheet.code or "",
        "document_kind": sheet.document_kind,
        "status": sheet.status,
        # ``formulation_id`` lets the marketing-site portal render a
        # "back to project" link on the spec viewer — the parent
        # project detail lives at /portal/projects/<formulation_id>.
        # Empty string when the spec has no version bond (shouldn't
        # happen in practice; kept defensive so a corrupt row can't
        # break the response).
        "formulation_id": (
            str(sheet.formulation_version.formulation_id)
            if sheet.formulation_version_id
            else ""
        ),
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

        # Third pass: standalone specs on a formulation the customer
        # owns (via a proposal pinning the same formulation). Catches
        # the auto-created FINAL spec — built post-trial and NOT
        # bundled into the original proposal — which the two passes
        # above can't see. The proposal we anchor against is the most
        # recently updated one on the same project.
        proposal_form_ids = list(
            proposal_qs.values_list(
                "formulation_version__formulation_id", flat=True
            ).distinct()
        )
        if proposal_form_ids:
            anchor_proposals: dict[str, Proposal] = {}
            for prop in (
                proposal_qs
                .select_related("formulation_version")
                .order_by("-updated_at")
            ):
                anchor_proposals.setdefault(
                    prop.formulation_version.formulation_id, prop
                )
            for sheet in (
                SpecificationSheet.objects
                .filter(formulation_version__formulation_id__in=proposal_form_ids)
                .select_related("formulation_version")
                .order_by("-updated_at")
            ):
                sid = str(sheet.id)
                if sid in seen:
                    continue
                anchor = anchor_proposals.get(
                    sheet.formulation_version.formulation_id
                )
                if anchor is None:
                    continue
                seen.add(sid)
                rows.append(_serialise_spec(sheet, anchor))
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
        from apps.specifications.models import SpecificationSheet
        from apps.specifications.services import render_context as spec_render_context

        owner_ids = customer_ids_for_account(request.user)
        line = (
            ProposalLine.objects
            .select_related("proposal", "specification_sheet")
            .filter(
                specification_sheet_id=sheet_id,
                proposal__customer_id__in=owner_ids,
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
                    customer_id__in=owner_ids,
                )
                .first()
            )
            if legacy is not None and legacy.specification_sheet is not None:
                sheet = legacy.specification_sheet
                proposal = legacy
        # Third lookup: FINAL spec auto-created after a trial passes.
        # It's NOT bundled into the original proposal — it stands
        # alone on the same formulation_version. Ownership still flows
        # from the customer through their proposal on the same project;
        # we just need to walk one extra hop (proposal →
        # formulation_version) to find the sheet.
        if sheet is None:
            shared_version_sheet = (
                SpecificationSheet.objects
                .select_related("formulation_version__formulation")
                .filter(
                    id=sheet_id,
                    formulation_version__formulation_id__in=(
                        Proposal.objects
                        .filter(customer_id__in=owner_ids)
                        .values("formulation_version__formulation_id")
                    ),
                )
                .first()
            )
            if shared_version_sheet is not None:
                sheet = shared_version_sheet
                proposal = (
                    Proposal.objects
                    .filter(
                        customer_id__in=owner_ids,
                        formulation_version__formulation_id=shared_version_sheet.formulation_version.formulation_id,
                    )
                    .order_by("-updated_at")
                    .first()
                )
        if sheet is None or proposal is None:
            raise NotFound("Specification not found.")

        payload = _serialise_spec(sheet, proposal)
        payload["render_context"] = spec_render_context(sheet)
        record_portal_event(
            organization=proposal.organization,
            proposal=proposal,
            client_account=request.user,
            kind=PortalEvent.Kind.SPEC_VIEWED,
            metadata={"spec_id": str(sheet.id)},
            request=request,
        )
        return Response(payload)


class SpecSignView(PortalAPIView):
    """``POST /api/portal/specs/<sheet_id>/sign/``.

    Standalone customer-signature capture for any spec the client
    owns — works for both proposal-bundled drafts AND standalone
    FINAL specs (the auto-created production-authorisation
    document). The existing
    ``proposals/<id>/specs/<sheet_id>/sign/`` endpoint only handles
    the bundled case because it gates on the spec being attached to
    a specific proposal; the FINAL spec is never bundled, so we need
    this surface to sign it.

    Ownership: same three-pass lookup the detail view uses (proposal
    line / legacy 1-to-1 / shared formulation_version). The backend
    ``accept_as_customer`` service handles the actual signature
    capture + status flip + downstream project auto-advance.
    """

    def post(self, request: Request, sheet_id: str) -> Response:
        from apps.client_portal.api.views import (
            _client_ip,
            _client_signer_fields,
            _user_agent,
        )
        from apps.proposals.models import Proposal, ProposalLine
        from apps.specifications.models import SpecificationSheet
        from apps.specifications.services import (
            InvalidStatusTransition,
            SignatureRequired,
            accept_as_customer,
        )
        from config.signatures import SignatureImageInvalid

        # Three-pass ownership lookup — same shape as SpecDetailView.
        sheet: SpecificationSheet | None = None
        proposal: Proposal | None = None
        owner_ids = customer_ids_for_account(request.user)

        line = (
            ProposalLine.objects
            .select_related("proposal", "specification_sheet")
            .filter(
                specification_sheet_id=sheet_id,
                proposal__customer_id__in=owner_ids,
            )
            .order_by("-proposal__updated_at")
            .first()
        )
        if line is not None:
            sheet = line.specification_sheet
            proposal = line.proposal
        else:
            legacy = (
                Proposal.objects
                .select_related("specification_sheet")
                .filter(
                    specification_sheet_id=sheet_id,
                    customer_id__in=owner_ids,
                )
                .first()
            )
            if legacy is not None and legacy.specification_sheet is not None:
                sheet = legacy.specification_sheet
                proposal = legacy
        if sheet is None:
            shared = (
                SpecificationSheet.objects
                .select_related("formulation_version__formulation")
                .filter(
                    id=sheet_id,
                    formulation_version__formulation_id__in=(
                        Proposal.objects
                        .filter(customer_id__in=owner_ids)
                        .values("formulation_version__formulation_id")
                    ),
                )
                .first()
            )
            if shared is not None:
                sheet = shared
                proposal = (
                    Proposal.objects
                    .filter(
                        customer_id__in=owner_ids,
                        formulation_version__formulation_id=shared.formulation_version.formulation_id,
                    )
                    .order_by("-updated_at")
                    .first()
                )

        if sheet is None:
            raise NotFound("Specification not found.")

        signer_name, signer_email, signer_company = _client_signer_fields(request)
        signature_image = (request.data or {}).get("signature_image") or ""

        try:
            updated = accept_as_customer(
                sheet=sheet,
                signer_name=signer_name,
                signer_email=signer_email,
                signer_company=signer_company,
                signature_image=signature_image,
            )
        except InvalidStatusTransition:
            return _err("invalid_status_transition", status.HTTP_400_BAD_REQUEST)
        except (SignatureRequired, SignatureImageInvalid):
            return _err("signature_required", status.HTTP_400_BAD_REQUEST)

        # Capture the ESIGN audit trio so the signature is defensible
        # (same shape as the proposal-bundled path).
        updated.customer_sign_ip = _client_ip(request)[:45]
        updated.customer_sign_user_agent = _user_agent(request)
        updated.save(
            update_fields=[
                "customer_sign_ip",
                "customer_sign_user_agent",
            ]
        )

        if proposal is not None:
            record_portal_event(
                organization=proposal.organization,
                proposal=proposal,
                client_account=request.user,
                kind=PortalEvent.Kind.SPEC_SIGNED,
                metadata={"spec_id": str(updated.id)},
                request=request,
            )

        return Response(
            {
                "id": str(updated.id),
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
        )


@method_decorator(xframe_options_sameorigin, name="dispatch")
class SpecPdfView(PortalAPIView):
    """``GET /api/portal/specs/<sheet_id>/pdf/``.

    Renders the spec sheet as HTML for the in-portal preview
    iframe. Mirrors :class:`apps.client_portal.api.views
    .ProposalPdfView` — same three-pass ownership walk as
    :class:`SpecDetailView` (line / legacy 1-to-1 / shared
    formulation version), same ``xframe_options_sameorigin``
    decorator so the same-origin iframe embed on the web-site
    portal actually paints.

    Kept as HTML (not PDF bytes) so the FE gets an iframe-friendly
    document and the customer's download button can hit the
    dedicated PDF endpoint separately.
    """

    def get(self, request: Request, sheet_id: str) -> HttpResponse:
        from apps.proposals.models import Proposal, ProposalLine
        from apps.specifications.models import SpecificationSheet
        from apps.specifications.services import render_html as spec_render_html

        # Three-pass ownership lookup — same shape as SpecDetailView.
        # Kept inline (rather than extracted) because SpecDetailView
        # returns a Response + records a PortalEvent side-effect;
        # deduplicating without dragging the whole method surface
        # into a helper isn't worth the churn right now.
        owner_ids = customer_ids_for_account(request.user)
        sheet: SpecificationSheet | None = None

        line = (
            ProposalLine.objects.select_related(
                "proposal", "specification_sheet"
            )
            .filter(
                specification_sheet_id=sheet_id,
                proposal__customer_id__in=owner_ids,
            )
            .order_by("-proposal__updated_at")
            .first()
        )
        if line is not None:
            sheet = line.specification_sheet
        if sheet is None:
            legacy = (
                Proposal.objects.select_related("specification_sheet")
                .filter(
                    specification_sheet_id=sheet_id,
                    customer_id__in=owner_ids,
                )
                .first()
            )
            if legacy is not None and legacy.specification_sheet is not None:
                sheet = legacy.specification_sheet
        if sheet is None:
            shared_version_sheet = (
                SpecificationSheet.objects.select_related(
                    "formulation_version__formulation"
                )
                .filter(
                    id=sheet_id,
                    formulation_version__formulation_id__in=(
                        Proposal.objects.filter(
                            customer_id__in=owner_ids
                        ).values("formulation_version__formulation_id")
                    ),
                )
                .first()
            )
            if shared_version_sheet is not None:
                sheet = shared_version_sheet
        if sheet is None:
            raise NotFound("Specification not found.")

        return HttpResponse(spec_render_html(sheet))
