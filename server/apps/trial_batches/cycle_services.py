"""Trial-batch cycle state machine.

Cycle-level orchestration — creation on deposit approval, per-slot
verdict handling, additional-sample top-ups, team override closure.
Individual slot ↔ scientist ↔ PSP-MO plumbing continues to live in
:mod:`apps.trial_batches.services` and :mod:`apps.psp.services`; this
module wraps those in a sequential state machine so N sample slots
are worked one at a time with a feedback gate between each.

Public entry points:

* :func:`create_cycle_for_deposit` — hook from
  ``apps.payments.services.approve_payment`` when a bundled
  deposit+samples Payment is approved.
* :func:`link_slot_to_trial_batch` — called by the scientist when
  they open the batch for the current slot.
* :func:`mark_slot_delivered` — hook from the portal confirm-delivery
  endpoint (or from PSP shipment webhook once one exists).
* :func:`record_slot_verdict` — customer's satisfied / iterate
  verdict from the portal feedback card.
* :func:`request_additional_samples` — customer top-up from the portal.
* :func:`apply_additional_samples_on_payment_approved` — hook from
  ``approve_payment`` for :attr:`PaymentKind.ADDITIONAL_SAMPLES`.
* :func:`close_cycle_by_team_override` — internal user closes the
  cycle when the customer's happy via out-of-band contact.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any, Optional

from django.db import transaction
from django.utils import timezone

from apps.formulations.models import Formulation, FormulationVersion
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment, SampleAllocation, SampleAllocationStatus
from apps.trial_batches.models import (
    AdditionalSampleRequest,
    AdditionalSampleRequestStatus,
    TrialBatch,
    TrialBatchCycle,
    TrialBatchCycleStatus,
    TrialBatchSlot,
    TrialBatchSlotStatus,
    TrialBatchSlotVerdict,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Domain errors
# ---------------------------------------------------------------------------


class CycleAlreadyExists(Exception):
    """The formulation already has a TrialBatchCycle."""


class CycleNotFound(Exception):
    """No cycle exists for the target formulation."""


class SlotNotActive(Exception):
    """The slot's current status doesn't allow the requested transition."""


class SlotOutOfSequence(Exception):
    """A slot was asked to advance while an earlier slot is still open."""


class InvalidAdditionalSampleQuantity(Exception):
    """Requested quantity is <= 0 or exceeds the org's per-request cap."""


class CycleHasPendingTopUp(Exception):
    """Cycle can't be finalised — a customer-initiated top-up is
    still awaiting finance approval. The cycle has to wait for the
    finance decision (approve → new slots seeded / reject → drops
    into the terminal choice prompt) before it can move forward.
    """


class CycleHasActiveSlots(Exception):
    """Cycle can't be finalised — one or more slots are still in
    flight (awaiting scientist / in production / delivered but no
    verdict yet). The customer answers the terminal choice only once
    every paid-for sample has been resolved.
    """


# ---------------------------------------------------------------------------
# Cycle creation
# ---------------------------------------------------------------------------


def _draft_spec_version_for_formulation(
    formulation: Formulation,
) -> Optional[FormulationVersion]:
    """Return the FormulationVersion attached to the customer-signed
    draft spec for this formulation, if any. Used to seed slot 1 —
    every slot after 1 uses whichever version the scientist points
    the batch at, but slot 1 auto-uses the recipe the customer
    already blessed by signing the draft spec.
    """

    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
    )

    sheet = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation,
            document_kind=SpecificationDocumentKind.DRAFT,
            customer_signed_at__isnull=False,
        )
        .select_related("formulation_version")
        .order_by("-customer_signed_at")
        .first()
    )
    if sheet is None:
        return None
    return sheet.formulation_version


@transaction.atomic
def create_cycle_for_deposit(
    *, payment: Payment
) -> Optional[TrialBatchCycle]:
    """Create a :class:`TrialBatchCycle` for the formulation the
    approved DEPOSIT payment is attached to. Idempotent — a second
    call for the same formulation short-circuits and returns the
    existing cycle.

    No-ops (returns ``None``) when:

    * The payment isn't a bundled sample deposit (no
      :class:`SampleAllocation` on the formulation, or the allocation
      is still ``DRAFT``).
    * The allocation exists but has ``quantity_ordered = 0`` — the
      customer picked zero extras and only the free allowance would
      apply, but they still owe zero samples in that case.

    The cycle spawns slot 1 in ``AWAITING_SCIENTIST`` immediately so
    the scientist dashboard can surface it without a second write.
    Slot 1's ``formulation_version`` is seeded from whichever draft
    spec the customer signed; if there's no signed draft (unusual
    for a deposit-approved project) we fall back to the formulation's
    latest version.
    """

    if payment.kind != PaymentKind.DEPOSIT:
        return None

    formulation_id = payment.formulation_id
    if formulation_id is None:
        return None

    formulation = Formulation.objects.select_related("organization").get(
        id=formulation_id
    )

    allocation = (
        SampleAllocation.objects.filter(
            formulation=formulation,
            status=SampleAllocationStatus.CONFIRMED,
        )
        .order_by("-updated_at")
        .first()
    )
    if allocation is None or allocation.quantity_ordered <= 0:
        return None

    existing = TrialBatchCycle.objects.filter(formulation=formulation).first()
    if existing is not None:
        return existing

    seed_version = _draft_spec_version_for_formulation(formulation)
    if seed_version is None:
        seed_version = (
            FormulationVersion.objects.filter(formulation=formulation)
            .order_by("-created_at")
            .first()
        )
    if seed_version is None:
        logger.error(
            "Cannot create trial-batch cycle for formulation %s — no "
            "FormulationVersion exists to seed slot 1.",
            formulation.id,
        )
        return None

    cycle = TrialBatchCycle.objects.create(
        organization=formulation.organization,
        formulation=formulation,
        sample_allocation=allocation,
        seed_payment=payment,
        total_slots=allocation.quantity_ordered,
        status=TrialBatchCycleStatus.IN_PROGRESS,
    )
    TrialBatchSlot.objects.create(
        cycle=cycle,
        sequence_no=1,
        formulation_version=seed_version,
        status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
    )
    return cycle


# ---------------------------------------------------------------------------
# Slot ↔ TrialBatch link (scientist opens the batch)
# ---------------------------------------------------------------------------


@transaction.atomic
def link_slot_to_trial_batch(
    *, slot: TrialBatchSlot, trial_batch: TrialBatch
) -> TrialBatchSlot:
    """Attach the scientist-created :class:`TrialBatch` to its cycle
    slot. Called from the "trial batches in flight" dashboard action
    that spawns the batch.

    Does NOT advance the slot to ``IN_PRODUCTION`` — that transition
    now fires only when a PSP Manufacturing Order is successfully
    created for the linked batch (see
    :func:`promote_slot_to_in_production`). A trial batch on its own
    is just an NPD-side scale-up recipe; nothing is physically being
    made yet. Marking the slot ``IN_PRODUCTION`` here leaked "your
    sample is being made" onto the portal card the instant the
    scientist saved a recipe draft.

    Refuses to link:

    * If the slot isn't currently ``AWAITING_SCIENTIST``.
    * If the batch's ``formulation_version`` doesn't match the slot's
      snapshot — mismatch means the scientist opened a batch against
      the wrong recipe, which would corrupt the feedback→iterate loop.
    """

    if slot.status != TrialBatchSlotStatus.AWAITING_SCIENTIST:
        raise SlotNotActive(
            f"Slot {slot.id} is {slot.status}, expected AWAITING_SCIENTIST"
        )
    if trial_batch.formulation_version_id != slot.formulation_version_id:
        raise SlotOutOfSequence(
            "TrialBatch formulation_version does not match the slot's "
            "snapshot — refusing to link (would break the feedback loop)."
        )

    slot.trial_batch = trial_batch
    slot.save(update_fields=["trial_batch", "updated_at"])
    return slot


@transaction.atomic
def promote_slot_to_in_production(*, trial_batch: TrialBatch) -> None:
    """Promote a cycle slot to ``IN_PRODUCTION`` once its linked
    :class:`TrialBatch` has a live PSP Manufacturing Order attached.
    Called from the PSP MO create path — the *only* honest trigger
    for "the sample is being manufactured".

    No-op when:

    * The batch isn't attached to a cycle slot (standalone R&D trial
      that was never a customer-facing sample).
    * The slot has already moved past ``AWAITING_SCIENTIST`` — a
      subsequent MO retry shouldn't reset a slot that's already
      delivered / feedback-pending / closed.
    * The batch has no PSP MO yet (defensive; the caller should only
      invoke us after a successful ``create_psp_manufacturing_order``
      round-trip, but we double-check so a caller mistake can't
      silently mis-state the slot).
    """

    slot = getattr(trial_batch, "cycle_slot", None)
    if slot is None:
        return
    if slot.status != TrialBatchSlotStatus.AWAITING_SCIENTIST:
        return
    if not getattr(trial_batch, "psp_manufacturing_order_uuid", None):
        return

    slot.status = TrialBatchSlotStatus.IN_PRODUCTION
    slot.save(update_fields=["status", "updated_at"])


# ---------------------------------------------------------------------------
# Delivery signal
# ---------------------------------------------------------------------------


@transaction.atomic
def mark_slot_delivered(*, slot: TrialBatchSlot) -> TrialBatchSlot:
    """Advance a specific slot to ``DELIVERED``. Called from the
    portal confirm-delivery endpoint for trial-batch slots. Idempotent
    on already-delivered / closed slots.

    Only refuses when the slot is still ``AWAITING_SCIENTIST`` — a
    slot with no linked batch can't have been delivered.
    """

    if slot.status == TrialBatchSlotStatus.AWAITING_SCIENTIST:
        raise SlotNotActive(
            f"Slot {slot.id} is AWAITING_SCIENTIST, no batch in flight yet"
        )
    if slot.status in (
        TrialBatchSlotStatus.DELIVERED,
        TrialBatchSlotStatus.FEEDBACK_PENDING,
        TrialBatchSlotStatus.CLOSED_ITERATED,
        TrialBatchSlotStatus.CLOSED_SATISFIED,
        TrialBatchSlotStatus.CLOSED_CANCELLED,
    ):
        return slot
    slot.status = TrialBatchSlotStatus.DELIVERED
    slot.save(update_fields=["status", "updated_at"])
    return slot


@transaction.atomic
def mark_slot_delivered_by_payment(
    *, payment: Payment
) -> Optional[TrialBatchSlot]:
    """Advance the slot whose :class:`TrialBatch` was fulfilled by
    ``payment.fulfilled_by_trial_batches`` to ``DELIVERED``.

    Called from the portal confirm-delivery endpoint (which already
    holds the sample :class:`Payment`). Returns the slot advanced,
    or ``None`` if the payment isn't tied to a trial-batch cycle
    (backward-compat with standalone sample orders).

    Idempotent — an already-delivered / closed slot silently no-ops.
    """

    tb = TrialBatch.objects.filter(source_payment=payment).first()
    if tb is None:
        return None
    slot = TrialBatchSlot.objects.filter(trial_batch=tb).first()
    if slot is None:
        return None
    if slot.status in (
        TrialBatchSlotStatus.DELIVERED,
        TrialBatchSlotStatus.FEEDBACK_PENDING,
        TrialBatchSlotStatus.CLOSED_ITERATED,
        TrialBatchSlotStatus.CLOSED_SATISFIED,
        TrialBatchSlotStatus.CLOSED_CANCELLED,
    ):
        return slot
    slot.status = TrialBatchSlotStatus.DELIVERED
    slot.save(update_fields=["status", "updated_at"])
    return slot


# ---------------------------------------------------------------------------
# Verdict / feedback (T3 in the design walk-through)
# ---------------------------------------------------------------------------


@transaction.atomic
def record_slot_verdict(
    *,
    slot: TrialBatchSlot,
    verdict: str,
    feedback_summary: str = "",
    keep_producing_remaining: bool = False,
    actor: Any = None,
) -> TrialBatchSlot:
    """Record the customer's verdict on a delivered slot.

    Three branches, matching the design walk-through:

    * ``NEEDS_ITERATION`` — slot closes as ``CLOSED_ITERATED``, cycle
      stays ``IN_PROGRESS``. Caller is responsible for creating the
      next slot with the tweaked ``FormulationVersion`` via
      :func:`open_next_slot_iterated` (scientist action, gated on
      recipe review).
    * ``SATISFIED`` with ``keep_producing_remaining=False`` — slot
      closes as ``CLOSED_SATISFIED``, all subsequent
      ``AWAITING_SCIENTIST`` slots auto-cancel as
      ``CLOSED_CANCELLED``, cycle transitions to ``SATISFIED``.
    * ``SATISFIED`` with ``keep_producing_remaining=True`` — slot
      closes as ``CLOSED_SATISFIED``, cycle transitions to
      ``SATISFIED`` (final-spec-sign unlocks in parallel), remaining
      ``AWAITING_SCIENTIST`` slots stay open but are locked to the
      current slot's ``formulation_version`` (no more iterations).

    Refuses to record a verdict on a slot that isn't currently
    ``DELIVERED`` / ``FEEDBACK_PENDING``.
    """

    if slot.status not in (
        TrialBatchSlotStatus.DELIVERED,
        TrialBatchSlotStatus.FEEDBACK_PENDING,
    ):
        raise SlotNotActive(
            f"Slot {slot.id} is {slot.status}, expected DELIVERED/FEEDBACK_PENDING"
        )

    now = timezone.now()
    slot.verdict = verdict
    slot.verdict_at = now
    slot.feedback_summary = feedback_summary or ""

    if verdict == TrialBatchSlotVerdict.NEEDS_ITERATION:
        slot.status = TrialBatchSlotStatus.CLOSED_ITERATED
        slot.keep_producing_remaining = False
        slot.save(
            update_fields=[
                "verdict",
                "verdict_at",
                "feedback_summary",
                "status",
                "keep_producing_remaining",
                "updated_at",
            ]
        )
        return slot

    if verdict != TrialBatchSlotVerdict.SATISFIED:
        raise SlotNotActive(f"Unknown verdict {verdict!r}")

    slot.status = TrialBatchSlotStatus.CLOSED_SATISFIED
    slot.keep_producing_remaining = bool(keep_producing_remaining)
    slot.save(
        update_fields=[
            "verdict",
            "verdict_at",
            "feedback_summary",
            "status",
            "keep_producing_remaining",
            "updated_at",
        ]
    )

    cycle = slot.cycle
    cycle.status = TrialBatchCycleStatus.SATISFIED
    cycle.closed_at = now
    cycle.save(update_fields=["status", "closed_at", "updated_at"])

    if not slot.keep_producing_remaining:
        _cancel_awaiting_slots(cycle=cycle, reason_slot=slot)
    else:
        _lock_remaining_slots_to_version(
            cycle=cycle, formulation_version_id=slot.formulation_version_id
        )
    return slot


def _cancel_awaiting_slots(
    *, cycle: TrialBatchCycle, reason_slot: TrialBatchSlot
) -> int:
    """Cancel every AWAITING_SCIENTIST slot in the cycle. Used when
    the customer chose "satisfied — close cycle now"."""

    remaining = TrialBatchSlot.objects.filter(
        cycle=cycle,
        status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
    )
    now = timezone.now()
    count = 0
    for r in remaining:
        r.status = TrialBatchSlotStatus.CLOSED_CANCELLED
        r.verdict = None
        r.verdict_at = now
        r.feedback_summary = (
            f"Auto-cancelled: customer satisfied at slot {reason_slot.sequence_no}."
        )
        r.save(
            update_fields=[
                "status",
                "verdict",
                "verdict_at",
                "feedback_summary",
                "updated_at",
            ]
        )
        count += 1
    return count


def _lock_remaining_slots_to_version(
    *, cycle: TrialBatchCycle, formulation_version_id: Any
) -> int:
    """Called on ``SATISFIED + keep_producing_remaining=True`` — the
    customer approved the recipe but paid for more samples and wants
    us to keep shipping them. Two things happen:

    1. Every existing ``AWAITING_SCIENTIST`` slot is locked to the
       approved ``formulation_version`` so no further iteration can
       drift the recipe.
    2. Any slots the cycle paid for but the scientist hadn't
       pre-opened yet (usually all of them — slots are seeded lazily
       on ``open_next_slot_iterated``) are created now, locked to
       the same version, as ``AWAITING_SCIENTIST``. Without this
       step the portal shows "trial batches complete" the instant
       the customer approves, even when they explicitly asked us to
       finish the paid-for run.

    Returns the total slots touched (locked + newly seeded).
    """

    locked = TrialBatchSlot.objects.filter(
        cycle=cycle,
        status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
    ).update(formulation_version_id=formulation_version_id)

    existing_count = TrialBatchSlot.objects.filter(cycle=cycle).count()
    seeded = 0
    for offset in range(existing_count, cycle.total_slots):
        TrialBatchSlot.objects.create(
            cycle=cycle,
            sequence_no=offset + 1,
            formulation_version_id=formulation_version_id,
            status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
        )
        seeded += 1

    return locked + seeded


# ---------------------------------------------------------------------------
# Iteration / next-slot opening (scientist action after a needs_iteration
# verdict)
# ---------------------------------------------------------------------------


@transaction.atomic
def open_next_slot_iterated(
    *,
    cycle: TrialBatchCycle,
    formulation_version: FormulationVersion,
) -> TrialBatchSlot:
    """After a slot closes as ``CLOSED_ITERATED``, the scientist
    tweaks the recipe, saves a new :class:`FormulationVersion`, and
    calls this to open the next slot against the new snapshot.

    Refuses when:

    * The cycle isn't ``IN_PROGRESS``.
    * There's still an open (non-terminal) slot.
    * The cycle is already at ``total_slots`` — additional samples
      must be requested first via
      :func:`request_additional_samples`.
    """

    if cycle.status != TrialBatchCycleStatus.IN_PROGRESS:
        raise SlotNotActive(f"Cycle {cycle.id} is {cycle.status}")

    open_slot = TrialBatchSlot.objects.filter(
        cycle=cycle,
        status__in=(
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.IN_PRODUCTION,
            TrialBatchSlotStatus.SHIPPED,
            TrialBatchSlotStatus.DELIVERED,
            TrialBatchSlotStatus.FEEDBACK_PENDING,
        ),
    ).first()
    if open_slot is not None:
        raise SlotOutOfSequence(
            f"Slot {open_slot.sequence_no} is still {open_slot.status}"
        )

    used = TrialBatchSlot.objects.filter(cycle=cycle).count()
    if used >= cycle.total_slots:
        cycle.status = TrialBatchCycleStatus.MAX_REACHED
        cycle.closed_at = timezone.now()
        cycle.save(update_fields=["status", "closed_at", "updated_at"])
        raise SlotOutOfSequence(
            "Cycle has consumed all paid-for slots; request more first."
        )

    return TrialBatchSlot.objects.create(
        cycle=cycle,
        sequence_no=used + 1,
        formulation_version=formulation_version,
        status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
    )


# ---------------------------------------------------------------------------
# Additional-sample request (customer top-up)
# ---------------------------------------------------------------------------


@transaction.atomic
def request_additional_samples(
    *,
    cycle: TrialBatchCycle,
    quantity: int,
    actor: Any = None,
) -> AdditionalSampleRequest:
    """Create an :class:`AdditionalSampleRequest` + a pending
    :class:`Payment` on the finance queue. Snapshotted at the current
    :class:`SamplePricingConfig` unit-price (spot pricing at request
    time — matches the design decision the user picked).
    """

    if quantity <= 0 or quantity > 100:
        raise InvalidAdditionalSampleQuantity(
            f"quantity must be between 1 and 100 (got {quantity})"
        )

    from apps.payments.services import get_or_create_sample_pricing_config

    config = get_or_create_sample_pricing_config(cycle.organization)
    unit_price = Decimal(str(config.price_per_extra_sample))
    total = (unit_price * quantity).quantize(Decimal("0.01"))

    # Payment.paid_at is NOT NULL; recorded_by is a required User FK.
    # For customer-portal-initiated top-ups the actor is a ClientAccount
    # (not a platform User), so we attribute the record to the
    # formulation's creator — same fallback shape the bundled-deposit
    # auto-create uses. ``paid_at = now()`` mirrors those helpers too;
    # finance edits the real bank-transfer date when they reconcile.
    payment = Payment.objects.create(
        organization=cycle.organization,
        formulation=cycle.formulation,
        kind=PaymentKind.ADDITIONAL_SAMPLES,
        status=PaymentStatus.PENDING,
        amount=total,
        currency=(config.currency_code or "GBP").upper(),
        paid_at=timezone.now(),
        recorded_by=cycle.formulation.created_by,
        notes=(
            f"Additional samples request: {quantity} × "
            f"{config.currency_code} {unit_price} on trial cycle "
            f"{cycle.id}"
        ),
    )

    request = AdditionalSampleRequest.objects.create(
        cycle=cycle,
        organization=cycle.organization,
        requested_quantity=quantity,
        unit_price_snapshot=unit_price,
        currency_code=(config.currency_code or "GBP").upper(),
        total_amount_snapshot=total,
        payment=payment,
        status=AdditionalSampleRequestStatus.AWAITING_FINANCE,
        requested_by=actor if getattr(actor, "pk", None) is not None else None,
    )
    return request


@transaction.atomic
def apply_additional_samples_on_payment_approved(
    *, payment: Payment
) -> Optional[TrialBatchCycle]:
    """Hook from ``approve_payment`` for
    :attr:`PaymentKind.ADDITIONAL_SAMPLES`. Bumps the linked cycle's
    ``total_slots`` by the request's ``requested_quantity`` and opens
    fresh :class:`TrialBatchSlot` rows.

    Also lifts the cycle out of ``MAX_REACHED`` back to
    ``IN_PROGRESS`` — customer paying for more samples is an
    explicit signal that the cycle isn't done.
    """

    request = AdditionalSampleRequest.objects.filter(payment=payment).first()
    if request is None:
        return None
    if request.status == AdditionalSampleRequestStatus.APPROVED:
        return request.cycle

    cycle = request.cycle
    seed_version = _pick_version_for_new_slots(cycle=cycle)
    if seed_version is None:
        logger.error(
            "Additional-samples approval for cycle %s — no formulation "
            "version to seed the new slots against.",
            cycle.id,
        )
        return cycle

    used = TrialBatchSlot.objects.filter(cycle=cycle).count()

    # Reactivating a TERMINATED_BY_TEAM cycle is a customer-triggered
    # restart — the team closed but the customer chose to order more
    # rather than finalise. The portal display counter should reset
    # to just the newly-ordered samples (matches the "start from
    # only number of samples they requested" rule) instead of
    # accumulating on top of the pre-close history. We stamp the
    # offset to the CURRENT slot count so every future slot is
    # counted from zero on the portal ladder. Reactivations from
    # MAX_REACHED / SATISFIED keep accumulating — those are
    # continuations, not restarts.
    was_team_terminated = (
        cycle.status == TrialBatchCycleStatus.TERMINATED_BY_TEAM
    )
    if was_team_terminated:
        cycle.slots_display_offset = used

    for i in range(request.requested_quantity):
        TrialBatchSlot.objects.create(
            cycle=cycle,
            sequence_no=used + 1 + i,
            formulation_version=seed_version,
            status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
        )

    cycle.total_slots = cycle.total_slots + request.requested_quantity
    if cycle.status in (
        TrialBatchCycleStatus.MAX_REACHED,
        TrialBatchCycleStatus.SATISFIED,
        TrialBatchCycleStatus.TERMINATED_BY_TEAM,
    ):
        cycle.status = TrialBatchCycleStatus.IN_PROGRESS
        cycle.closed_at = None
        # Clear the team-close attribution when the customer
        # restarts — the new run isn't owned by the earlier close.
        if was_team_terminated:
            cycle.terminated_by = None
            cycle.terminated_reason = ""
    cycle.save(
        update_fields=[
            "total_slots",
            "status",
            "closed_at",
            "slots_display_offset",
            "terminated_by",
            "terminated_reason",
            "updated_at",
        ]
    )

    request.status = AdditionalSampleRequestStatus.APPROVED
    request.approved_at = timezone.now()
    request.save(update_fields=["status", "approved_at", "updated_at"])
    return cycle


@transaction.atomic
def reject_additional_samples_on_payment_voided(
    *, payment: Payment
) -> Optional[AdditionalSampleRequest]:
    """Hook from :func:`apps.payments.services.void_payment` for
    :attr:`PaymentKind.ADDITIONAL_SAMPLES`. Mirrors the void onto the
    linked :class:`AdditionalSampleRequest` so the cycle stops
    waiting on a finance decision that already landed as "no".

    Idempotent — a request already in ``REJECTED`` short-circuits.
    An ``APPROVED`` request is left alone (voiding an already-approved
    payment shouldn't retroactively reverse the sample slots that
    were seeded on approval; the team-override path is the right
    tool for that).
    """

    request = AdditionalSampleRequest.objects.filter(payment=payment).first()
    if request is None:
        return None
    if request.status != AdditionalSampleRequestStatus.AWAITING_FINANCE:
        return request
    request.status = AdditionalSampleRequestStatus.REJECTED
    request.save(update_fields=["status", "updated_at"])
    return request


# ---------------------------------------------------------------------------
# Final-spec rejection → cycle reopen
# ---------------------------------------------------------------------------


@transaction.atomic
def reopen_cycle_for_final_rejection(
    *, sheet: Any
) -> Optional[TrialBatchCycle]:
    """Reopen the trial-batch cycle after a customer rejects a FINAL
    spec on the portal.

    The rejection is a "we're not happy with what you built, take
    us back to trial batches" signal. To honour that we:

    1. Flip cycle back to ``IN_PROGRESS`` (from SATISFIED /
       TERMINATED_BY_TEAM — whichever terminal state it landed in
       after the customer's earlier confirmation).
    2. Clear ``customer_confirmed_done_at`` — the earlier "we're
       done" answer no longer holds.
    3. Bump ``slots_display_offset`` to the current total slot
       count so the portal counter resets to 0/0 for the new run
       (matches the team-close-then-restart semantic already in
       place).
    4. Clear ``closed_at`` + team-close attribution so the cycle
       reads as freshly re-opened.

    Customer's next portal state: the trial-batch card is back in
    "in-progress but nothing shipped" mode; the terminal-choice
    prompt will re-surface (they can request more samples via the
    existing top-up flow, which invoices, produces, iterates, then
    a new FINAL spec can be sent).

    Idempotent — a second call on an already-reopened cycle
    short-circuits.
    """

    formulation = getattr(
        getattr(sheet, "formulation_version", None), "formulation", None
    )
    if formulation is None:
        return None
    cycle = TrialBatchCycle.objects.filter(formulation=formulation).first()
    if cycle is None:
        return None
    if cycle.status == TrialBatchCycleStatus.IN_PROGRESS:
        return cycle

    current_slot_count = TrialBatchSlot.objects.filter(cycle=cycle).count()
    cycle.status = TrialBatchCycleStatus.IN_PROGRESS
    cycle.customer_confirmed_done_at = None
    cycle.closed_at = None
    cycle.terminated_by = None
    cycle.terminated_reason = ""
    # Reset display counter: portal reads 0 of 0 until customer
    # orders more samples via the existing top-up + finance-approval
    # loop. Historical slots stay in the DB (surface via
    # ``previous_run_slots`` on the portal card).
    cycle.slots_display_offset = current_slot_count
    cycle.total_slots = current_slot_count
    cycle.save(
        update_fields=[
            "status",
            "customer_confirmed_done_at",
            "closed_at",
            "terminated_by",
            "terminated_reason",
            "slots_display_offset",
            "total_slots",
            "updated_at",
        ]
    )
    return cycle


# ---------------------------------------------------------------------------
# Customer-confirmed done (terminal-choice endpoint)
# ---------------------------------------------------------------------------


@transaction.atomic
def confirm_trial_batches_done(
    *,
    cycle: TrialBatchCycle,
    actor: Any = None,
) -> TrialBatchCycle:
    """Customer explicitly answers "no more samples, we're done" at
    the terminal-choice prompt. Stamps ``customer_confirmed_done_at``
    so the final-spec stage can unlock.

    Refuses when:

    * A :class:`AdditionalSampleRequest` is still ``AWAITING_FINANCE``
      — finance has to approve or reject before the customer can
      close the cycle. Prevents the "customer closes, then top-up
      lands approved" race that would otherwise strand a paid-for
      set of slots.
    * Any slot is still in flight (awaiting scientist / in production
      / delivered without verdict). The customer answers the choice
      only once every paid-for sample has landed a verdict.

    Idempotent — a second call for an already-confirmed cycle
    short-circuits and returns the existing row.
    """

    if cycle.customer_confirmed_done_at is not None:
        return cycle

    pending = AdditionalSampleRequest.objects.filter(
        cycle=cycle,
        status=AdditionalSampleRequestStatus.AWAITING_FINANCE,
    ).exists()
    if pending:
        raise CycleHasPendingTopUp(
            f"Cycle {cycle.id} has a top-up request awaiting finance approval."
        )

    active = TrialBatchSlot.objects.filter(
        cycle=cycle,
        status__in=(
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.IN_PRODUCTION,
            TrialBatchSlotStatus.SHIPPED,
            TrialBatchSlotStatus.DELIVERED,
            TrialBatchSlotStatus.FEEDBACK_PENDING,
        ),
    ).exists()
    if active:
        raise CycleHasActiveSlots(
            f"Cycle {cycle.id} still has slots in flight."
        )

    now = timezone.now()
    cycle.customer_confirmed_done_at = now
    # Normalise to a terminal cycle status when the row was still
    # sitting at IN_PROGRESS / MAX_REACHED — customer closing the
    # cycle is a satisfied-equivalent signal for the pipeline.
    if cycle.status not in (
        TrialBatchCycleStatus.SATISFIED,
        TrialBatchCycleStatus.TERMINATED_BY_TEAM,
    ):
        cycle.status = TrialBatchCycleStatus.SATISFIED
    if cycle.closed_at is None:
        cycle.closed_at = now
    cycle.save(
        update_fields=[
            "status",
            "closed_at",
            "customer_confirmed_done_at",
            "updated_at",
        ]
    )
    return cycle


def _pick_version_for_new_slots(
    *, cycle: TrialBatchCycle
) -> Optional[FormulationVersion]:
    """Which formulation version should new (additional-request) slots
    use? Latest slot's version — if the customer was mid-iteration
    the scientist may already have opened a fresh version and we want
    the additional samples to pick up from there rather than reset
    to slot 1's snapshot.
    """

    latest = (
        TrialBatchSlot.objects.filter(cycle=cycle)
        .select_related("formulation_version")
        .order_by("-sequence_no")
        .first()
    )
    if latest is not None:
        return latest.formulation_version
    return _draft_spec_version_for_formulation(cycle.formulation)


# ---------------------------------------------------------------------------
# Team override
# ---------------------------------------------------------------------------


@transaction.atomic
def close_cycle_by_team_override(
    *,
    cycle: TrialBatchCycle,
    actor: Any,
    reason: str = "",
) -> TrialBatchCycle:
    """Internal user closes the cycle. Cancels only slots that
    haven't produced a physical sample yet — AWAITING_SCIENTIST
    (no batch drafted) and IN_PRODUCTION (batch in-flight but
    nothing has shipped). Slots that already SHIPPED / DELIVERED /
    have a customer VERDICT are preserved as-is so the customer
    keeps the info about the samples they actually received.

    Closing a ``SATISFIED`` cycle is allowed: the customer may have
    picked a recipe with ``keep_producing_remaining=True`` (so the
    remaining paid samples stay open), and the scientist may want
    to stop that mid-flight and hand the "more or done" choice back
    to the customer. Only ``TERMINATED_BY_TEAM`` is a no-op — the
    cycle is already closed.
    """

    if cycle.status == TrialBatchCycleStatus.TERMINATED_BY_TEAM:
        return cycle

    cycle.status = TrialBatchCycleStatus.TERMINATED_BY_TEAM
    cycle.terminated_by = actor
    cycle.terminated_reason = reason or ""
    cycle.closed_at = timezone.now()
    cycle.save(
        update_fields=[
            "status",
            "terminated_by",
            "terminated_reason",
            "closed_at",
            "updated_at",
        ]
    )

    _cancel_open_slots_on_team_close(
        cycle=cycle, note="Cycle closed by team override."
    )
    return cycle


def _cancel_open_slots_on_team_close(
    *, cycle: TrialBatchCycle, note: str
) -> int:
    """Cancel every slot that hasn't produced a physical sample yet.
    AWAITING_SCIENTIST (no batch drafted) and IN_PRODUCTION (batch
    in-flight but not yet shipped) both flip to ``CLOSED_CANCELLED``.
    SHIPPED / DELIVERED / FEEDBACK_PENDING / CLOSED_ITERATED /
    CLOSED_SATISFIED are LEFT ALONE — those represent samples the
    customer either received or gave feedback on, and cancelling
    them would erase real product-history information.
    """

    now = timezone.now()
    count = 0
    for r in TrialBatchSlot.objects.filter(
        cycle=cycle,
        status__in=(
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.IN_PRODUCTION,
        ),
    ):
        r.status = TrialBatchSlotStatus.CLOSED_CANCELLED
        r.verdict_at = now
        r.feedback_summary = note
        r.save(
            update_fields=[
                "status",
                "verdict_at",
                "feedback_summary",
                "updated_at",
            ]
        )
        count += 1
    return count
