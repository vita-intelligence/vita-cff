"""Scientist-facing FINAL-spec pipeline endpoint.

Powers the ``/final-specs/`` kanban page — a project-agnostic view
of every FINAL specification in the org, bucketed by lifecycle
stage so the team can answer "what's waiting on us / on the
customer / on finance / already closed?" without walking each
project.

The endpoint returns three columns in a single response so the FE
doesn't need to fire three separate paginated queries — the FINAL
population is small (one per project, capped by BE enforcement) so
serving the whole list is fine. If the numbers ever grow to
thousands, cutting over to a paginated-per-stage shape (like
:class:`TrialBatchCyclePipelineColumnView`) is a mechanical change.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import Formulation, ProjectType
from apps.organizations.modules import FormulationsCapability
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)
from apps.trial_batches.models import TrialBatchCycle


def _serialise_sheet(
    sheet: SpecificationSheet, payment_by_formulation: dict
) -> dict[str, Any]:
    """Compact card shape for the FINAL-specs kanban.

    Keeps the wire lean — enough for the scientist to answer "who /
    what recipe / which stage" at a glance without hitting the
    detail endpoint. Deep info (delta, render context, audit trail)
    lives on ``/specifications/<id>``.
    """

    formulation = sheet.formulation_version.formulation
    customer = getattr(formulation, "customer", None)
    payment = payment_by_formulation.get(formulation.id)
    return {
        "card_kind": "sheet",
        "id": str(sheet.id),
        "code": sheet.code or "",
        "status": sheet.status,
        "formulation": {
            "id": str(formulation.id),
            "code": (getattr(formulation, "code", "") or "").strip(),
            "name": (getattr(formulation, "name", "") or "").strip(),
        },
        "customer": (
            {
                "id": str(customer.id),
                "name": (getattr(customer, "name", "") or "").strip(),
            }
            if customer is not None
            else None
        ),
        # Commercial fields — the invoice math is derived from these
        # (see ``compute_final_spec_delta``). Serialised as strings so
        # the wire matches the Decimal shape everywhere else.
        "final_price": (
            str(sheet.final_price) if sheet.final_price is not None else None
        ),
        "quantity": sheet.quantity,
        "currency": sheet.currency or "GBP",
        # Lifecycle timestamps — the scientist reads these to work
        # out "how long has this been sitting on the customer's
        # side?" without opening the detail page.
        "sent_at": sheet.sent_at.isoformat() if sheet.sent_at is not None else None,
        "customer_signed_at": (
            sheet.customer_signed_at.isoformat()
            if sheet.customer_signed_at is not None
            else None
        ),
        "customer_rejected_at": (
            sheet.customer_rejected_at.isoformat()
            if sheet.customer_rejected_at is not None
            else None
        ),
        "customer_rejection_reason": sheet.customer_rejection_reason or "",
        "updated_at": sheet.updated_at.isoformat(),
        # Payment linkage — the FINAL payment auto-created on
        # signature. Powers the "awaiting payment approval" vs.
        # "paid" split inside the in_flight / closed columns.
        "final_payment": (
            {
                "id": str(payment.id),
                "status": payment.status,
                "amount": str(payment.amount) if payment.amount is not None else None,
                "currency": payment.currency or "GBP",
            }
            if payment is not None
            else None
        ),
    }


def _bucket_sheet(sheet: SpecificationSheet) -> str:
    """Which kanban column does this FINAL spec belong to?

    * ``in_flight`` — status=``approved`` (waiting on us to Send)
      OR status=``sent`` (waiting on the customer to sign).
      "Final spec exists but the customer hasn't given a decision"
      is one column: the scientist can tell whose turn it is from
      the status pill on the card.
    * ``closed_signed`` — status=``accepted`` (customer signed).
      Payment sub-state (pending / approved) surfaces on the card
      but doesn't change the column.
    * ``closed_rejected`` — status=``rejected`` (customer sent us
      back to trial batches).

    ``needs_click`` cards come from a separate query — projects
    where the customer confirmed trial-batches done but no FINAL
    sheet exists yet. See :func:`_awaiting_final_projects`.

    ``draft`` / ``in_review`` sheets don't show on this page — those
    are the scientist's private workspace and belong on the per-
    project spec-sheets tab.
    """

    if sheet.status in (
        SpecificationStatus.APPROVED.value,
        SpecificationStatus.SENT.value,
    ):
        return "in_flight"
    if sheet.status == SpecificationStatus.ACCEPTED.value:
        return "closed_signed"
    if sheet.status == SpecificationStatus.REJECTED.value:
        return "closed_rejected"
    return "hidden"


def _awaiting_final_projects(
    org_id: str, sheets_by_formulation: dict
) -> list[dict[str, Any]]:
    """Projects where the customer confirmed trial-batches done but
    no FINAL SpecificationSheet exists on the formulation yet. These
    are the scientist's "you owe the customer a FINAL" queue — the
    "Needs your click" column on the kanban.

    Includes formulations where the customer previously rejected a
    FINAL and the cycle has been re-satisfied (rejection is a
    project-restart signal; once the customer confirms done a
    second time they're waiting on a fresh FINAL against the new
    version).

    Filters:
    * Custom-formulation only (RTG projects don't go through this
      pipeline).
    * ``customer_confirmed_done_at IS NOT NULL`` on the cycle.
    * No FINAL sheet at ``approved`` / ``sent`` / ``accepted`` on
      the formulation. A ``rejected`` FINAL doesn't count — the
      customer already sent us back once, and if they've now
      re-confirmed done we owe them a fresh sheet.
    """

    cycles = (
        TrialBatchCycle.objects.filter(
            organization_id=org_id,
            customer_confirmed_done_at__isnull=False,
            formulation__project_type=ProjectType.CUSTOM.value,
        )
        .select_related("formulation", "formulation__customer")
    )
    out: list[dict[str, Any]] = []
    for cycle in cycles:
        formulation = cycle.formulation
        # Does an *active* FINAL sheet exist? (Ignore rejected —
        # rejection means "start again", so a rejected FINAL doesn't
        # cover the current confirmation.)
        active_final = any(
            s.status
            in (
                SpecificationStatus.APPROVED.value,
                SpecificationStatus.SENT.value,
                SpecificationStatus.ACCEPTED.value,
            )
            for s in sheets_by_formulation.get(formulation.id, [])
        )
        if active_final:
            continue
        customer = getattr(formulation, "customer", None)
        out.append(
            {
                "card_kind": "awaiting_final",
                "id": str(cycle.id),
                "formulation": {
                    "id": str(formulation.id),
                    "code": (getattr(formulation, "code", "") or "").strip(),
                    "name": (getattr(formulation, "name", "") or "").strip(),
                },
                "customer": (
                    {
                        "id": str(customer.id),
                        "name": (getattr(customer, "name", "") or "").strip(),
                    }
                    if customer is not None
                    else None
                ),
                "confirmed_done_at": cycle.customer_confirmed_done_at.isoformat(),
                "updated_at": cycle.updated_at.isoformat(),
            }
        )
    # Newest confirmations first so the freshest work sits at the top
    # of the column.
    out.sort(key=lambda c: c["confirmed_done_at"], reverse=True)
    return out


class FinalSpecsPipelineView(APIView):
    """``GET /api/organizations/<org>/final-specs/pipeline/``.

    Returns the FINAL-spec kanban as ``{needs_click: [...],
    in_flight: [...], closed: [...]}`` in a single response. The FE
    renders three fixed columns; ordering inside each column is
    newest-first by ``updated_at`` so the freshest work sits at the
    top.

    Auth: same ``formulations.edit`` gate as ``/trial-batches/`` —
    every action reachable from this page (Send, Regenerate, etc.)
    is a project-edit action.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str) -> Response:
        # Custom-formulation projects ONLY — Ready-to-Go (RTG) projects
        # skip trial batches entirely and their "final spec" is created
        # per-order at the storefront checkout, not through the
        # deposit → trials → final-spec pipeline this page tracks.
        sheets = list(
            SpecificationSheet.objects.filter(
                organization_id=org_id,
                document_kind=SpecificationDocumentKind.FINAL,
                formulation_version__formulation__project_type=(
                    ProjectType.CUSTOM.value
                ),
            )
            .exclude(
                status__in=(
                    SpecificationStatus.DRAFT.value,
                    SpecificationStatus.IN_REVIEW.value,
                )
            )
            .select_related(
                "formulation_version__formulation",
                "formulation_version__formulation__customer",
            )
            .order_by("-updated_at")
        )
        formulation_ids = {
            s.formulation_version.formulation_id for s in sheets
        }
        # Index sheets by formulation for the awaiting-final lookup.
        sheets_by_formulation: dict = {}
        for s in sheets:
            sheets_by_formulation.setdefault(
                s.formulation_version.formulation_id, []
            ).append(s)

        # One query for every FINAL payment on these formulations.
        payments = list(
            Payment.objects.filter(
                formulation_id__in=formulation_ids,
                kind=PaymentKind.FINAL,
            ).order_by("-created_at")
        )
        payment_by_formulation: dict = {}
        for p in payments:
            payment_by_formulation.setdefault(p.formulation_id, p)

        columns: dict[str, list] = {
            "needs_click": _awaiting_final_projects(
                org_id=org_id, sheets_by_formulation=sheets_by_formulation
            ),
            "in_flight": [],
            "closed_signed": [],
            "closed_rejected": [],
        }
        for sheet in sheets:
            bucket = _bucket_sheet(sheet)
            if bucket == "hidden":
                continue
            columns[bucket].append(
                _serialise_sheet(sheet, payment_by_formulation)
            )

        return Response(
            {
                "columns": columns,
                "counts": {k: len(v) for k, v in columns.items()},
            },
            status=status.HTTP_200_OK,
        )
