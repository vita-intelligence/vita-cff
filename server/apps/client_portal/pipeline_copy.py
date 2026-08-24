"""Customer-facing copy for PSP OrderWizard phase transitions.

Single source of truth reused by both:

* ``sample_detail_views`` — the storefront samples-only pipeline card
  (customer paid for a ready-to-go product, one Payment ⇒ one CO on
  PSP).
* ``trial_batches_views`` — the custom-formulation cycle-slot pipeline
  card (customer commissioned a formulation, each slot is a Sample CO
  on PSP keyed by ``cycle_slot.id``).

PSP's ``phase.label`` / ``next_action.title`` are written for
operators ("Open MO MO00075 to finish bookings and signatures") and
must never leak to the customer. Only the ``phase.key`` atom crosses
this boundary; the customer-facing wording lives here.
"""

from __future__ import annotations


# PSP OrderWizard phase keys → coarse customer pipeline stage they
# satisfy. Anything before ``production_planning`` shouldn't happen
# for a sample CO (samples land as ``status = confirmed`` and skip
# proposal/approval phases), but we defensively map them to
# ``preparing`` so a mid-flight PSP state change doesn't leave the
# pipeline empty.
PHASE_TO_REACHED_STAGE: dict[str, str] = {
    "setup": "preparing",
    "approval": "preparing",
    "production_planning": "preparing",
    "awaiting_ingredients": "preparing",
    "in_production": "in_production",
    "closeout": "in_production",
    "final_release": "in_production",
    "awaiting_routing": "ready",
    "ready_to_dispatch": "ready",
    "awaiting_pickup": "ready",
    "dispatched": "ready",
    "delivered": "ready",
}


# Customer-facing HEADLINE for each PSP phase.
PHASE_CURRENT_TITLE: dict[str, str] = {
    "setup": "Setting up your order",
    "approval": "Awaiting internal approval",
    "production_planning": "Being scheduled",
    "awaiting_ingredients": "Sourcing ingredients",
    "in_production": "In production",
    "closeout": "Wrapping up production",
    "final_release": "Pending QC",
    "awaiting_routing": "Preparing dispatch",
    "ready_to_dispatch": "Ready to ship",
    "awaiting_pickup": "Awaiting courier",
    "dispatched": "On the way",
    "delivered": "Delivered",
}


# Customer-facing DETAIL for each PSP phase — a step-by-step
# narrative of what just finished, what our team is doing now, and
# what comes next. Kept generic (no MO ids, no vendor names, no
# operator instructions) so a leak of internal identifiers via PSP's
# payload can't reach the customer. Reused verbatim by both the
# storefront samples page banner and the cycle-slot portal card
# banner so both portals speak the same language.
PHASE_CURRENT_NOTE: dict[str, str] = {
    "setup": (
        "Your order is landing in our production system. Once it's slotted, "
        "the next steps are ingredient sourcing and production scheduling."
    ),
    "approval": (
        "The order is queued for internal sign-off. As soon as production "
        "approves it, we'll start sourcing the ingredients."
    ),
    "production_planning": (
        "The batch has been approved. Our planners are picking a slot on "
        "the production schedule and prepping the recipe for the shop floor."
    ),
    "awaiting_ingredients": (
        "The run is scheduled. We're pulling every ingredient from stock "
        "(or ordering what we're short on) so production can start."
    ),
    "in_production": (
        "The shop floor is actively producing your batch — working "
        "through the recipe step by step, with in-process checks at "
        "each stage. Once the last step closes, the batch moves to QC."
    ),
    "closeout": (
        "The last production step just finished. Operators are closing "
        "out the manufacturing record (weights, yields, in-process checks) "
        "before the batch hands over to QC."
    ),
    "final_release": (
        "Manufacturing is complete. Our QA team is reviewing the batch "
        "record and lab results (identity, potency, micro, allergens, "
        "label proof) before signing the release. Only then does the batch "
        "leave quarantine for dispatch."
    ),
    "awaiting_routing": (
        "QA has released the batch. We're preparing your shipment paperwork "
        "— commercial invoice, packing list, delivery note — and picking a "
        "courier for the route."
    ),
    "ready_to_dispatch": (
        "Paperwork is signed and the courier is booked. Your sample is "
        "packed, labelled, and staged in the dispatch area — pickup is "
        "usually within the next working day."
    ),
    "awaiting_pickup": (
        "The parcel is staged in dispatch with all documents attached. "
        "We're just waiting for the courier to arrive and collect it."
    ),
    "dispatched": (
        "The courier has collected your sample and it's on its way to the "
        "delivery address on file. Tracking updates will arrive by email."
    ),
    "delivered": (
        "The courier has confirmed delivery. Please check the parcel and "
        "let us know when you're ready to give feedback on the batch."
    ),
}


# Phases at which the physical shipment is en route to (or already
# with) the customer. Used to gate the cycle-slot "I've received it"
# button and the auto-DELIVERED slot flip on portal read.
SHIPPED_OR_LATER_PHASES: frozenset[str] = frozenset(
    {"dispatched", "delivered"}
)


def phase_key(snapshot: dict | None) -> str:
    """Extract the phase key atom from a PSP snapshot payload.

    Returns an empty string when the snapshot is missing / malformed
    so callers can pattern-match on falsy without an extra None check.
    """

    if not snapshot:
        return ""
    phase = snapshot.get("phase") or {}
    return (phase.get("key") or "").strip()
