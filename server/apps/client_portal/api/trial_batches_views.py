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
from apps.client_portal.pipeline_copy import (
    PHASE_CURRENT_NOTE,
    PHASE_CURRENT_TITLE,
    SHIPPED_OR_LATER_PHASES,
    phase_key as pipeline_phase_key,
)
from apps.client_portal.queries import (
    customer_ids_for_account,
    customer_owns_formulation,
)
from apps.formulations.models import Formulation
from apps.trial_batches.cycle_services import (
    CycleHasActiveSlots,
    CycleHasPendingTopUp,
    InvalidAdditionalSampleQuantity,
    SlotNotActive,
    confirm_trial_batches_done,
    mark_slot_delivered,
    record_slot_verdict,
    request_additional_samples,
)
from apps.trial_batches.models import (
    AdditionalSampleRequest,
    AdditionalSampleRequestStatus,
    TrialBatchCycle,
    TrialBatchSlot,
    TrialBatchSlotStatus,
    TrialBatchSlotVerdict,
)


def _serialise_slot(
    slot: TrialBatchSlot,
    production: dict | None = None,
    sequence_offset: int = 0,
) -> dict[str, Any]:
    """Portal-side snapshot of a single slot.

    ``production`` is the pre-fetched per-slot production summary:

      * ``state`` — ``"not_pushed" | "in_progress" | "completed" | "unknown"``,
        the coarse MO-chain bucket. Kept for wire back-compat.
      * ``total`` / ``done`` — MO-chain stage counts (same purpose).
      * ``phase`` — the PSP OrderWizard phase key for the slot's Sample
        CO (``"in_production" | "closeout" | "final_release" |
        "awaiting_routing" | "ready_to_dispatch" | "awaiting_pickup" |
        "dispatched" | "delivered" | ...``), or ``""`` when the
        snapshot fetch soft-failed.
      * ``phase_title`` / ``phase_note`` — customer-safe copy from
        ``pipeline_copy`` for that phase, or ``None`` for unmapped
        phases.

    The FE reads ``phase`` + copy fields as the primary signal so the
    strip surfaces "Pending QC" / "Preparing dispatch" / "On the way"
    instead of jumping to "ready to confirm" the instant the last MO
    closes.
    """

    production = production or {"state": "unknown", "total": 0, "done": 0}
    phase = (production.get("phase") or "").strip()
    return {
        "id": str(slot.id),
        # Sequence number as the customer should see it — shifted by
        # ``sequence_offset`` when the cycle was restarted after a
        # team-close so the ladder starts from #1 for the current
        # run rather than continuing #4, #5, #6 from history.
        "sequence_no": slot.sequence_no - sequence_offset,
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
        "production_phase": phase or None,
        "production_phase_title": (
            PHASE_CURRENT_TITLE.get(phase) if phase else None
        ),
        "production_phase_note": (
            PHASE_CURRENT_NOTE.get(phase) if phase else None
        ),
        # PSP dispatch-confirmation snapshot when the shipment has
        # left the building — carrier / plate / driver / waybill /
        # tracking / seal / temperature + checklist + loading photos.
        # ``None`` when PSP hasn't marked the shipment ``picked_up``
        # yet (FE hides the card in that case). Same shape as the
        # storefront sample-detail view so both portals speak the
        # same wire.
        "dispatch": production.get("dispatch"),
        # PSP Final Product Release documents (COA / BMR / micro /
        # label proof / retain-sample photos). Empty list when the
        # release ceremony hasn't landed yet OR when PSP is off / the
        # CO uuid isn't recognised. Portal FE hides the section on
        # empty; same shape as the storefront sample-detail view.
        "release_documents": production.get("release_documents") or [],
        "created_at": slot.created_at.isoformat(),
        "updated_at": slot.updated_at.isoformat(),
    }


def _fetch_production_summary(
    slot: TrialBatchSlot, organization: Any
) -> dict[str, Any]:
    """Fetch the slot's PSP MO chain + OrderWizard snapshot and reduce
    them to a per-slot production summary. Silent-degrade — any PSP
    hiccup (unreachable, unknown mo uuid, integration off) returns
    ``"unknown"`` for the coarse state and ``""`` for the phase so the
    FE keeps rendering meaningful copy rather than blanking.

    Returns ``{"state", "total", "done", "phase"}`` where:

      * ``state`` is the coarse MO-chain bucket ("not_pushed" /
        "in_progress" / "completed" / "unknown") — kept for wire
        back-compat with the previous shape.
      * ``phase`` is the PSP OrderWizard phase key for the slot's
        Sample CO ("in_production" / "closeout" / "final_release" /
        "awaiting_routing" / "ready_to_dispatch" / "awaiting_pickup" /
        "dispatched" / "delivered" / ...), or "" on soft-fail. The
        cycle-slot Sample CO on PSP is keyed by ``slot.id``
        (see `apps.psp.services.create_psp_manufacturing_order`), so
        we look the snapshot up by that.

    Chain-status "completed" doesn't mean the shipment has left the
    building — PSP still walks through closeout / QC (final_release)
    / awaiting_routing / dispatched / delivered after the last MO
    closes. The phase key is the honest signal for those transitions
    and is what the FE renders in the strip.
    """

    from apps.psp.services import (
        get_psp_customer_order_snapshot,
        get_psp_dispatch_for_co,
        get_psp_manufacturing_order_chain,
        list_psp_release_documents_for_co,
    )
    from apps.trial_batches.models import TrialBatch

    if slot.trial_batch_id is None:
        return {
            "state": "not_pushed",
            "total": 0,
            "done": 0,
            "phase": "",
            "dispatch": None,
            "release_documents": [],
        }
    tb = TrialBatch.objects.only("psp_manufacturing_order_uuid").filter(
        id=slot.trial_batch_id
    ).first()
    mo_uuid = getattr(tb, "psp_manufacturing_order_uuid", None) if tb else None
    if not mo_uuid:
        return {
            "state": "not_pushed",
            "total": 0,
            "done": 0,
            "phase": "",
            "dispatch": None,
            "release_documents": [],
        }

    # Phase (rich signal). Independent from the MO chain fetch so a
    # snapshot soft-fail doesn't blank the coarse state and vice versa.
    # PSP wraps the payload as ``{"snapshot": {...}}`` — unwrap before
    # handing to ``phase_key`` (same shape sample-detail unwraps).
    try:
        snapshot_payload = get_psp_customer_order_snapshot(
            organization=organization, co_uuid=slot.id
        )
    except Exception:  # noqa: BLE001 — silent-degrade, mirrors sample-detail
        snapshot_payload = None
    snapshot: dict | None = None
    if isinstance(snapshot_payload, dict):
        inner = snapshot_payload.get("snapshot")
        snapshot = inner if isinstance(inner, dict) else None
    phase = pipeline_phase_key(snapshot)

    # Dispatch snapshot — carrier / plate / driver / waybill /
    # tracking / seal / temperature + checklist + loading photos.
    # PSP returns ``None`` until the shipment is ``picked_up``; the
    # FE hides the dispatch card in that case. Silent-degrade to
    # ``None`` on any transport error.
    try:
        dispatch = get_psp_dispatch_for_co(
            organization=organization, co_uuid=slot.id
        )
    except Exception:  # noqa: BLE001 — same posture as the snapshot fetch
        dispatch = None

    # Final Product Release documents — COA / BMR / micro / label
    # proof / retain-sample photos. Empty list until the release
    # ceremony has landed on PSP; the FE hides the card on empty.
    try:
        release_documents = list_psp_release_documents_for_co(
            organization=organization, co_uuid=slot.id
        )
    except Exception:  # noqa: BLE001 — silent-degrade
        release_documents = []

    # Chain (coarse signal). Preserved for wire back-compat with FE
    # revisions that haven't picked up the phase field yet.
    try:
        chain_response = get_psp_manufacturing_order_chain(
            organization=organization, mo_uuid=mo_uuid
        )
    except Exception:  # noqa: BLE001 — same posture
        return {
            "state": "unknown",
            "total": 0,
            "done": 0,
            "phase": phase,
            "dispatch": dispatch,
            "release_documents": release_documents,
        }
    chain = (chain_response or {}).get("chain") or []
    if not chain:
        return {
            "state": "unknown",
            "total": 0,
            "done": 0,
            "phase": phase,
            "dispatch": dispatch,
            "release_documents": release_documents,
        }
    total = len(chain)
    done = sum(1 for row in chain if row.get("status") == "completed")
    state = "completed" if done == total else "in_progress"
    return {
        "state": state,
        "total": total,
        "done": done,
        "phase": phase,
        "dispatch": dispatch,
        "release_documents": release_documents,
    }


def _fetch_dispatch_only(
    slot: TrialBatchSlot, organization: Any
) -> dict | None:
    """Lightweight per-slot dispatch fetch — no MO chain, no
    snapshot, no auto-deliver side-effect. Used to populate the
    ``dispatch`` field on non-active slots so the collapsible slot-
    story on the portal can show historical shipment details
    (carrier / vehicle / driver / waybill / tracking / seal /
    temperature / checklist / photos) for every prior sample the
    customer received. Silent-degrade to ``None`` on any transport /
    integration failure so a single PSP hiccup doesn't blank the
    portal's slot ladder.
    """

    from apps.psp.services import get_psp_dispatch_for_co

    try:
        return get_psp_dispatch_for_co(
            organization=organization, co_uuid=slot.id
        )
    except Exception:  # noqa: BLE001 — mirrors the active-slot posture
        return None


def _fetch_release_documents_only(
    slot: TrialBatchSlot, organization: Any
) -> list[dict]:
    """Per-slot release-documents fetch for non-active (historical)
    slots. Mirrors ``_fetch_dispatch_only`` so the collapsible slot-
    story renders COA / BMR / micro / label proof / retain-sample
    photos on prior samples too — not just the active one. Silent-
    degrade to ``[]`` on any transport / integration failure.
    """

    from apps.psp.services import list_psp_release_documents_for_co

    try:
        return list_psp_release_documents_for_co(
            organization=organization, co_uuid=slot.id
        )
    except Exception:  # noqa: BLE001 — mirrors the active-slot posture
        return []


def _maybe_auto_deliver_slot(
    slot: TrialBatchSlot, production: dict[str, Any]
) -> TrialBatchSlot:
    """Auto-flip an IN_PRODUCTION slot to DELIVERED when PSP reports
    the phase as ``delivered``. Mirrors the "either we or the client
    confirm" model on the storefront samples flow — once PSP marks it
    delivered, the customer shouldn't have to click a button to unlock
    the feedback card.

    Read-side side-effect: portal reads are the natural trigger
    (the customer visiting the card is when we want the state to
    catch up). Idempotent — ``mark_slot_delivered`` no-ops on
    already-delivered / closed slots.
    """

    if (production.get("phase") or "") != "delivered":
        return slot
    if slot.status != TrialBatchSlotStatus.IN_PRODUCTION:
        return slot
    try:
        return mark_slot_delivered(slot=slot)
    except SlotNotActive:
        # Slot lost its batch link between fetch and flip — extreme
        # edge case; leave the row untouched.
        return slot


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
    # ``slots_display_offset`` hides current-run counter noise —
    # set when a top-up reactivates a TERMINATED_BY_TEAM cycle so
    # the portal ladder shows only the freshly-ordered run (see
    # ``apply_additional_samples_on_payment_approved``). Internal
    # scientist views never call through this serializer so their
    # full-history read is unaffected.
    #
    # But we DON'T want to erase the customer's memory of samples
    # they already received — meaningful past-run slots (anything
    # they got, gave feedback on, or that closed with a verdict)
    # go into ``previous_run_slots`` so the portal card can render
    # a compact "Previous samples" section above the current
    # ladder. Cancelled + awaiting-scientist historical slots ARE
    # filtered out — those never produced anything the customer
    # can meaningfully look back on.
    offset = cycle.slots_display_offset or 0
    slots = list(
        cycle.slots.filter(sequence_no__gt=offset).order_by("sequence_no")
    )
    previous_run_slots: list[TrialBatchSlot] = []
    if offset > 0:
        previous_run_slots = list(
            cycle.slots.filter(sequence_no__lte=offset)
            .exclude(
                status__in=(
                    TrialBatchSlotStatus.AWAITING_SCIENTIST,
                    TrialBatchSlotStatus.CLOSED_CANCELLED,
                )
            )
            .order_by("sequence_no")
        )
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
    # Fetch PSP MO chain + snapshot only for the ACTIVE slot — one
    # HTTP round-trip per portal render is fine; hitting PSP for every
    # closed historical slot would balloon the request without adding
    # info the customer can act on.
    production_by_slot: dict[str, dict[str, Any]] = {}
    if active is not None and active.status in (
        TrialBatchSlotStatus.IN_PRODUCTION,
        TrialBatchSlotStatus.SHIPPED,
        TrialBatchSlotStatus.DELIVERED,
        TrialBatchSlotStatus.FEEDBACK_PENDING,
    ):
        summary = _fetch_production_summary(active, cycle.organization)
        production_by_slot[str(active.id)] = summary
        # Auto-advance the slot when PSP reports the shipment has
        # actually been delivered. Reflows the header + feedback card
        # on the very next render without waiting on the customer to
        # click "I've received it".
        active = _maybe_auto_deliver_slot(active, summary)
        slots = list(
            cycle.slots.filter(sequence_no__gt=offset).order_by("sequence_no")
        )

    # Historical dispatch snapshots for closed slots — powers the
    # "story" expand on the portal so customers can review every
    # prior shipment (carrier / plate / driver / waybill / photos)
    # after the cycle moves on. One PSP round-trip per non-active
    # trial-batch-linked slot; cycles are typically small (3-10
    # slots) so the extra calls stay negligible. Skipped for
    # awaiting_scientist (no batch) and closed_cancelled (auto-
    # cancelled companion slots — no shipment ever happened).
    from apps.trial_batches.models import TrialBatch as _TrialBatch

    for slot_row in slots:
        slot_key = str(slot_row.id)
        if slot_key in production_by_slot:
            # Active slot already fetched via the full production
            # summary above — its dispatch is already attached.
            continue
        if slot_row.status in (
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.CLOSED_CANCELLED,
        ):
            continue
        if slot_row.trial_batch_id is None:
            continue
        # Confirm the batch actually reached PSP before hitting the
        # dispatch endpoint — otherwise every drafted-but-not-pushed
        # trial batch adds an unnecessary PSP round-trip that will
        # never return anything useful.
        _tb = _TrialBatch.objects.only(
            "psp_manufacturing_order_uuid"
        ).filter(id=slot_row.trial_batch_id).first()
        if _tb is None or not getattr(_tb, "psp_manufacturing_order_uuid", None):
            continue
        dispatch_payload = _fetch_dispatch_only(slot_row, cycle.organization)
        release_docs_payload = _fetch_release_documents_only(
            slot_row, cycle.organization
        )
        # Reconcile stuck rows: if NPD says the slot has been
        # delivered / feedback_pending / closed_* but PSP's dispatch
        # is still at ``picked_up``, PSP never got the customer's
        # portal confirm (integration was down, older confirm-view
        # release predated the propagate-to-PSP fix, etc.). Fire the
        # PSP confirm once — the endpoint is idempotent — so the
        # Shipment card's status pill catches up next tick.
        if (
            dispatch_payload
            and dispatch_payload.get("status") == "picked_up"
            and slot_row.status
            in (
                TrialBatchSlotStatus.DELIVERED,
                TrialBatchSlotStatus.FEEDBACK_PENDING,
                TrialBatchSlotStatus.CLOSED_ITERATED,
                TrialBatchSlotStatus.CLOSED_SATISFIED,
            )
        ):
            _propagate_delivery_to_psp(slot_row, actor=None)
            # Re-read so the payload the FE receives on THIS request
            # already reflects the reconciled state — otherwise the
            # customer has to refresh once more to see it flip.
            dispatch_payload = _fetch_dispatch_only(
                slot_row, cycle.organization
            )
        production_by_slot[slot_key] = {
            "state": "unknown",
            "total": 0,
            "done": 0,
            "phase": "",
            "dispatch": dispatch_payload,
            "release_documents": release_docs_payload,
        }
    # ``slots_used`` counts slots the customer has actually been sent
    # a sample for (or is currently being sent one for) — anything past
    # the AWAITING_SCIENTIST seed row and excluding auto-cancels.
    # Without this, a freshly-opened cycle would read "1 of 3" the
    # moment the seed slot is created and the customer would think a
    # sample had already shipped.
    slots_worked = sum(
        1
        for s in slots
        if s.status
        not in (
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.CLOSED_CANCELLED,
        )
    )

    # Terminal-choice flags for the portal card.
    #
    # ``has_pending_top_up`` — any AdditionalSampleRequest still
    # awaiting a finance decision. While true, the card renders a
    # "waiting on finance" hold state and the terminal-choice prompt
    # is suppressed. Prevents the "customer closes → top-up lands
    # approved" race that would strand a paid-for set of slots.
    #
    # ``has_active_slots`` — any slot still in flight (awaiting
    # scientist / in production / delivered without verdict). The
    # terminal-choice prompt only surfaces once every paid-for
    # sample has landed a verdict.
    #
    # ``can_finalise`` — the composite flag the FE keys on to render
    # the "Yes, request more / No, we're done" prompt. Equivalent to
    # `not customer_confirmed_done_at AND not has_pending_top_up AND
    # not has_active_slots`.
    has_pending_top_up = any(
        r.status == AdditionalSampleRequestStatus.AWAITING_FINANCE
        for r in cycle.additional_sample_requests.all()
    )
    has_active_slots = any(
        s.status
        in (
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.IN_PRODUCTION,
            TrialBatchSlotStatus.SHIPPED,
            TrialBatchSlotStatus.DELIVERED,
            TrialBatchSlotStatus.FEEDBACK_PENDING,
        )
        for s in slots
    )
    customer_confirmed_done_at = (
        cycle.customer_confirmed_done_at.isoformat()
        if cycle.customer_confirmed_done_at is not None
        else None
    )
    can_finalise = (
        customer_confirmed_done_at is None
        and not has_pending_top_up
        and not has_active_slots
    )
    # Portal-facing total_slots is the current run's slot count —
    # ``total_slots`` on the row still counts everything ever
    # allocated (finance sums against it, scientist views show the
    # full history) but the customer should only see the current
    # run after a team-close-then-restart.
    total_slots_displayed = max(0, cycle.total_slots - offset)
    # Previous-run slots keep their original sequence numbers so the
    # customer sees the historical labels intact ("Sample #2 —
    # delivered 3 days ago"). No offset math on the wire because
    # they aren't part of the current-run counter.
    previous_run_payload = [
        _serialise_slot(s, production_by_slot.get(str(s.id)))
        for s in previous_run_slots
    ]
    return {
        "id": str(cycle.id),
        "status": cycle.status,
        "total_slots": total_slots_displayed,
        "slots_used": slots_worked,
        "closed_at": (
            cycle.closed_at.isoformat() if cycle.closed_at is not None else None
        ),
        "customer_confirmed_done_at": customer_confirmed_done_at,
        "has_pending_top_up": has_pending_top_up,
        "has_active_slots": has_active_slots,
        "can_finalise": can_finalise,
        "slots": [
            _serialise_slot(
                s, production_by_slot.get(str(s.id)), sequence_offset=offset
            )
            for s in slots
        ],
        "previous_run_slots": previous_run_payload,
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

        # Bi-directional delivery confirm: propagate to PSP so the
        # Shipment card's status pill flips from "In transit" to
        # "Delivered" on the very next portal read. Without this,
        # the NPD slot was marked DELIVERED but PSP's dispatch row
        # stayed at ``picked_up`` — the customer would keep seeing
        # "In transit" even after clicking "I've received it".
        # Silent-degrade: if PSP is unreachable, the NPD state is
        # already updated and the reconcile pass in ``_serialise_cycle``
        # will catch PSP up on the next portal visit.
        _propagate_delivery_to_psp(slot, request.user)

        return Response({"slot": _serialise_slot(slot)})


def _propagate_delivery_to_psp(slot: TrialBatchSlot, actor: Any) -> None:
    """Best-effort: call PSP's confirm-delivery endpoint for the
    slot's Sample CO so the dispatch row moves from ``picked_up`` to
    ``delivered`` and stays in sync with the NPD-side slot status.
    Always safe to call — PSP's endpoint is idempotent for already-
    delivered shipments.
    """

    from apps.psp.services import confirm_psp_dispatch_delivery_for_co

    signatory = _portal_actor_display_name(actor)
    try:
        confirm_psp_dispatch_delivery_for_co(
            organization=slot.cycle.organization,
            co_uuid=slot.id,
            recipient_signatory=signatory,
            delivery_notes="Confirmed via customer portal",
        )
    except Exception:  # noqa: BLE001 — silent-degrade
        return


def _portal_actor_display_name(actor: Any) -> str:
    """Human-readable signatory for the PSP dispatch confirmation.
    Prefers full name, then email, then a portal placeholder so PSP
    always sees a non-empty string.
    """

    if actor is None:
        return "Customer"
    getter = getattr(actor, "get_full_name", None)
    name = ""
    if callable(getter):
        try:
            name = (getter() or "").strip()
        except Exception:  # noqa: BLE001
            name = ""
    if name:
        return name
    email = (getattr(actor, "email", "") or "").strip()
    return email or "Customer"


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


class PortalTrialBatchSlotDispatchPhotoView(PortalAPIView):
    """``GET /api/portal/trial-batches/slots/<slot_id>/dispatch-photos/<file_uuid>/``

    Proxy-download one truck-arrival loading photo for a cycle-slot
    sample. Payment-agnostic counterpart to
    :class:`PortalSampleDispatchPhotoView` — custom-formulation
    slots don't map to a Payment, so we key the CO lookup by
    ``slot.id`` (matches how the Sample CO on PSP is created).

    Ownership: the slot's cycle must belong to a formulation the
    account can read through — reuses ``_load_owned_slot`` so a
    leaked file uuid from another account 404s cleanly at that
    layer. Bytes stream from PSP through NPD to the browser.

    Photos are always ``image/*``; render inline in the portal card.
    """

    def get(self, request: Request, slot_id, file_uuid) -> Response:
        from apps.psp.services import fetch_psp_dispatch_photo_for_co
        from django.http import HttpResponse

        slot = _load_owned_slot(request, slot_id)
        organization = slot.cycle.organization

        result = fetch_psp_dispatch_photo_for_co(
            organization=organization,
            co_uuid=slot.id,
            file_uuid=file_uuid,
        )
        if result is None:
            raise NotFound("dispatch_photo_not_found")

        body, mime, filename = result
        response = HttpResponse(body, content_type=mime)
        response["Content-Disposition"] = (
            f'inline; filename="{filename}"'
        )
        # Content-addressed by file uuid — a re-upload gets a new
        # uuid so cache-forever is safe. Mirrors the sample flow.
        response["Cache-Control"] = "private, max-age=86400, immutable"
        return response


class PortalTrialBatchSlotReleaseDocumentView(PortalAPIView):
    """``GET /api/portal/trial-batches/slots/<slot_id>/release-documents/<file_uuid>/``

    Proxy-download one Final Product Release document (COA / BMR /
    micro / label proof / retain-sample photo) for a cycle-slot
    sample. Payment-agnostic counterpart to
    :class:`PortalSampleReleaseDocumentView` — cycle slots don't map
    to a Payment, so we key the CO lookup by ``slot.id`` (matches
    how the Sample CO on PSP is created).

    Ownership: the slot's cycle must belong to a formulation the
    account can read through — reuses ``_load_owned_slot`` so a
    leaked file uuid from another account 404s cleanly at that
    layer. Bytes stream from PSP through NPD to the browser.

    Content-Disposition is ``inline`` for images / PDFs (browser
    previews) and ``attachment`` for anything else. Cache-Control
    is content-addressed so re-uploads bust automatically.
    """

    def get(self, request: Request, slot_id, file_uuid) -> Response:
        from apps.psp.services import fetch_psp_release_document_for_co
        from django.http import HttpResponse

        slot = _load_owned_slot(request, slot_id)
        organization = slot.cycle.organization

        result = fetch_psp_release_document_for_co(
            organization=organization,
            co_uuid=slot.id,
            file_uuid=file_uuid,
        )
        if result is None:
            raise NotFound("release_document_not_found")

        body, mime, filename = result
        response = HttpResponse(body, content_type=mime)
        # Inline for browser-previewable types, attachment otherwise
        # — matches the storefront sample release-doc behaviour.
        disposition = "inline" if _is_inline_previewable(mime) else "attachment"
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        response["Cache-Control"] = "private, max-age=86400, immutable"
        return response


def _is_inline_previewable(mime: str) -> bool:
    m = (mime or "").lower()
    return m.startswith("image/") or m == "application/pdf"


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


class PortalTrialBatchConfirmDoneView(PortalAPIView):
    """``POST /api/portal/projects/<formulation_id>/trial-batches/confirm-done/``.

    Customer picks "No, we're done" at the terminal-choice prompt.
    Stamps ``TrialBatchCycle.customer_confirmed_done_at`` which is
    the signal the final-spec stage keys off to unlock.

    Refuses when a top-up request is still awaiting finance approval
    (409 ``pending_top_up``) or a slot is still in flight (409
    ``active_slots``) — both cases mean the customer hasn't actually
    landed on a terminal choice yet.
    """

    def post(self, request: Request, formulation_id) -> Response:
        formulation = _load_owned_formulation(request, formulation_id)
        cycle = TrialBatchCycle.objects.filter(formulation=formulation).first()
        if cycle is None:
            raise NotFound()
        try:
            confirm_trial_batches_done(cycle=cycle, actor=request.user)
        except CycleHasPendingTopUp as exc:
            return Response(
                {"code": "pending_top_up", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )
        except CycleHasActiveSlots as exc:
            return Response(
                {"code": "active_slots", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )
        cycle_after = TrialBatchCycle.objects.get(pk=cycle.pk)
        return Response({"cycle": _serialise_cycle(cycle_after)})
