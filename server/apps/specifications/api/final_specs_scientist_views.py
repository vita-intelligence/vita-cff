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
from apps.organizations.modules import FormulationsCapability
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)


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


def _bucket_sheet(sheet: SpecificationSheet, payment_by_formulation: dict) -> str:
    """Which kanban column does this FINAL spec belong to?

    * ``needs_click`` — status=``approved``. Team has signed off
      internally; the scientist owes the customer a Send.
    * ``in_flight`` — status=``sent`` (customer's turn to sign) OR
      status=``accepted`` with no APPROVED FINAL payment yet
      (finance's turn).
    * ``closed`` — status=``accepted`` with APPROVED FINAL payment
      OR status=``rejected``.

    ``draft`` / ``in_review`` sheets don't show on this page — those
    are the scientist's private workspace and belong on the per-
    project spec-sheets tab. This kanban is about deals we're
    actively pushing customer-side.
    """

    if sheet.status == SpecificationStatus.APPROVED.value:
        return "needs_click"
    if sheet.status == SpecificationStatus.SENT.value:
        return "in_flight"
    if sheet.status == SpecificationStatus.ACCEPTED.value:
        payment = payment_by_formulation.get(sheet.formulation_version.formulation_id)
        if payment is not None and payment.status == PaymentStatus.APPROVED:
            return "closed"
        return "in_flight"
    if sheet.status == SpecificationStatus.REJECTED.value:
        return "closed"
    return "hidden"


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
        sheets = list(
            SpecificationSheet.objects.filter(
                organization_id=org_id,
                document_kind=SpecificationDocumentKind.FINAL,
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
        # One query for every FINAL payment on these formulations.
        # We want the most recent (usually only one exists — the BE
        # enforces one FINAL per project — but a REJECTED-then-
        # restart flow could produce a second Payment row when the
        # first Payment is voided, so we defensively pick newest).
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
            "needs_click": [],
            "in_flight": [],
            "closed": [],
        }
        for sheet in sheets:
            bucket = _bucket_sheet(sheet, payment_by_formulation)
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
