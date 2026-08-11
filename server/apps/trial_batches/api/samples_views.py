"""R&D Samples fulfilment queue.

``GET /api/organizations/<org>/samples/pending/`` — bucketed
sample-payment feed. Powers the ``/samples`` page under the R&D
nav group.

Buckets mirror the payments + proposals pipeline pattern:

* ``new``          — approved sample Payment, no TrialBatch yet.
                     Every card here is a scientist's to-do.
* ``in_progress``  — TrialBatch exists (source_payment=this
                     payment) but the linked PSP MO chain hasn't
                     reported ``psp_all_stages_completed=True``.
* ``finished``     — TrialBatch's PSP chain is complete. The
                     kit has been produced (shipping is off-
                     platform, so this is the last automated
                     signal we have).

A "sample Payment" is any Payment with ``kind == FINAL`` against
a ``project_type = ready_to_go`` Formulation — the combo the
storefront's :func:`apps.client_portal.checkout_services
._create_sample_payment` produces. No explicit source flag needed
to distinguish it from a Custom-project final payment.

Query params:

* ``bucket`` — ``new|in_progress|finished`` (required).
* ``cursor`` — opaque base64 payload of ``{ts, id}``. First page
  omits it; subsequent pages hand back the previous response's
  ``next_cursor`` verbatim.
* ``limit``  — page size, default 20, max 100.
* ``q``      — free-text search (customer + formulation + email +
  reference). Optional.

Response::

    {
      "items": [
        {"payment": {...}, "customer": {...}, "formulation": {...},
         "trial_batch": {...} | null},
        ...
      ],
      "next_cursor": "<base64>" | null,
      "counts": {"new": 3, "in_progress": 1, "finished": 42}
    }

Pagination is keyset on ``(approved_at, id)`` so page cost stays
``O(log N + limit)`` — a customer with 10k finished samples pages
just as fast on row 9,999 as on row 20.

Ownership is enforced by the module-gate permission (Formulations
edit) and the ``organization`` filter — a caller can never see
samples across tenants regardless of what url params they send.
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any

from django.db.models import Exists, OuterRef, Q, QuerySet
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.trial_batches.models import TrialBatch


DEFAULT_LIMIT = 20
MAX_LIMIT = 100
VALID_BUCKETS = ("new", "in_progress", "finished")


class PendingSamplePaymentsView(APIView):
    """See module docstring."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str) -> Response:
        bucket = _normalize_bucket(request.query_params.get("bucket"))
        search = (request.query_params.get("q") or "").strip()
        limit = _parse_limit(request)
        cursor = _decode_cursor(request.query_params.get("cursor"))

        base = _base_queryset(org_id, search)

        # Cheap counts across all three buckets so the FE can render
        # tab badges without three separate round-trips. Each is an
        # index-only EXISTS scan; no row hydration.
        counts = _bucket_counts(org_id, search)

        bucket_qs = _apply_bucket(base, bucket)

        # Over-fetch by one so we know whether there's more without
        # a second COUNT. Cursor filter applies AFTER bucket filter
        # so the keyset stays in step with the ORDER BY below.
        rows = list(
            bucket_qs.filter(_cursor_filter(cursor))
            .order_by("-approved_at", "-id")[: limit + 1]
        )
        has_more = len(rows) > limit
        page = rows[:limit]
        next_cursor: str | None = None
        if has_more and page:
            last = page[-1]
            next_cursor = _encode_cursor(last.approved_at, str(last.id))

        # ``trial_batch`` on each item so the FE cards on the
        # In-progress + Finished columns can link to the batch
        # detail page without a second lookup. One extra query
        # per page rather than N+1 because we prefetch the
        # source-payment fan-in.
        batches_by_payment: dict[str, TrialBatch] = {}
        payment_ids = [row.id for row in page]
        if payment_ids:
            for batch in (
                TrialBatch.objects.filter(
                    organization_id=org_id, source_payment_id__in=payment_ids
                )
                .order_by("-updated_at")
            ):
                # If more than one batch ever pointed at the same
                # payment (shouldn't happen given the FK is
                # scientist-authored) the latest wins — the queue
                # cares about "the current attempt", not history.
                key = str(batch.source_payment_id)
                batches_by_payment.setdefault(key, batch)

        items = [_serialise(payment, batches_by_payment.get(str(payment.id))) for payment in page]

        return Response(
            {
                "items": items,
                "next_cursor": next_cursor,
                "counts": counts,
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Query composition
# ---------------------------------------------------------------------------


def _base_queryset(org_id: str, search: str) -> QuerySet:
    """Every approved sample Payment for the org, plus search filter."""

    qs = Payment.objects.filter(
        organization_id=org_id,
        kind=PaymentKind.FINAL,
        status=PaymentStatus.APPROVED,
        formulation__project_type="ready_to_go",
    ).select_related("customer", "formulation")
    if search:
        qs = qs.filter(
            Q(external_reference__icontains=search)
            | Q(notes__icontains=search)
            | Q(customer__company__icontains=search)
            | Q(customer__name__icontains=search)
            | Q(customer__email__icontains=search)
            | Q(formulation__code__icontains=search)
            | Q(formulation__name__icontains=search)
            | Q(formulation__rtg_display_name__icontains=search)
        )
    return qs


def _apply_bucket(qs: QuerySet, bucket: str) -> QuerySet:
    """Filter the base queryset down to one bucket.

    Uses ``EXISTS`` subqueries rather than joins to keep the row
    count 1:1 with Payment even when a payment somehow has more
    than one linked batch (guardrail — the FK is single-writer).
    """

    incomplete_batch = TrialBatch.objects.filter(
        source_payment_id=OuterRef("pk"),
        psp_all_stages_completed=False,
    )
    complete_batch = TrialBatch.objects.filter(
        source_payment_id=OuterRef("pk"),
        psp_all_stages_completed=True,
    )
    any_batch = TrialBatch.objects.filter(source_payment_id=OuterRef("pk"))

    if bucket == "new":
        # NOT EXISTS any batch → this payment has never been
        # touched by a scientist.
        return qs.annotate(has_any=Exists(any_batch)).filter(has_any=False)
    if bucket == "finished":
        # EXISTS a completed batch. A payment with BOTH an
        # incomplete and a completed batch (edge case: someone
        # created a second batch after the first finished) counts
        # as finished — the customer got their kit either way.
        return qs.annotate(has_done=Exists(complete_batch)).filter(has_done=True)
    # ``in_progress``: at least one incomplete batch AND no
    # completed batch (the completed branch above catches
    # payments with a done batch even if an incomplete one also
    # exists, so this is the strict "still-cooking" bucket).
    return (
        qs.annotate(
            has_wip=Exists(incomplete_batch),
            has_done=Exists(complete_batch),
        )
        .filter(has_wip=True, has_done=False)
    )


def _bucket_counts(org_id: str, search: str) -> dict[str, int]:
    """Three cheap COUNT queries for the tab badges."""

    base = _base_queryset(org_id, search)
    return {
        "new": _apply_bucket(base, "new").count(),
        "in_progress": _apply_bucket(base, "in_progress").count(),
        "finished": _apply_bucket(base, "finished").count(),
    }


# ---------------------------------------------------------------------------
# Cursor encoding
# ---------------------------------------------------------------------------


def _encode_cursor(approved_at: Any, item_id: str) -> str:
    """Opaque base64 payload — clients hand it back verbatim."""

    payload = json.dumps(
        {"ts": approved_at.isoformat() if approved_at is not None else None, "id": item_id},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(raw: str | None) -> tuple[Any, str] | None:
    """Return ``(datetime, id)`` or ``None`` for malformed / missing.

    Malformed cursor silently degrades to "start from page 1" —
    a stale link should still load something usable.
    """

    if not raw:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
    except Exception:  # noqa: BLE001
        return None
    ts_raw = payload.get("ts")
    id_raw = payload.get("id")
    if not id_raw:
        return None
    ts = parse_datetime(ts_raw) if ts_raw else None
    return ts, str(id_raw)


def _cursor_filter(cursor: tuple[Any, str] | None) -> Q:
    """Keyset comparison ``(approved_at, id) < (cursor_ts, cursor_id)``
    under ``ORDER BY -approved_at, -id``. Null ``approved_at`` on
    the cursor collapses to id-only comparison — happens on legacy
    rows imported before approval bookkeeping landed."""

    if cursor is None:
        return Q()
    ts, item_id = cursor
    if ts is None:
        return Q(id__lt=item_id)
    return Q(approved_at__lt=ts) | Q(approved_at=ts, id__lt=item_id)


# ---------------------------------------------------------------------------
# Paging helpers
# ---------------------------------------------------------------------------


def _normalize_bucket(raw: str | None) -> str:
    value = (raw or "new").lower().strip()
    return value if value in VALID_BUCKETS else "new"


def _parse_limit(request: Request) -> int:
    try:
        value = int(request.query_params.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        value = DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, value))


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def _serialise(payment: Payment, batch: TrialBatch | None) -> dict[str, Any]:
    """Compose a card-ready payload for one sample row.

    Bundles the customer + formulation + combos + linked-batch
    reference in a single row so the FE doesn't need a second
    round-trip when the scientist clicks Create trial batch OR
    Open batch. The combos list is only meaningful on the ``new``
    bucket (the picker seeds from it); we always include it so
    an in-progress row could show which combo was used.
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
        "trial_batch": (
            {
                "id": str(batch.id),
                "label": batch.label or "",
                "batch_size_units": batch.batch_size_units,
                "psp_all_stages_completed": bool(batch.psp_all_stages_completed),
                "packaging_combo_id": (
                    str(batch.packaging_combo_id) if batch.packaging_combo_id else None
                ),
                "created_at": _iso(batch.created_at),
                "updated_at": _iso(batch.updated_at),
                "formulation_id": (
                    str(batch.formulation_version.formulation_id)
                    if batch.formulation_version_id
                    else None
                ),
            }
            if batch is not None
            else None
        ),
    }


def _approved_version_id(formulation: Any) -> Any:
    """Latest version id for the sample batch to bind against.

    Prefers ``approved_version_number`` (director-signed) so the
    sample runs against the same recipe the storefront quoted.
    Falls back to the newest version if approved is missing —
    matches :func:`apps.client_portal.checkout_services
    ._resolve_version`.
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
