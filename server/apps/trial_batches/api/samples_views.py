"""R&D Samples fulfilment queue.

``GET /api/organizations/<org>/samples/pending/`` — list every
approved sample :class:`apps.payments.models.Payment` that hasn't
been turned into a :class:`apps.trial_batches.models.TrialBatch`
yet. Powers the new ``/samples`` page under the R&D nav group.

A "sample Payment" is any Payment with ``kind == FINAL`` against
a ``project_type = ready_to_go`` Formulation — that combination
is uniquely produced by the storefront's
:func:`apps.client_portal.checkout_services._create_sample_payment`,
so no explicit source flag is required to distinguish it from a
custom-project final payment.

Ownership is enforced by the module-gate permission (Formulations
edit) and the ``organization`` filter — a caller can never see
samples across tenants regardless of what url params they send.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.trial_batches.models import TrialBatch


class PendingSamplePaymentsView(APIView):
    """``GET /api/organizations/<org>/samples/pending/``.

    Returns every approved sample Payment the caller's org owns
    that isn't yet linked to a TrialBatch via ``source_payment``.
    Newest-first so a scientist opening the queue sees today's
    requests at the top.

    Response shape::

        {
          "items": [
            {
              "payment": {
                "id": "<uuid>",
                "amount": "250.00",
                "currency": "GBP",
                "paid_at": "2026-08-11T09:12:00Z",
                "approved_at": "2026-08-11T10:00:00Z",
                "reference": "…",
                "notes": "…"
              },
              "customer": {
                "id": "<uuid>",
                "company": "…",
                "name": "…",
                "email": "…"
              },
              "formulation": {
                "id": "<uuid>",
                "code": "RTG00001",
                "name": "…",
                "display_name": "Ultimate Fat Burner Drink",
                "approved_version_id": "<uuid>",
                "combos": [ {id, name, price_delta}, … ]
              }
            },
            …
          ]
        }
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str) -> Response:
        # Payments already-fulfilled by a TrialBatch land in the
        # ``fulfilled_by_trial_batches`` reverse — one query drops
        # them from the queue below. Deleting the batch (SET_NULL)
        # would re-surface the payment for another try, which is
        # the correct fallback for accidental deletes.
        fulfilled_ids = TrialBatch.objects.filter(
            organization_id=org_id,
            source_payment__isnull=False,
        ).values_list("source_payment_id", flat=True)

        qs = (
            Payment.objects.filter(
                organization_id=org_id,
                kind=PaymentKind.FINAL,
                status=PaymentStatus.APPROVED,
                formulation__project_type="ready_to_go",
            )
            .exclude(id__in=fulfilled_ids)
            .select_related("customer", "formulation")
            .order_by("-approved_at", "-paid_at")
        )

        items: list[dict[str, Any]] = []
        for payment in qs:
            items.append(_serialise(payment))

        return Response({"items": items}, status=status.HTTP_200_OK)


def _serialise(payment: Payment) -> dict[str, Any]:
    """Compose a card-ready payload for one pending sample.

    Bundles the customer + formulation + combo picker source in a
    single row so the FE modal doesn't need a second round-trip
    when the scientist clicks Create trial batch.
    """

    customer = getattr(payment, "customer", None)
    formulation = getattr(payment, "formulation", None)
    approved_version_id = _approved_version_id(formulation)
    combos = _combos_for(formulation)

    return {
        "payment": {
            "id": str(payment.id),
            "amount": _decimal_str(payment.amount),
            "currency": payment.currency or "GBP",
            "paid_at": _iso(payment.paid_at),
            "approved_at": _iso(payment.approved_at),
            "reference": payment.external_reference or "",
            "notes": payment.notes or "",
        },
        "customer": (
            {
                "id": str(customer.id),
                "company": customer.company or "",
                "name": customer.name or "",
                "email": customer.email or "",
            }
            if customer is not None
            else None
        ),
        "formulation": (
            {
                "id": str(formulation.id),
                "code": formulation.code or "",
                "name": formulation.name or "",
                "display_name": _display_name(formulation),
                "approved_version_id": (
                    str(approved_version_id) if approved_version_id else None
                ),
                "combos": combos,
            }
            if formulation is not None
            else None
        ),
    }


def _approved_version_id(formulation: Any) -> Any:
    """Latest version id for the sample batch to bind against.

    Prefers the ``approved_version_number`` (director-signed) so
    the sample runs against the same recipe the storefront quoted.
    Falls back to the newest version if approved is missing —
    matches the resolver in :mod:`apps.client_portal
    .checkout_services._resolve_version` so an unmarked-approved
    RTG still doesn't stall the queue.
    """

    if formulation is None:
        return None
    approved_number = getattr(formulation, "approved_version_number", None)
    versions = formulation.versions.all() if hasattr(formulation, "versions") else []
    if approved_number is not None:
        match = next(
            (v for v in versions if v.version_number == approved_number), None
        )
        if match is not None:
            return match.id
    latest = max(versions, key=lambda v: v.version_number, default=None)
    return latest.id if latest is not None else None


def _combos_for(formulation: Any) -> list[dict[str, Any]]:
    """The formulation's packaging combos, ready for the FE picker."""

    if formulation is None:
        return []
    combos = getattr(formulation, "packaging_combos", None)
    if combos is None:
        return []
    return [
        {
            "id": str(combo.id),
            "name": combo.name or "",
            "price_delta": _decimal_str(combo.price_delta),
            "is_default": bool(combo.is_default),
        }
        for combo in combos.order_by("sort_order", "name")
    ]


def _display_name(formulation: Any) -> str:
    """Storefront-facing name — same rule as the activity feed."""

    if formulation is None:
        return ""
    if (
        getattr(formulation, "project_type", "") == "ready_to_go"
        and (getattr(formulation, "rtg_display_name", "") or "").strip()
    ):
        return formulation.rtg_display_name.strip()
    return getattr(formulation, "name", "") or ""


def _decimal_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(Decimal(value))
    except Exception:  # noqa: BLE001
        return None


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt is not None else None


__all__ = ["PendingSamplePaymentsView"]
