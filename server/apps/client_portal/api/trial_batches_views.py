"""Portal endpoints for the trial-batch cycle.

Sits between "deposit paid" and "final spec signed" in the pipeline.
Four operations:

* ``GET  /api/portal/projects/<formulation_id>/trial-batches/`` —
  cycle + slots snapshot for the portal card.
* ``POST /api/portal/trial-batches/slots/<slot_id>/confirm-delivery/``
  — customer confirms receipt of a shipped sample.
* ``POST /api/portal/trial-batches/slots/<slot_id>/feedback/`` —
  customer records their verdict on a delivered slot
  (satisfied / needs_iteration + free-text notes + the
  ``keep_producing_remaining`` opt-in when satisfied).
* ``POST /api/portal/projects/<formulation_id>/trial-batches/
  request-more/`` — customer requests additional samples on top of
  what they originally paid for. Spawns an
  :class:`AdditionalSampleRequest` + a pending Payment on the
  finance queue.

Ownership resolution matches the rest of the portal — the caller
must own the formulation via
:func:`apps.client_portal.queries.customer_owns_formulation`. Slot
endpoints double-check the slot's cycle points at an owned
formulation so a leaked slot uuid can't be poked from another
tenant.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import (
    customer_ids_for_account,
    customer_owns_formulation,
)
from apps.formulations.models import Formulation
from apps.trial_batches.cycle_services import (
    InvalidAdditionalSampleQuantity,
    SlotNotActive,
    mark_slot_delivered,
    record_slot_verdict,
    request_additional_samples,
)
from apps.trial_batches.models import (
    AdditionalSampleRequest,
    TrialBatchCycle,
    TrialBatchSlot,
    TrialBatchSlotStatus,
    TrialBatchSlotVerdict,
)


def _serialise_slot(
    slot: TrialBatchSlot,
    production: dict | None = None,
) -> dict[str, Any]:
    """Portal-side snapshot of a single slot.

    ``production`` is an optional pre-fetched summary derived from
    the slot's linked PSP MO chain — shape ``{state, total, done}``
    where ``state`` is ``"not_pushed" | "in_progress" | "completed"``.
    Mirrors what the storefront sample-detail view exposes so the
    portal card can gate the "I've received it" button on production
    actually being finished (not just the slot being ``in_production``,
    which fires the moment the batch links).
    """

    production = production or {"state": "unknown", "total": 0, "done": 0}
    return {
        "id": str(slot.id),
        "sequence_no": slot.sequence_no,
        "status": slot.status,
        "verdict": slot.verdict,
        "verdict_at": (
            slot.verdict_at.isoformat() if slot.verdict_at is not None else None
        ),
        "keep_producing_remaining": slot.keep_producing_remaining,
        "feedback_summary": slot.feedback_summary,
        "trial_batch_id": (
            str(slot.trial_batch_id) if slot.trial_batch_id is not None else None
        ),
        "formulation_version_id": str(slot.formulation_version_id),
        "production_state": production.get("state", "unknown"),
        "production_stages_total": production.get("total", 0),
        "production_stages_done": production.get("done", 0),
        "created_at": slot.created_at.isoformat(),
        "updated_at": slot.updated_at.isoformat(),
    }


def _fetch_production_summary(
    slot: TrialBatchSlot, organization: Any
) -> dict[str, Any]:
    """Fetch the slot's PSP MO chain and reduce it to a per-slot
    production summary. Silent-degrade — any PSP hiccup (unreachable,
    unknown mo uuid, integration off) returns ``"unknown"`` so the FE
    keeps rendering the batch-link status rather than blanking.

    Returns ``{"state": ..., "total": N, "done": M}`` where ``state``
    is:
      * ``"not_pushed"`` — batch exists but scientist hasn't clicked
        Create MO on PSP yet.
      * ``"in_progress"`` — one or more stages still non-terminal.
      * ``"completed"`` — every stage in the chain reports
        ``status = completed``. The physical sample is produced;
        scientist can ship + customer can confirm receipt.
      * ``"unknown"`` — PSP fetch failed / integration off.
    """

    from apps.psp.services import get_psp_manufacturing_order_chain
    from apps.trial_batches.models import TrialBatch

    if slot.trial_batch_id is None:
        return {"state": "not_pushed", "total": 0, "done": 0}
    tb = TrialBatch.objects.only("psp_manufacturing_order_uuid").filter(
        id=slot.trial_batch_id
    ).first()
    mo_uuid = getattr(tb, "psp_manufacturing_order_uuid", None) if tb else None
    if not mo_uuid:
        return {"state": "not_pushed", "total": 0, "done": 0}
    try:
        chain_response = get_psp_manufacturing_order_chain(
            organization=organization, mo_uuid=mo_uuid
        )
    except Exception:  # noqa: BLE001 — silent-degrade, same posture as sample-detail
        return {"state": "unknown", "total": 0, "done": 0}
    chain = (chain_response or {}).get("chain") or []
    if not chain:
        return {"state": "unknown", "total": 0, "done": 0}
    total = len(chain)
    done = sum(1 for row in chain if row.get("status") == "completed")
    if done == total:
        state = "completed"
    else:
        state = "in_progress"
    return {"state": state, "total": total, "done": done}


def _serialise_additional_request(
    request_row: AdditionalSampleRequest,
) -> dict[str, Any]:
    return {
        "id": str(request_row.id),
        "requested_quantity": request_row.requested_quantity,
        "unit_price_snapshot": str(request_row.unit_price_snapshot),
        "currency_code": request_row.currency_code,
        "total_amount_snapshot": str(request_row.total_amount_snapshot),
        "status": request_row.status,
        "payment_id": (
            str(request_row.payment_id)
            if request_row.payment_id is not None
            else None
        ),
        "created_at": request_row.created_at.isoformat(),
        "approved_at": (
            request_row.approved_at.isoformat()
            if request_row.approved_at is not None
            else None
        ),
    }


def _serialise_cycle(cycle: TrialBatchCycle) -> dict[str, Any]:
    slots = list(cycle.slots.order_by("sequence_no"))
    active = next(
        (
            s
            for s in slots
            if s.status
            not in (
                TrialBatchSlotStatus.CLOSED_ITERATED,
                TrialBatchSlotStatus.CLOSED_SATISFIED,
                TrialBatchSlotStatus.CLOSED_CANCELLED,
            )
        ),
        None,
    )
    # Fetch PSP MO chain only for the ACTIVE slot — one HTTP round-trip
    # per portal render is fine; hitting PSP for every closed historical
    # slot would balloon the request without adding info the customer
    # can act on.
    production_by_slot: dict[str, dict[str, Any]] = {}
    if active is not None and active.status in (
        TrialBatchSlotStatus.IN_PRODUCTION,
        TrialBatchSlotStatus.SHIPPED,
        TrialBatchSlotStatus.DELIVERED,
        TrialBatchSlotStatus.FEEDBACK_PENDING,
    ):
        production_by_slot[str(active.id)] = _fetch_production_summary(
            active, cycle.organization
        )
    return {
        "id": str(cycle.id),
        "status": cycle.status,
        "total_slots": cycle.total_slots,
        "slots_used": len(slots),
        "closed_at": (
            cycle.closed_at.isoformat() if cycle.closed_at is not None else None
        ),
        "slots": [
            _serialise_slot(s, production_by_slot.get(str(s.id))) for s in slots
        ],
        "active_slot_id": str(active.id) if active is not None else None,
        "additional_requests": [
            _serialise_additional_request(r)
            for r in cycle.additional_sample_requests.order_by("-created_at")
        ],
    }


def _load_owned_formulation(
    request: Request, formulation_id: Any
) -> Formulation:
    owner_ids = customer_ids_for_account(request.user)
    if not customer_owns_formulation(
        customer_ids=owner_ids, formulation_id=formulation_id
    ):
        raise NotFound()
    formulation = Formulation.objects.filter(id=formulation_id).first()
    if formulation is None:
        raise NotFound()
    return formulation


def _load_owned_slot(request: Request, slot_id: Any) -> TrialBatchSlot:
    slot = (
        TrialBatchSlot.objects.select_related("cycle__formulation")
        .filter(id=slot_id)
        .first()
    )
    if slot is None:
        raise NotFound()
    owner_ids = customer_ids_for_account(request.user)
    if not customer_owns_formulation(
        customer_ids=owner_ids,
        formulation_id=slot.cycle.formulation_id,
    ):
        raise NotFound()
    return slot


class PortalTrialBatchCycleView(PortalAPIView):
    """``GET /api/portal/projects/<formulation_id>/trial-batches/``.

    Returns the cycle snapshot for the portal card. 404s cleanly
    when no cycle exists yet (deposit not approved) or the caller
    doesn't own the formulation.
    """

    def get(self, request: Request, formulation_id) -> Response:
        formulation = _load_owned_formulation(request, formulation_id)
        cycle = TrialBatchCycle.objects.filter(formulation=formulation).first()
        if cycle is None:
            raise NotFound()
        return Response({"cycle": _serialise_cycle(cycle)})


class PortalTrialBatchSlotConfirmDeliveryView(PortalAPIView):
    """``POST /api/portal/trial-batches/slots/<slot_id>/confirm-delivery/``.

    Customer confirms they received the sample. Flips the slot to
    ``DELIVERED``, which unlocks the feedback card on the portal
    surface. 409 when the slot has no batch in flight yet.
    """

    def post(self, request: Request, slot_id) -> Response:
        slot = _load_owned_slot(request, slot_id)
        try:
            mark_slot_delivered(slot=slot)
        except SlotNotActive as exc:
            return Response(
                {"code": "slot_not_active", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )
        return Response({"slot": _serialise_slot(slot)})


class PortalTrialBatchSlotFeedbackView(PortalAPIView):
    """``POST /api/portal/trial-batches/slots/<slot_id>/feedback/``.

    Records the customer's verdict on a delivered slot. Body:

    * ``verdict`` — ``"satisfied"`` or ``"needs_iteration"``
    * ``feedback_summary`` — free-text notes (optional but
      strongly encouraged for iterate)
    * ``keep_producing_remaining`` — only meaningful when verdict is
      ``satisfied``; opts into the "keep sending the remaining
      samples I paid for" branch.
    """

    def post(self, request: Request, slot_id) -> Response:
        slot = _load_owned_slot(request, slot_id)
        raw = request.data if isinstance(request.data, dict) else {}
        verdict = str(raw.get("verdict") or "").strip()
        if verdict not in (
            TrialBatchSlotVerdict.SATISFIED,
            TrialBatchSlotVerdict.NEEDS_ITERATION,
        ):
            return Response(
                {"code": "invalid_verdict", "detail": "verdict required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        feedback = str(raw.get("feedback_summary") or "").strip()
        keep_remaining = bool(raw.get("keep_producing_remaining"))
        try:
            record_slot_verdict(
                slot=slot,
                verdict=verdict,
                feedback_summary=feedback,
                keep_producing_remaining=keep_remaining,
                actor=request.user,
            )
        except SlotNotActive as exc:
            return Response(
                {"code": "slot_not_active", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )
        slot.refresh_from_db()
        cycle_after = TrialBatchCycle.objects.get(pk=slot.cycle_id)
        return Response(
            {
                "slot": _serialise_slot(slot),
                "cycle": _serialise_cycle(cycle_after),
            }
        )


class PortalTrialBatchAdditionalRequestView(PortalAPIView):
    """``POST /api/portal/projects/<formulation_id>/trial-batches/request-more/``.

    Customer asks for N more samples on top of what they originally
    paid for. Creates a pending Payment on the finance queue at spot
    price (matching the design decision). On finance approval the
    cycle's ``total_slots`` bumps and fresh slots are appended.
    """

    def post(self, request: Request, formulation_id) -> Response:
        formulation = _load_owned_formulation(request, formulation_id)
        cycle = TrialBatchCycle.objects.filter(formulation=formulation).first()
        if cycle is None:
            raise NotFound()

        raw = request.data if isinstance(request.data, dict) else {}
        try:
            quantity = int(raw.get("quantity") or 0)
        except (TypeError, ValueError):
            return Response(
                {"code": "invalid_quantity"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            new_request = request_additional_samples(
                cycle=cycle, quantity=quantity, actor=request.user,
            )
        except InvalidAdditionalSampleQuantity as exc:
            return Response(
                {"code": "invalid_quantity", "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {"request": _serialise_additional_request(new_request)},
            status=status.HTTP_201_CREATED,
        )
