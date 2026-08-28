"""Per-product pipeline detail for the customer portal.

Returns the full lifecycle view of one project the customer owns:

* ``pipeline`` — eight ordered stages from "Request submitted" through
  to "Production". Each stage has a stable ``key`` for the FE, a
  human-readable ``label``, a ``state`` (``done`` / ``current`` /
  ``future``), and an optional ``completed_at`` timestamp.
* ``next_action`` — the single open action the customer can take
  right now (signing, choosing path, etc.) — reuses the same
  schema as the dashboard aggregator so the FE component is shared.
* ``documents`` — every signed / submitted document attached to the
  project (proposals, specs, label revisions) so the customer can
  re-download what they signed.
* ``timeline`` — unified activity feed (transitions across proposal,
  spec, and label-design rows) newest-first so the customer can scroll
  through "what happened" without bouncing between surfaces.

Ownership is established the same way as the rest of the portal:
the customer must own (via :class:`apps.proposals.models.Proposal`)
at least one row referencing the requested formulation.
"""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.cff_submissions.models import CFFSubmission
from apps.client_portal.api.views import PortalAPIView
from apps.formulations.models import Formulation, ProjectStatus, ProjectType
from apps.label_design.constants import LabelDesignPath, LabelDesignStatus
from apps.label_design.models import LabelDesign, LabelDesignTransition
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.product_validation.models import ProductValidation, ValidationStatus
from apps.proposals.models import Proposal, ProposalStatusTransition
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
    SpecificationTransition,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt else None


def _first_signed_proposal(proposals: list[Proposal]) -> Proposal | None:
    return next(
        (p for p in proposals if (p.customer_signed_at is not None)),
        None,
    )


def _first_sent_proposal(proposals: list[Proposal]) -> Proposal | None:
    return next((p for p in proposals if p.status == "sent"), None)


def _draft_specs(sheets: list[SpecificationSheet]) -> list[SpecificationSheet]:
    return [s for s in sheets if s.document_kind == SpecificationDocumentKind.DRAFT]


def _final_specs(sheets: list[SpecificationSheet]) -> list[SpecificationSheet]:
    return [s for s in sheets if s.document_kind == SpecificationDocumentKind.FINAL]


def _first_signed(specs: list[SpecificationSheet]) -> SpecificationSheet | None:
    return next((s for s in specs if s.customer_signed_at is not None), None)


def _first_sent_unsigned(
    specs: list[SpecificationSheet],
) -> SpecificationSheet | None:
    return next(
        (
            s
            for s in specs
            if s.status == SpecificationStatus.SENT and s.customer_signed_at is None
        ),
        None,
    )


# ---------------------------------------------------------------------------
# Production status — PSP-mirrored, drives the portal's production
# card (which runs in parallel with the label-design card once
# production kicks off).
# ---------------------------------------------------------------------------

#: Portal-friendly copy for each PSP wizard phase. Falls back to
#: ``PspProductionStatus.phase_label`` (PSP's own copy) for phases
#: that don't have a customer-safe rewrite yet. Keep here (not on
#: PSP) so wording can be tuned without a PSP deploy — the payload
#: PSP sends is authoritative for the raw ``phase`` key.
_PRODUCTION_PHASE_COPY: dict[str, dict[str, str]] = {
    "production_planning": {
        "label": "Preparing manufacturing order",
        "detail": (
            "Our production planner is preparing the manufacturing order for "
            "your project. Once the order is drafted and internally approved, "
            "we'll start sourcing any ingredients or components we need."
        ),
    },
    "setup": {
        "label": "Setting up your order",
        "detail": (
            "Our team is preparing the order in our production system — "
            "adding the recipe, quantities, and shipping details before "
            "handing it to the planner."
        ),
    },
    "approval": {
        "label": "Awaiting order approval",
        "detail": (
            "The order is queued for internal sign-off. Once approved, "
            "we'll move it to the production planner."
        ),
    },
    "awaiting_ingredients": {
        "label": "Waiting on ingredients",
        "detail": (
            "We've raised purchase orders for the ingredients needed to make "
            "your product. As soon as they land in our warehouse, production "
            "picks them up."
        ),
    },
    "picking_ingredients": {
        "label": "Picking ingredients from warehouse",
        "detail": (
            "Our warehouse team is pulling the ingredients and staging them "
            "for the production line."
        ),
    },
    "in_production": {
        "label": "In production",
        "detail": (
            "Your product is being manufactured. This covers pre-production "
            "checks, blending / filling, and in-process quality tests."
        ),
    },
    "closeout": {
        "label": "Quality check and closeout",
        "detail": (
            "The production run is complete. Our quality team is running the "
            "final release tests and any remaining paperwork before your "
            "batch is signed off."
        ),
    },
    "final_release": {
        "label": "Final release check",
        "detail": (
            "The final release documents are being prepared — the last "
            "compliance step before your batch is ready to ship."
        ),
    },
    "awaiting_routing": {
        "label": "Awaiting shipping details",
        "detail": (
            "Your batch is ready. Our logistics team is finalising the "
            "carrier and route."
        ),
    },
    "ready_to_dispatch": {
        "label": "Preparing dispatch paperwork",
        "detail": (
            "The shipping paperwork is being drawn up — labels, packing "
            "lists, and any customs docs."
        ),
    },
    "awaiting_pickup": {
        "label": "Awaiting carrier pickup",
        "detail": "Your batch is packed and staged for the carrier to collect.",
    },
    "dispatched": {
        "label": "On its way",
        "detail": "Your batch has left our warehouse and is in transit.",
    },
    "delivered": {
        "label": "Delivered",
        "detail": "Your batch has been delivered to the shipping address.",
    },
    "cancelled": {
        "label": "Cancelled",
        "detail": "This order has been cancelled.",
    },
}


def _dispatch_progress_phase_override(phase, dispatch_progress):
    """Override phase label + detail when a multi-visit pickup is in
    progress. Only fires on ``awaiting_pickup`` — other phases keep
    their default copy from ``_PRODUCTION_PHASE_COPY``.
    """

    if phase != "awaiting_pickup" or not isinstance(dispatch_progress, dict):
        return (None, None)

    events_count = dispatch_progress.get("events_count") or 0
    any_partial = bool(dispatch_progress.get("any_partial"))
    picked = _format_dispatch_qty(dispatch_progress.get("picked_up_qty"))
    total = _format_dispatch_qty(dispatch_progress.get("total_qty"))
    remaining = _format_dispatch_qty(dispatch_progress.get("remaining_qty"))

    if any_partial and events_count and picked and total:
        return (
            "Partial pickup in progress",
            f"{picked} of {total} units picked up so far "
            f"({events_count} truck{'s' if events_count != 1 else ''} "
            f"loaded). {remaining} units still on our floor for the "
            "next visit.",
        )

    return (None, None)


def _format_dispatch_qty(raw):
    """Portal-safe qty formatter — strips Decimal trailing zeros +
    inserts thousands separators. Silent-degrade to the raw string
    on any parsing miss."""

    if raw is None:
        return None
    try:
        from decimal import Decimal

        d = Decimal(str(raw)).normalize()
        # ``normalize`` on a small integer-valued decimal can slip
        # into scientific notation (``1E+3``). Restore fixed-point
        # for anything that fits comfortably in float precision.
        text = format(d, "f")
        if "." in text:
            text = text.rstrip("0").rstrip(".")
        # Thousands separator on the whole-number part only — keeps
        # any decimal tail intact.
        if "." in text:
            whole, frac = text.split(".", 1)
            return f"{int(whole):,}.{frac}"
        return f"{int(text):,}"
    except Exception:
        return str(raw)


def _routing_request_phase_override(phase, routing_req):
    """Override phase label + detail when a customer-driven routing
    request is live. Only fires on ``awaiting_routing`` — every
    other phase gets its default copy from ``_PRODUCTION_PHASE_COPY``.

    Returns ``(label, detail)`` tuple; either / both can be ``None``
    when the default copy is fine.
    """

    if phase != "awaiting_routing" or not isinstance(routing_req, dict):
        return (None, None)

    state = routing_req.get("state")
    reason = routing_req.get("team_decision_reason")

    if state == "awaiting_customer" and reason:
        # Team declined a prior 3PL request; portal shows the reason
        # inside the RoutingChoiceCard, but the ProductionCard header
        # also needs to reflect that WE bounced the ball back.
        return (
            "3PL unavailable — pick again below",
            "We can't take your batch into 3PL storage right now. "
            "See the reason and pick Direct shipment below to proceed.",
        )

    if state == "awaiting_customer":
        return (
            "Your batch is ready — choose next step",
            "Positive Release cleared your batch. Pick 3PL storage "
            "or Direct shipment on the card below.",
        )

    if state == "awaiting_team_review":
        return (
            "3PL request received — team review",
            "Thanks for choosing 3PL storage. Our team is confirming "
            "availability; we'll update you as soon as it's approved.",
        )

    if state == "applied_three_pl":
        return (
            "3PL storage confirmed",
            "Your goods are under 3PL bailee custody. Request "
            "dispatch anytime from this project page.",
        )

    if state == "applied_shipment":
        return (
            "Preparing your dispatch",
            "Direct shipment applied. Your batch is being staged; "
            "shipment paperwork will appear here soon.",
        )

    return (None, None)


def _build_production_status(
    *, formulation, proposals: list[Proposal] | None = None
) -> dict | None:
    """Return the customer-safe production snapshot for the portal, or
    ``None`` when PSP hasn't pushed anything yet (i.e. the project
    isn't in production).

    RTG guard: the storefront checkout mirrors an RTG order into PSP
    (creates a CO in ``production_planning``) the moment the customer
    submits the cart — before signing the proposal and before finance
    confirms the payment. Rendering the ProductionCard at that point
    is misleading ("Preparing manufacturing order …" while the invoice
    is still unpaid); worse, it leaks our internal PSP state to a
    customer who legally hasn't authorised us to start anything. The
    portal's empty-state copy ("Production hasn't started yet — once
    your invoice is settled …") is what the customer should see until
    payment lands, so we return ``None`` for RTG projects whose
    proposal hasn't been paid for.
    """

    row = getattr(formulation, "psp_production_status", None)
    if row is None:
        return None
    if not (row.phase or "").strip():
        # Row exists but PSP hasn't populated a phase — treat as no
        # data (shouldn't happen in normal flow; guards a partial
        # upsert if PSP is mid-migration).
        return None

    from apps.formulations.models import ProjectType

    if formulation.project_type == ProjectType.READY_TO_GO.value:
        from apps.client_portal.api.project_stage import _rtg_payment_approved

        if not _rtg_payment_approved(formulation, proposals):
            return None

    copy = _PRODUCTION_PHASE_COPY.get(row.phase, {})
    # When a customer-driven routing request is live, override the
    # generic phase copy so the ProductionCard doesn't misleadingly
    # tell the customer "our logistics team is finalising the
    # carrier" while WE are actually waiting on THEIR routing pick.
    # The RoutingChoiceCard right below carries the actionable UI —
    # ProductionCard just needs to be honest about the state.
    routing_req = row.routing_request or None
    override_label, override_detail = _routing_request_phase_override(
        row.phase, routing_req
    )
    # Multi-visit pickup progress override — a shipment being drained
    # over multiple visits shouldn't read as "Awaiting carrier
    # pickup" while a truck has already loaded 1_000 of 9_500 units.
    # Only fires on the ``awaiting_pickup`` phase; other phases keep
    # their default copy.
    dispatch_progress = row.dispatch_progress or None
    dp_label, dp_detail = _dispatch_progress_phase_override(
        row.phase, dispatch_progress
    )
    if dp_label or dp_detail:
        override_label = dp_label or override_label
        override_detail = dp_detail or override_detail

    return {
        "phase": row.phase,
        "phase_label": override_label or copy.get("label") or row.phase_label or row.phase,
        "phase_detail": override_detail or copy.get("detail") or "",
        # Forward PSP's next-action fields raw — the FE renders them
        # under a "What our team is doing" heading. Empty when the
        # phase has no explicit next-action (terminal states).
        "next_action_title": row.next_action_title or "",
        "next_action_detail": row.next_action_detail or "",
        "blocker_count": row.blocker_count,
        # Sub-stage counters — the FE uses these to pick between
        # "PO drafting" / "PO ordered" / "PO delivered" sub-copy for
        # the ``awaiting_ingredients`` phase, and similar for later
        # phases. Everything defaults to 0 so the FE can null-safely
        # compare.
        "line_count": row.line_count,
        "mo_count": row.mo_count,
        "lines_awaiting_mo": row.lines_awaiting_mo,
        "mos_awaiting_po_send": row.mos_awaiting_po_send,
        "mos_awaiting_delivery": row.mos_awaiting_delivery,
        "mos_in_production": row.mos_in_production,
        "mos_awaiting_closeout": row.mos_awaiting_closeout,
        "psp_updated_at": _iso(row.psp_updated_at),
        "pushed_at": _iso(row.pushed_at),
        # Per-MO roadmap — the customer FE renders one 8-stage
        # stepper per production MO with substage progress and
        # timestamps. Empty list = still in earlier phase OR PSP push
        # predates the roadmap fields (backward compat).
        "manufacturing_orders": list(row.manufacturing_orders or []),
        # Customer-driven 3PL vs shipment routing decision. Present
        # only for bespoke NPD-formulation COs after at least one
        # output lot has reached ``awaiting_release``. Portal renders
        # the decision cards / status message off this.
        "routing_request": row.routing_request or None,
        # PSP CO uuid — passed back on ``POST routing-choice`` so the
        # portal doesn't have to plumb it separately.
        "psp_customer_order_uuid": row.psp_customer_order_uuid
        and str(row.psp_customer_order_uuid),
        # PSP dispatch snapshot + release documents for the CO
        # backing this bespoke formulation. Silent-degrade to
        # ``None`` / ``[]`` on any PSP failure — the portal FE hides
        # the corresponding cards in that case rather than showing
        # placeholders.
        "dispatch": _dispatch_for_formulation(formulation),
        "release_documents": _release_documents_for_formulation(formulation),
    }


def _dispatch_for_formulation(formulation):
    """Fetch the PSP dispatch snapshot for the CO backing this
    formulation. ``None`` when no shipment has reached
    ``partially_picked`` / ``picked_up`` / ``delivered`` yet — the
    portal hides the card until there's something meaningful to
    render.
    """

    row = getattr(formulation, "psp_production_status", None)
    if row is None or not row.psp_customer_order_uuid:
        return None
    organization = getattr(formulation, "organization", None)
    if organization is None:
        return None

    try:
        from apps.psp.services import get_psp_dispatch_for_co

        return get_psp_dispatch_for_co(
            organization=organization,
            co_uuid=row.psp_customer_order_uuid,
        )
    except Exception:
        return None


def _release_documents_for_formulation(formulation):
    """Fetch PSP's Final Product Release documents for the CO backing
    this formulation. Empty list on any PSP failure. Same shape as
    the sample-detail path so the portal FE can reuse its
    ``ReleaseDocumentsCard`` component.
    """

    row = getattr(formulation, "psp_production_status", None)
    if row is None or not row.psp_customer_order_uuid:
        return []
    organization = getattr(formulation, "organization", None)
    if organization is None:
        return []

    try:
        from apps.psp.services import list_psp_release_documents_for_co

        return list_psp_release_documents_for_co(
            organization=organization,
            co_uuid=row.psp_customer_order_uuid,
        ) or []
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Pipeline derivation — eight ordered stages
# ---------------------------------------------------------------------------


def _build_rtg_payment_stage(
    *,
    formulation: Formulation,
    proposals: list[Proposal],
    signed_proposal: Proposal | None,
    label_design: LabelDesign | None,
) -> dict:
    """RTG-only payment pipeline stage.

    Deliberately distinct from the Custom ``payment_stage`` because:

    * Custom's ``payment_stage`` gates on FINAL-kind payments that
      land AFTER the customer signs the final spec. RTG has no final
      spec, so the FINAL-kind check would leave the stage stuck at
      "future" forever.
    * The RTG proposal template inherits ``deposit_percent`` from the
      org default (often 50%), which means finance may record the
      customer's transfer as ``kind=DEPOSIT`` even when it covers the
      full order. Filtering on kind at all would drop those rows.

    We scope the payment lookup to Payments explicitly linked to this
    formulation's proposals (``Payment.proposal_id``). A formulation-
    wide check would count paid sample kits — those hit the same
    formulation but have ``proposal=None`` and represent a £30 sample
    order, not a full production run. The label-design workflow's
    "moved past ``PAYMENT_PENDING``" state is preserved as a second
    signal so a legacy cash deal (no Payment row wired to the
    proposal) still resolves to ``done``.
    """

    from apps.payments.constants import PaymentStatus
    from apps.payments.models import Payment

    proposal_ids = [p.id for p in proposals]
    approved_payment = None
    pending_payment = None
    if proposal_ids:
        approved_payment = (
            Payment.objects.filter(
                proposal_id__in=proposal_ids,
                status=PaymentStatus.APPROVED,
            )
            .order_by("-approved_at", "-created_at")
            .first()
        )
        pending_payment = (
            Payment.objects.filter(
                proposal_id__in=proposal_ids,
                status=PaymentStatus.PENDING,
            )
            .order_by("-created_at")
            .first()
        )
    if approved_payment is not None:
        return {
            "key": "payment",
            "label": "Payment received",
            "state": "done",
            "completed_at": _iso(approved_payment.approved_at),
            "detail": "Thank you. Label design and production are unlocked.",
        }
    # The Custom pipeline treats "label workflow past PAYMENT_PENDING"
    # as implicit proof of payment (legacy cash deals where finance
    # didn't record a Payment row). We deliberately DON'T apply that
    # heuristic here: on RTG a LabelDesign row from a prior code path
    # would falsely flip the payment stage to "done" while the invoice
    # hasn't actually been sent. Only a real APPROVED Payment on the
    # proposal counts — anything else is stale state that shouldn't
    # steer the customer's roadmap.
    if signed_proposal is None:
        return {
            "key": "payment",
            "label": "Payment",
            "state": "future",
            "completed_at": None,
            "detail": "After you sign the proposal, we'll send you the invoice.",
        }
    if pending_payment is not None:
        return {
            "key": "payment",
            "label": "Awaiting payment",
            "state": "current",
            "completed_at": None,
            "detail": (
                f"You signed the proposal. Your invoice for "
                f"{pending_payment.currency} {pending_payment.amount} "
                "is on our finance team's queue — we'll flip this the "
                "moment the transfer lands."
            ),
        }
    return {
        "key": "payment",
        "label": "Awaiting payment",
        "state": "current",
        "completed_at": None,
        "detail": (
            "You signed the proposal. Our finance team will send your "
            "invoice shortly — label design and production start the "
            "moment payment lands."
        ),
    }


def _build_pipeline(
    *,
    formulation: Formulation,
    proposals: list[Proposal],
    sheets: list[SpecificationSheet],
    validations: list[ProductValidation],
    label_design: LabelDesign | None,
    payment: Payment | None,
    cff: CFFSubmission | None,
) -> list[dict]:
    """Return the eight pipeline stages with ``done`` / ``current`` /
    ``future`` state.

    The "current" stage is the first one that isn't ``done`` —
    everything past that is ``future``. A skipped stage (e.g. no CFF
    if staff started the project directly) still appears but is
    marked ``done`` with a "Not applicable" note so the timeline
    visual stays the same length on every product card.
    """

    # ---- Stage 1: Request submitted -------------------------------------
    cff_done = cff is not None
    cff_submitted_at = (
        getattr(cff, "wix_created_date", None)
        or getattr(cff, "imported_at", None)
        if cff_done
        else None
    )
    request_stage = {
        "key": "request",
        "label": "Request submitted",
        "state": "done" if cff_done else "skipped",
        "completed_at": _iso(cff_submitted_at),
        "detail": (
            f"Custom formulation request submitted "
            f"{cff_submitted_at.strftime('%d %b %Y') if cff_submitted_at else ''}"
        ).strip()
        if cff_done
        else "Started by Vita directly — no formal request submitted.",
    }

    # ---- Stage 2: Draft spec signed -------------------------------------
    # Sits BEFORE proposal in the pipeline order — the customer commits
    # to the recipe first (does the science work?), then to the
    # commercial terms. That order also feeds the sequential
    # sign-gate on proposal_stage below: proposal cannot show as
    # "current" while a draft sits unsigned, so the customer never
    # sees two "current" chips at once.
    draft_signed = _first_signed(_draft_specs(sheets))
    draft_sent = _first_sent_unsigned(_draft_specs(sheets))
    if draft_signed is not None:
        draft_stage = {
            "key": "draft_spec",
            "label": "Draft specification signed",
            "state": "done",
            "completed_at": _iso(draft_signed.customer_signed_at),
            "detail": "You approved the draft recipe — the proposal is next.",
        }
    elif draft_sent is not None:
        draft_stage = {
            "key": "draft_spec",
            "label": "Draft specification awaiting signature",
            "state": "current",
            "completed_at": None,
            "detail": (
                f"Draft spec {draft_sent.code} is ready for you to review and sign."
            ),
        }
    else:
        draft_stage = {
            "key": "draft_spec",
            "label": "Draft specification",
            "state": "future",
            "completed_at": None,
            "detail": "Our scientists will draft the recipe and share it here.",
        }

    # ---- Stage 3: Proposal signed ---------------------------------------
    # Sequential gate: while a draft spec is ``sent`` (customer-visible)
    # but not signed, the proposal is treated as blocked — even if it
    # itself is ``sent``. Without this, both draft_stage AND
    # proposal_stage light up as "current" simultaneously, which is the
    # source of the "two chips highlighted at once" bug. Business
    # rule: sign the recipe first, then commit commercially.
    signed_proposal = _first_signed_proposal(proposals)
    sent_proposal = _first_sent_proposal(proposals)
    draft_blocks_proposal = draft_sent is not None
    if signed_proposal is not None:
        proposal_stage = {
            "key": "proposal",
            "label": "Proposal signed",
            "state": "done",
            "completed_at": _iso(signed_proposal.customer_signed_at),
            "detail": f"You signed proposal {signed_proposal.code}.",
        }
    elif sent_proposal is not None and not draft_blocks_proposal:
        proposal_stage = {
            "key": "proposal",
            "label": "Proposal awaiting signature",
            "state": "current",
            "completed_at": None,
            "detail": f"Proposal {sent_proposal.code} is ready for you to sign.",
        }
    elif sent_proposal is not None and draft_blocks_proposal:
        proposal_stage = {
            "key": "proposal",
            "label": "Proposal",
            "state": "future",
            "completed_at": None,
            "detail": (
                f"Sign draft spec {draft_sent.code} first — the proposal "
                "unlocks right after."
            ),
        }
    else:
        proposal_stage = {
            "key": "proposal",
            "label": "Proposal",
            "state": "future",
            "completed_at": None,
            "detail": "Once we've prepared a quote, you'll sign it here.",
        }

    # ---- Stage 3.5: Sample selection -----------------------------------
    # Sits between proposal-signed and deposit-paid. The customer
    # picks how many trial samples they want; the free allowance is
    # bundled with the deposit, extras are priced per-unit against
    # the org's SamplePricingConfig with tiered discounts. State:
    #
    #   * signed_proposal is None                 → future (waiting)
    #   * allocation.status == CONFIRMED          → done
    #   * signed_proposal exists, allocation draft → current
    #
    # The "current" state is what drives the picker card on both
    # portals. This stage never gets ``skipped`` — every project has
    # at LEAST the free-allowance decision to make, even if the
    # customer doesn't want to buy any extras. That decision has to
    # be actively confirmed so finance knows to invoice against the
    # right sample count.
    from apps.payments.models import (
        SampleAllocation as _SampleAllocation,
        SampleAllocationStatus as _SampleAllocationStatus,
    )

    sample_allocation = (
        _SampleAllocation.objects.filter(formulation=formulation).first()
    )
    if signed_proposal is None:
        sample_stage = {
            "key": "sample_selection",
            "label": "Sample selection",
            "state": "future",
            "completed_at": None,
            "detail": (
                "Once the proposal is signed, you'll choose how many "
                "trial samples to receive."
            ),
        }
    elif (
        sample_allocation is not None
        and sample_allocation.status == _SampleAllocationStatus.CONFIRMED
    ):
        qty = sample_allocation.quantity_ordered
        sample_stage = {
            "key": "sample_selection",
            "label": "Sample selection confirmed",
            "state": "done",
            "completed_at": (
                sample_allocation.confirmed_at.isoformat()
                if sample_allocation.confirmed_at
                else None
            ),
            "detail": (
                f"You chose {qty} trial sample"
                f"{'s' if qty != 1 else ''} — locked in and included on the "
                "deposit invoice."
            ),
        }
    else:
        sample_stage = {
            "key": "sample_selection",
            "label": "Choose your samples",
            "state": "current",
            "completed_at": None,
            "detail": (
                "Pick how many trial samples you want. The free allowance "
                "is bundled with the deposit; extras get priced on this "
                "page."
            ),
        }

    # ---- Stage 4.5: Deposit ---------------------------------------------
    # Sits AFTER sample-selection AND draft-spec sign in the pipeline
    # order — the real flow is "sign proposal (locks price/terms) →
    # sign draft spec (locks recipe) → choose samples → pay deposit
    # (which now bundles the sample cost) → trial batch (unlocked by
    # deposit)". The deposit copy still references the accepted
    # proposal because ``trial_batch_gate_status`` reads the accepted
    # proposal's deposit_percent — the recipe sign is a UX ordering,
    # not the gate's trigger. Skipped entirely when the accepted
    # proposal was quoted with 0% deposit (full amount rides the
    # final gate).  ``trial_batch_gate_status`` is the single source
    # of truth for the deposit state — same helper drives the
    # scientist banner + trial-batch service refusal.
    from apps.payments.services import trial_batch_gate_status

    deposit_gate = trial_batch_gate_status(formulation)
    if deposit_gate["reason"] == "no_proposal":
        deposit_stage = {
            "key": "deposit",
            "label": "Deposit",
            "state": "future",
            "completed_at": None,
            "detail": "Once you sign the proposal + draft spec, we'll send you the deposit invoice.",
        }
    elif deposit_gate["reason"] == "no_deposit_required":
        deposit_stage = {
            "key": "deposit",
            "label": "Deposit",
            "state": "skipped",
            "completed_at": None,
            "detail": "This proposal has no deposit — the full amount is due on final delivery.",
        }
    elif deposit_gate["reason"] == "deposit_paid":
        deposit_stage = {
            "key": "deposit",
            "label": "Deposit received",
            "state": "done",
            "completed_at": None,
            "detail": "Thank you. Trial batches are unlocked.",
        }
    else:  # deposit_pending
        percent = deposit_gate["deposit_percent"] or "0"
        proposal_code = deposit_gate["proposal_code"] or "the accepted proposal"
        # Sequential-order gate — the deposit stage must stay
        # ``future`` while sample-selection is still ``current``.
        # Without this, both chips light up simultaneously the
        # moment the customer signs the proposal (``trial_batch_
        # gate_status`` sees the signed proposal + no approved
        # deposit and returns ``deposit_pending``, while
        # sample_selection is also ``current`` because no
        # allocation is confirmed yet). Same "one chip lit at a
        # time" rule as the earlier draft-vs-proposal fix.
        sample_selection_still_current = (
            sample_stage["state"] == "current"
        )
        if sample_selection_still_current:
            deposit_stage = {
                "key": "deposit",
                "label": "Deposit",
                "state": "future",
                "completed_at": None,
                "detail": (
                    "Once you confirm your sample quantity, we'll "
                    "send you the deposit invoice (bundled with any "
                    "extras you chose)."
                ),
            }
        else:
            deposit_stage = {
                "key": "deposit",
                "label": "Deposit pending",
                "state": "current",
                "completed_at": None,
                "detail": (
                    f"Your {percent}% deposit on {proposal_code} hasn't landed with "
                    "our finance team yet. Trial production begins the moment it clears."
                ),
            }

    # ---- Stage 4: Trial batches -----------------------------------------
    # Cycle-driven when a :class:`TrialBatchCycle` exists (custom
    # formulations, post-deposit). Falls back to the legacy
    # ProductValidation-based state for projects that pre-date the
    # cycle model + for ready-to-go projects that skip trial batches
    # entirely.
    from apps.trial_batches.models import (
        TrialBatchCycle,
        TrialBatchCycleStatus,
        TrialBatchSlotStatus,
    )

    cycle = TrialBatchCycle.objects.filter(formulation=formulation).first()
    if cycle is not None:
        used = cycle.slots.count()
        satisfied = cycle.slots.filter(
            status=TrialBatchSlotStatus.CLOSED_SATISFIED,
        ).first()
        remaining_open = cycle.slots.filter(
            status__in=(
                TrialBatchSlotStatus.AWAITING_SCIENTIST,
                TrialBatchSlotStatus.IN_PRODUCTION,
                TrialBatchSlotStatus.SHIPPED,
                TrialBatchSlotStatus.DELIVERED,
                TrialBatchSlotStatus.FEEDBACK_PENDING,
            )
        ).count()
        # Trial-batch stage completes only when the CUSTOMER has
        # signed off. SATISFIED (verdict path) is a customer signal
        # by definition. TERMINATED_BY_TEAM alone isn't — the team
        # can close the cycle but the customer still owes an answer
        # via the portal's terminal-choice prompt ("more or done").
        # Gate on ``customer_confirmed_done_at`` for the team-close
        # branch so the pipeline holds until they answer.
        team_closed_and_customer_confirmed = (
            cycle.status == TrialBatchCycleStatus.TERMINATED_BY_TEAM
            and cycle.customer_confirmed_done_at is not None
        )
        # Roadmap label is a plain "Trial batches" across every
        # sub-state — the accurate slot counts live on the trial-
        # batch card below and previously trying to embed them in
        # the stage label produced misleading numbers because the
        # cycle can have historical previous-run slots, cancelled
        # slots, and a display offset that all had to be reconciled
        # per branch. The detail line still names the sub-state so
        # a customer skimming the roadmap knows where they are.
        if (
            (
                cycle.status == TrialBatchCycleStatus.SATISFIED
                or team_closed_and_customer_confirmed
            )
            and remaining_open == 0
        ):
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "done",
                "completed_at": (
                    _iso(cycle.closed_at)
                    if cycle.closed_at is not None
                    else _iso(cycle.updated_at)
                ),
                "detail": (
                    "Final specification incoming — sign it to authorise "
                    "full production."
                ),
            }
        elif cycle.status == TrialBatchCycleStatus.MAX_REACHED:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "current",
                "completed_at": None,
                "detail": (
                    "You've received every sample you paid for. Confirm "
                    "you're happy or request another sample."
                ),
            }
        elif (
            cycle.status == TrialBatchCycleStatus.TERMINATED_BY_TEAM
            and cycle.customer_confirmed_done_at is None
        ):
            # Team-closed but the customer hasn't answered "more or
            # done" yet — same "waiting on you" posture as
            # MAX_REACHED, but the copy names the team-close so the
            # customer isn't confused about how the cycle ended.
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "current",
                "completed_at": None,
                "detail": (
                    "Our team closed your trial-batch run. Let us know "
                    "if you'd like more samples or you're happy to move "
                    "on to the final specification."
                ),
            }
        else:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "current",
                "completed_at": None,
                "detail": (
                    "We're producing your samples one at a time. Give "
                    "feedback on each and we'll iterate until it's right."
                ),
            }
    else:
        passed_validation = next(
            (v for v in validations if v.status == ValidationStatus.PASSED), None
        )
        failed_validation = next(
            (v for v in validations if v.status == ValidationStatus.FAILED), None
        )
        in_progress_validation = next(
            (v for v in validations if v.status == ValidationStatus.IN_PROGRESS),
            None,
        )
        if passed_validation is not None:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "done",
                "completed_at": _iso(passed_validation.updated_at),
                "detail": "Quality checks all passed — final specification incoming.",
            }
        elif failed_validation is not None:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "current",
                "completed_at": None,
                "detail": "Our team is investigating the failure and will be in touch.",
            }
        elif in_progress_validation is not None:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "current",
                "completed_at": None,
                "detail": "We're producing a trial batch and running quality checks.",
            }
        else:
            trial_stage = {
                "key": "trial",
                "label": "Trial batches",
                "state": "future",
                "completed_at": None,
                "detail": "Once the draft spec is signed, we'll produce a trial batch.",
            }

    # ---- Stage 5: Final spec signed -------------------------------------
    final_signed = _first_signed(_final_specs(sheets))
    final_sent = _first_sent_unsigned(_final_specs(sheets))
    # Bridge state: trial-batch stage completed but our team hasn't
    # prepared the final spec yet. Without this the roadmap looks
    # frozen — trial is ``done`` but final_spec sits at ``future``
    # and the customer feels stuck. Marking final_spec ``current``
    # with a "we're preparing it" copy shows the pipeline still
    # advancing, and the label flips to "awaiting signature" the
    # moment we send the spec.
    trial_is_done = trial_stage.get("state") == "done"
    if final_signed is not None:
        final_stage = {
            "key": "final_spec",
            "label": "Final specification signed",
            "state": "done",
            "completed_at": _iso(final_signed.customer_signed_at),
            "detail": "You authorised production. Label design unlocks next.",
        }
    elif final_sent is not None:
        final_stage = {
            "key": "final_spec",
            "label": "Final specification awaiting signature",
            "state": "current",
            "completed_at": None,
            "detail": (
                f"Final spec {final_sent.code} is ready — signing authorises production."
            ),
        }
    elif trial_is_done:
        final_stage = {
            "key": "final_spec",
            "label": "Final specification — our team is preparing it",
            "state": "current",
            "completed_at": None,
            "detail": (
                "Trial batches complete. Our team is now writing your final "
                "specification based on the recipe you approved. We'll email "
                "you the moment it's ready to sign."
            ),
        }
    else:
        final_stage = {
            "key": "final_spec",
            "label": "Final specification",
            "state": "future",
            "completed_at": None,
            "detail": "After a successful trial, we'll prepare the final spec.",
        }

    # ---- Stage 6: Payment approved -------------------------------------
    # ``payment`` is the FINAL-kind payment resolved earlier in this
    # function. Once the customer signs the FINAL spec, the sign hook
    # auto-creates a Payment(kind=FINAL, status=PENDING); finance
    # approves it via the standard queue. Stage flow:
    #   spec-not-signed → future
    #   signed, payment pending → "Awaiting payment approval"
    #   payment approved → "Payment received"
    if payment is not None and payment.status == PaymentStatus.APPROVED:
        payment_stage = {
            "key": "payment",
            "label": "Payment received",
            "state": "done",
            "completed_at": _iso(payment.approved_at),
            "detail": "Thank you. Label design is unlocked.",
        }
    elif (
        label_design is not None
        and label_design.status != LabelDesignStatus.PAYMENT_PENDING
    ):
        # Label workflow has moved past payment — the payment must
        # have been recorded internally even if we don't have the row
        # surfaced (e.g. legacy cash deals).
        payment_stage = {
            "key": "payment",
            "label": "Payment received",
            "state": "done",
            "completed_at": None,
            "detail": "Payment recorded — label design has begun.",
        }
    elif payment is not None and payment.status == PaymentStatus.PENDING:
        # FINAL spec signed → auto-created Payment sits on finance
        # queue. Customer's next state is a hold — nothing for them
        # to do until finance approves. Copy names the invoice
        # amount + the fact that our finance team owns the next
        # step so the customer isn't confused about being idle.
        payment_stage = {
            "key": "payment",
            "label": "Awaiting payment approval",
            "state": "current",
            "completed_at": None,
            "detail": (
                f"You signed the final specification. Our finance "
                f"team is reviewing your invoice ({payment.currency} "
                f"{payment.amount}) — we'll email you the moment "
                f"it's approved and label design unlocks."
            ),
        }
    elif label_design is not None:
        payment_stage = {
            "key": "payment",
            "label": "Awaiting payment",
            "state": "current",
            "completed_at": None,
            "detail": "Our finance team will confirm your payment shortly.",
        }
    else:
        payment_stage = {
            "key": "payment",
            "label": "Payment",
            "state": "future",
            "completed_at": None,
            "detail": "Payment is recorded after the final spec is signed.",
        }

    # ---- Stage 7: Label design -----------------------------------------
    if label_design is None:
        label_stage = {
            "key": "label",
            "label": "Label design",
            "state": "future",
            "completed_at": None,
            "detail": "Once payment lands, we'll start label design with you.",
        }
    elif label_design.status == LabelDesignStatus.LABEL_APPROVED:
        label_stage = {
            "key": "label",
            "label": "Label approved",
            "state": "done",
            "completed_at": _iso(label_design.customer_approved_at),
            "detail": "Label artwork is locked. Production planning starts now.",
        }
    elif label_design.status == LabelDesignStatus.CUSTOMER_APPROVAL:
        label_stage = {
            "key": "label",
            "label": "Label awaiting your approval",
            "state": "current",
            "completed_at": None,
            "detail": "Our team has signed off — review and sign the artwork.",
        }
    elif label_design.status == LabelDesignStatus.LABEL_PATH_PENDING:
        label_stage = {
            "key": "label",
            "label": "Label design — pick a path",
            "state": "current",
            "completed_at": None,
            "detail": "Choose whether Vita designs the label for you or you design it yourself.",
        }
    elif label_design.status == LabelDesignStatus.DESIGN_PREFERENCES_PENDING:
        label_stage = {
            "key": "label",
            "label": "Label design — your brief needed",
            "state": "current",
            "completed_at": None,
            "detail": "Share brand colours, style, and inspirational examples.",
        }
    elif label_design.status == LabelDesignStatus.ON_HOLD:
        label_stage = {
            "key": "label",
            "label": "Label design on hold",
            "state": "current",
            "completed_at": None,
            "detail": "Our team has paused the workflow — we'll be in touch.",
        }
    elif label_design.status == LabelDesignStatus.PAYMENT_PENDING:
        # Label design exists but hasn't started — payment is the
        # gate. Surface this as ``future`` so it doesn't show as
        # "current" alongside the actually-current Payment stage.
        label_stage = {
            "key": "label",
            "label": "Label design",
            "state": "future",
            "completed_at": None,
            "detail": "Label design unlocks once payment is confirmed.",
        }
    else:
        # In design / scientist review / director review.
        label_stage = {
            "key": "label",
            "label": "Label design in progress",
            "state": "current",
            "completed_at": None,
            "detail": "We're producing the artwork and running compliance checks.",
        }

    # ---- Stage 8: Production -------------------------------------------
    # Production runs in PARALLEL with label design once FINAL payment
    # is approved — the shop floor doesn't wait for a signed label to
    # start manufacturing (the label is applied at closeout / release
    # inspection, not during blending). The pipeline exposes this to
    # the customer by tagging both stages with the same
    # ``parallel_group`` value; the FE renders them bracketed under a
    # shared step number with a "running in parallel" note.
    production_status = getattr(formulation, "psp_production_status", None)
    production_phase = getattr(production_status, "phase", "") or ""
    production_started = production_phase not in ("", "delivered", "cancelled")
    production_done_terminal = production_phase == "delivered"
    if production_done_terminal:
        production_stage = {
            "key": "production",
            "label": "Production complete",
            "state": "done",
            "completed_at": _iso(getattr(production_status, "pushed_at", None)),
            "detail": "Your batch has been delivered.",
        }
    elif production_started:
        # PSP is actively working on it — show the live phase label.
        phase_copy = _PRODUCTION_PHASE_COPY.get(production_phase, {})
        # Custom-formulation routing gate: override the generic phase
        # copy when a customer-driven routing request is live, so the
        # pipeline stage doesn't misleadingly say "logistics team is
        # finalising" while WE are actually waiting on the customer's
        # 3PL vs Direct pick.
        routing_req = getattr(production_status, "routing_request", None)
        override_label, override_detail = _routing_request_phase_override(
            production_phase, routing_req
        )
        production_stage = {
            "key": "production",
            "label": override_label
            or phase_copy.get("label")
            or getattr(production_status, "phase_label", "")
            or "Production in progress",
            "state": "current",
            "completed_at": None,
            "detail": override_detail
            or phase_copy.get("detail")
            or "Your batch is being manufactured.",
        }
    else:
        # Not started — either awaiting FINAL sign-off or PSP hasn't
        # pushed yet.
        production_stage = {
            "key": "production",
            "label": "Production",
            "state": "future",
            "completed_at": None,
            "detail": (
                "Once your final invoice is settled, production planning "
                "kicks off alongside label design — the two run in parallel."
            ),
        }

    # Tag label + production as a concurrent pair. The FE reads this
    # to bracket the two stages under one step number with a
    # "running in parallel" indicator so the customer doesn't read
    # the pipeline as "label first, then production".
    label_stage["parallel_group"] = "manufacturing"
    production_stage["parallel_group"] = "manufacturing"

    # Stage order — real business flow, not schema order:
    #   draft spec signed (recipe committed) → proposal signed
    #   (commercial committed) → deposit paid → trial batch → final
    #   spec signed → payment → label → production.
    #
    # Two reorders landed here across time:
    #   1. Deposit moved AFTER commitment — previously deposit sat
    #      between proposal and draft-spec, reading to customers as
    #      "pay before you've even seen the recipe".
    #   2. Draft spec moved BEFORE proposal — customers were seeing
    #      both proposal AND draft-spec chips as "current" at once,
    #      because both status=sent+unsigned rows independently mapped
    #      to "current". Sequential order (recipe first, then
    #      commercial) means only one chip lights up at a time, and
    #      matches the "science works?" → "am I buying it?" mental
    #      model. proposal_stage above enforces this with a
    #      ``draft_blocks_proposal`` gate that keeps proposal in
    #      ``future`` while the draft sits unsigned.
    #
    # Ready-to-Go orders are a purpose-built subset of the Custom
    # flow: no R&D request (customer picks off the storefront), no
    # draft spec sign (the recipe is a director-signed template we
    # clone per order), no sample selection, no deposit-vs-final
    # payment split (the customer pays the whole order up front), no
    # trial batches, no final-spec sign. What's left is:
    #
    #     1. Proposal signed
    #     2. Payment received
    #     3. Label design  ┐  concurrent — both start the moment
    #     4. Production    ┘  finance confirms the payment
    #
    # We swap in an RTG-specific payment_stage that reads any approved
    # Payment on the formulation (not just kind=FINAL) so DEPOSIT
    # entries the finance team records for RTG orders still count as
    # "paid". Then we clamp the label + production stages to ``future``
    # while payment is unpaid — otherwise a PSP CO auto-created at
    # checkout time (long before the customer signs anything) would
    # push production_stage to ``current`` and the pipeline would read
    # "we're manufacturing" while the invoice still sits unpaid.
    if formulation.project_type == ProjectType.READY_TO_GO.value:
        rtg_payment_stage = _build_rtg_payment_stage(
            formulation=formulation,
            proposals=proposals,
            signed_proposal=signed_proposal,
            label_design=label_design,
        )
        payment_done = rtg_payment_stage["state"] == "done"
        if not payment_done:
            # Both replacement dicts MUST carry ``parallel_group`` —
            # the ``label_stage``/``production_stage`` tagging above
            # (see ``label_stage["parallel_group"] = "manufacturing"``)
            # runs against the pre-clamped dicts, and a bare rebuild
            # here drops the pair marker. Without the tag the FE
            # ``RoadmapCard`` fold-loop treats each row as its own
            # numbered step ("3. Label design", "4. Production")
            # instead of bracketing them under one "Running in
            # parallel" step. Kept alongside the tagging above so
            # both stages carry the same value.
            if label_stage["state"] == "current":
                label_stage = {
                    "key": "label",
                    "label": "Label design",
                    "state": "future",
                    "completed_at": None,
                    "detail": "Label design unlocks the moment your payment is confirmed.",
                    "parallel_group": "manufacturing",
                }
            if production_stage["state"] == "current":
                production_stage = {
                    "key": "production",
                    "label": "Production",
                    "state": "future",
                    "completed_at": None,
                    "detail": "Production planning kicks off alongside label design once payment lands.",
                    "parallel_group": "manufacturing",
                }
        return [
            proposal_stage,
            rtg_payment_stage,
            label_stage,
            production_stage,
        ]

    return [
        request_stage,
        draft_stage,
        proposal_stage,
        sample_stage,
        deposit_stage,
        trial_stage,
        final_stage,
        payment_stage,
        label_stage,
        production_stage,
    ]


# ---------------------------------------------------------------------------
# Documents + timeline
# ---------------------------------------------------------------------------


def _build_next_action(
    *,
    formulation: Formulation,
    proposals: list[Proposal],
    sheets: list[SpecificationSheet],
    label_design: LabelDesign | None,
) -> dict | None:
    """The single "what do I do next?" action for the customer.

    Returns ``{label, url, subtitle, urgency}`` when the workflow is
    waiting on the customer, else ``None`` (meaning the customer can
    relax — Vita is doing the work). Powers the big universal CTA at
    the top of the per-product page.

    Resolution order matches the stepper's reverse-walk: the most
    advanced "current" stage wins, so a customer with both an unsigned
    proposal AND a customer-approval-pending label sees the label
    action (which is the actual blocker on the most recent stage).
    """

    # Label-design takes precedence — it's the latest stage and
    # carries the most blocking sub-states.
    if label_design is not None:
        if label_design.status == LabelDesignStatus.CUSTOMER_APPROVAL:
            return {
                "label": "Approve your label",
                "subtitle": "Review the artwork and sign to release for production.",
                "url": f"/portal/label-designs/{label_design.id}/approve",
                "urgency": "high",
            }
        if label_design.status == LabelDesignStatus.LABEL_PATH_PENDING:
            return {
                "label": "Choose how the label will be designed",
                "subtitle": "Pick Vita's team or design it yourself.",
                "url": f"/portal/label-designs/{label_design.id}/choose-path",
                "urgency": "medium",
            }
        if label_design.status == LabelDesignStatus.DESIGN_PREFERENCES_PENDING:
            return {
                "label": "Share your design brief",
                "subtitle": "Brand colours, style, inspiration — anything we should know.",
                "url": f"/portal/label-designs/{label_design.id}/preferences",
                "urgency": "medium",
            }
        if (
            label_design.status == LabelDesignStatus.DESIGN_IN_PROGRESS
            and label_design.design_path == LabelDesignPath.DESIGN_BY_CUSTOMER
        ):
            return {
                "label": "Upload your finished label",
                "subtitle": "Drop in the PDF or PNG you designed.",
                "url": f"/portal/label-designs/{label_design.id}/upload",
                "urgency": "medium",
            }

    is_ready_to_go = (
        formulation.project_type == ProjectType.READY_TO_GO.value
    )

    # RTG-only: the customer signs the PROPOSAL, not a draft spec
    # (the spec is a director-signed template we clone at checkout).
    # Surface the sign-proposal CTA up here so the detail page's top
    # action card matches the actions queue on the dashboard header.
    # Custom projects walk their own draft-spec sign step below so
    # they never hit this branch.
    if is_ready_to_go:
        rtg_sent_proposal = next(
            (
                p
                for p in proposals
                if p.status == "sent" and p.customer_signed_at is None
            ),
            None,
        )
        if rtg_sent_proposal is not None:
            return {
                "label": "Sign your proposal",
                "subtitle": (
                    "Read through the order details and sign to authorise "
                    "your invoice."
                ),
                "url": f"/portal/proposals/{rtg_sent_proposal.id}",
                "urgency": "high",
            }

    # Final spec waiting for signature. Ready-to-go projects never
    # produce a final spec (the draft is the contract), so skip this
    # branch — anything unsigned in `_final_specs(sheets)` on a RTG
    # project is stale state that should not resurface as the next
    # action.
    if not is_ready_to_go:
        final_sent = _first_sent_unsigned(_final_specs(sheets))
        if final_sent is not None:
            return {
                "label": "Sign your final specification",
                "subtitle": "Your trial passed — sign to authorise production.",
                "url": f"/portal/specs/{final_sent.id}",
                "urgency": "high",
            }

    # Draft spec waiting for signature. For a ready-to-go project the
    # draft signature unlocks payment directly (no trial batch), so
    # word the subtitle appropriately.
    draft_sent = _first_sent_unsigned(_draft_specs(sheets))
    if draft_sent is not None:
        return {
            "label": "Sign the draft specification",
            "subtitle": (
                "Approve the recipe to unlock payment and label design."
                if is_ready_to_go
                else "Approve the recipe so we can produce a trial batch."
            ),
            "url": f"/portal/specs/{draft_sent.id}",
            "urgency": "high",
        }

    # Sample selection is intentionally NOT emitted as a
    # ``next_action`` even though it's a customer-blocking stage —
    # both portals mount a dedicated ``SampleSelectionCard`` on the
    # base project page (renders inline when the pipeline flags the
    # stage as ``current``). Emitting a next_action here too would
    # stack a redundant "Needs your attention" banner on top of the
    # card, and the two would say the same thing. Same rationale as
    # the deposit-stage branch below. FE short-circuits render of
    # NextActionCard / NoActionCard when ``current.key ==
    # "sample_selection"`` so the sample card owns the moment.
    #
    # We DO still need to skip the proposal-review branch below when
    # a signed proposal exists — the proposal FSM keeps
    # ``status = sent`` after ``customer_signed_at`` is set, so a
    # signed proposal still matches ``_first_sent_proposal``. Without
    # this early return we'd tell the customer to review a proposal
    # they've already signed.
    if _first_signed_proposal(proposals) is not None:
        return None

    # Proposal waiting for signature.
    sent_proposal = _first_sent_proposal(proposals)
    if sent_proposal is not None:
        return {
            "label": "Review your proposal",
            "subtitle": f"Open proposal {sent_proposal.code} to read it through — you sign on the next step.",
            # Deep-link to the base proposal page — both portals
            # handle signing inline (web-site scrolls to the acks +
            # sign card; NPD opens the signature dialog from the
            # "Continue to signing" affordance). The old ``/sign``
            # suffix was an NPD-era standalone route; the web-site
            # portal never had that page, so a proposal
            # ``next_action`` click was 404-ing there.
            "url": f"/portal/proposals/{sent_proposal.id}",
            "urgency": "high",
        }

    # Deposit gate is intentionally NOT emitted as a next_action. Payment
    # happens off-platform (bank transfer / card), so there's no useful
    # destination for a CTA button. The ``NoActionBanner`` on the product
    # page has a dedicated informational "Waiting for deposit" card that
    # fires when ``next_action`` is null and the pipeline stage is
    # ``deposit`` — that's the right surface for a purely informative
    # message.
    return None


def _build_documents(
    *,
    proposals: list[Proposal],
    sheets: list[SpecificationSheet],
    label_design: LabelDesign | None,
    label_designs_all: list[LabelDesign] | None = None,
) -> list[dict]:
    """Every signed / submitted document on this project, newest-first.

    Spec-sheet visibility rule: a spec only appears when the customer
    can actually open it. That means at least one of:

    * The sheet is attached to a ``ProposalLine`` on a proposal the
      customer owns AND that proposal has been ``sent`` /
      ``accepted`` / ``declined`` (i.e. the customer has been shown
      the deal). Draft / in-review proposals stay internal, so their
      bundled specs stay internal.
    * The legacy 1-to-1 ``Proposal.specification_sheet`` FK points at
      the sheet on a proposal in one of those same statuses.
    * ``customer_signed_at`` is populated (the customer has already
      signed — belt-and-braces for the FINAL-spec-post-signature
      case; keeps the paper trail on the portal even if the parent
      proposal is later rolled back).

    Without this gate, an ``approved`` spec (signed off internally,
    not yet on a sent proposal) appeared in the docs list on the
    project page but the ``SpecDetailView`` refused to render it
    (its ownership walks through ``ProposalLine``), so clicking the
    entry 404'd. Customers saw a link they couldn't open. This
    matches the "block until proposal is sent" ask on the portal.
    """

    # ``proposals`` is already scoped to those the customer owns
    # (via ``proposals_covering_formulation`` in the caller). Rebuild
    # a set of ids we treat as "shown to customer" — sent / accepted
    # / declined all count; draft / in_review stay internal.
    _CUSTOMER_VISIBLE_PROPOSAL_STATUSES = ("sent", "accepted", "declined")
    customer_visible_proposal_ids = {
        p.id
        for p in proposals
        if p.status in _CUSTOMER_VISIBLE_PROPOSAL_STATUSES
    }

    # A document is "the team has committed to it" once it leaves
    # the internal pipeline — i.e. anything past DRAFT / IN_REVIEW.
    # That covers APPROVED (signed off internally, ready to send),
    # SENT, ACCEPTED, and REJECTED. We surface rejected rows too so
    # the customer keeps a paper trail of every proposal/spec we
    # ever put in front of them.
    INTERNAL_ONLY_STATUSES = ("draft", "in_review")

    out: list[dict] = []
    for proposal in proposals:
        if proposal.status in INTERNAL_ONLY_STATUSES:
            continue
        out.append(
            {
                "kind": "proposal",
                "label": f"Proposal {proposal.code}",
                "status": proposal.status,
                "signed_at": _iso(proposal.customer_signed_at),
                "url": f"/portal/proposals/{proposal.id}",
            }
        )

    # Pre-compute the set of sheet ids reachable via a
    # customer-visible proposal (line-attachment path OR legacy 1:1).
    # A single query per path is cheaper than an N-per-sheet walk and
    # matches the ownership resolution SpecDetailView / SpecPdfView
    # perform at click time.
    if customer_visible_proposal_ids:
        from apps.proposals.models import Proposal as _Proposal
        from apps.proposals.models import ProposalLine as _ProposalLine

        line_sheet_ids: set = set(
            _ProposalLine.objects.filter(
                proposal_id__in=customer_visible_proposal_ids,
                specification_sheet__isnull=False,
            ).values_list("specification_sheet_id", flat=True)
        )
        legacy_sheet_ids: set = set(
            _Proposal.objects.filter(
                id__in=customer_visible_proposal_ids,
                specification_sheet__isnull=False,
            ).values_list("specification_sheet_id", flat=True)
        )
        customer_visible_sheet_ids = line_sheet_ids | legacy_sheet_ids
    else:
        customer_visible_sheet_ids = set()

    for sheet in sheets:
        if sheet.status in INTERNAL_ONLY_STATUSES:
            continue
        # Three doors to customer-visible:
        #   1. Already signed (paper trail — always shown).
        #   2. Attached to a customer-visible proposal via a
        #      ProposalLine / legacy 1:1 FK.
        #   3. FINAL kind that's been sent to the portal (or later).
        #      FINALs are standalone — never bundled onto a proposal —
        #      so door #2 always misses them. Without this door the
        #      customer sees the "Sign your final specification"
        #      next-action banner but the sheet doesn't appear in
        #      Documents, and they have nowhere to click to open it.
        already_signed = sheet.customer_signed_at is not None
        proposal_attached = sheet.id in customer_visible_sheet_ids
        final_sent_to_portal = (
            sheet.document_kind == SpecificationDocumentKind.FINAL
            and sheet.status
            in (
                SpecificationStatus.SENT.value,
                SpecificationStatus.ACCEPTED.value,
                SpecificationStatus.REJECTED.value,
            )
        )
        if not already_signed and not proposal_attached and not final_sent_to_portal:
            continue
        kind_label = (
            "Final specification"
            if sheet.document_kind == SpecificationDocumentKind.FINAL
            else "Draft specification"
        )
        out.append(
            {
                "kind": f"spec_{sheet.document_kind}",
                "label": f"{kind_label} · {sheet.code or sheet.id.hex[:8]}",
                "status": sheet.status,
                "signed_at": _iso(sheet.customer_signed_at),
                "url": f"/portal/specs/{sheet.id}",
            }
        )
    # Label-design entries — one per label-design row. Multi-spec
    # projects have one workflow per spec, and the customer needs a
    # door into each (choose-path, preferences, upload, approve).
    # Pre-multi-spec callers that only pass ``label_design`` still
    # get a single entry via the fallback below.
    label_design_list = (
        list(label_designs_all)
        if label_designs_all is not None
        else ([label_design] if label_design is not None else [])
    )
    for ld in label_design_list:
        spec_code = (
            ld.specification_sheet.code if ld.specification_sheet else ""
        )
        # Multi-spec projects suffix the spec code so the customer
        # can tell which artwork each row drives. Single-spec /
        # legacy rows stay as the bare "Label design" label.
        label = "Label design"
        if spec_code and len(label_design_list) > 1:
            label = f"Label design · {spec_code}"
        out.append(
            {
                "kind": "label_workflow",
                "label": label,
                "status": ld.status,
                "signed_at": _iso(ld.customer_approved_at),
                "url": f"/portal/label-designs/{ld.id}",
            }
        )
    out.sort(key=lambda d: d["signed_at"] or "", reverse=True)
    return out


def _build_timeline(
    *,
    proposals: list[Proposal],
    sheets: list[SpecificationSheet],
    label_design: LabelDesign | None,
) -> list[dict]:
    """Unified activity feed across every transition row."""

    feed: list[dict] = []

    for transition in ProposalStatusTransition.objects.filter(
        proposal__in=proposals
    ).select_related("proposal"):
        feed.append(
            {
                "kind": "proposal_transition",
                "title": (
                    f"Proposal {transition.proposal.code}: "
                    f"{transition.from_status} → {transition.to_status}"
                ),
                "notes": transition.notes or "",
                "created_at": transition.created_at.isoformat(),
            }
        )

    for transition in SpecificationTransition.objects.filter(
        sheet__in=sheets
    ).select_related("sheet"):
        feed.append(
            {
                "kind": "spec_transition",
                "title": (
                    f"Spec {transition.sheet.code or transition.sheet_id.hex[:8]}: "
                    f"{transition.from_status} → {transition.to_status}"
                ),
                "notes": transition.notes or "",
                "created_at": transition.created_at.isoformat(),
            }
        )

    if label_design is not None:
        for transition in LabelDesignTransition.objects.filter(
            label_design=label_design
        ):
            feed.append(
                {
                    "kind": "label_transition",
                    "title": (
                        f"Label workflow: "
                        f"{transition.from_status or 'new'} → {transition.to_status}"
                    ),
                    "notes": transition.notes or "",
                    "created_at": transition.created_at.isoformat(),
                }
            )

    feed.sort(key=lambda f: f["created_at"], reverse=True)
    return feed


# ---------------------------------------------------------------------------
# View
# ---------------------------------------------------------------------------


class PortalProductDetailView(PortalAPIView):
    """``GET /api/portal/products/<formulation_id>/`` — pipeline +
    documents + timeline for a single project the customer owns."""

    def get(self, request: Request, formulation_id) -> Response:
        from apps.client_portal.queries import (
            customer_ids_for_account,
            customer_owns_formulation,
            proposals_covering_formulation,
        )

        # Union of every Customer id the account can read through —
        # the FK target plus any sibling rows sharing the email so
        # an existing dupe pair doesn't hide a project from its
        # rightful owner.
        customer_ids = customer_ids_for_account(request.user)

        # Ownership: at least one proposal across the union covers
        # this formulation — anchor OR via a line. Without the line
        # walk, a customer owning a multi-project proposal would
        # 404 on every non-anchor project's detail page.
        if not customer_owns_formulation(
            customer_ids=customer_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = get_object_or_404(Formulation, id=formulation_id)

        proposals = list(
            proposals_covering_formulation(
                customer_ids=customer_ids, formulation_id=formulation_id,
            ).select_related("formulation_version")
        )
        sheets = list(
            SpecificationSheet.objects.filter(
                formulation_version__formulation_id=formulation_id
            )
            .select_related("formulation_version")
            .order_by("-updated_at")
        )
        validations = list(
            ProductValidation.objects.filter(
                trial_batch__formulation_version__formulation_id=formulation_id,
            ).order_by("-updated_at")
        )
        # Multi-spec projects carry multiple label-design rows.
        # The helpers below were designed against the 1:1 model so
        # we keep them stable by featuring the "most-blocking" row
        # (the least-advanced status, which is whichever spec is
        # waiting on the customer the loudest). The dashboard's
        # action queue + the documents list still surface every
        # row individually so nothing gets hidden.
        label_designs_all = list(
            LabelDesign.objects.filter(formulation_id=formulation_id)
            .select_related("specification_sheet")
            .order_by("created_at")
        )

        # Status priority — lower number wins as the "feature"
        # row. Order mirrors the customer's mental "what blocks
        # me next?": approve > customer brief > path > waiting on
        # us > done.
        _STATUS_BLOCK_PRIORITY: dict[str, int] = {
            LabelDesignStatus.CUSTOMER_APPROVAL: 0,
            LabelDesignStatus.LABEL_PATH_PENDING: 1,
            LabelDesignStatus.DESIGN_PREFERENCES_PENDING: 2,
            LabelDesignStatus.PAYMENT_PENDING: 3,
            LabelDesignStatus.DESIGN_IN_PROGRESS: 4,
            LabelDesignStatus.SCIENTIST_REVIEW: 5,
            LabelDesignStatus.DIRECTOR_REVIEW: 6,
            LabelDesignStatus.ON_HOLD: 7,
            LabelDesignStatus.LABEL_APPROVED: 8,
        }
        label_design = (
            min(
                label_designs_all,
                key=lambda ld: _STATUS_BLOCK_PRIORITY.get(ld.status, 99),
            )
            if label_designs_all
            else None
        )
        # Stage 6 ("Payment received") represents the FINAL payment
        # gate that lands AFTER final-spec sign — not the bundled
        # deposit+samples Payment (kind=DEPOSIT) or the mid-cycle
        # additional-samples top-ups (kind=ADDITIONAL_SAMPLES). The
        # deposit is handled by its own stage via
        # ``trial_batch_gate_status``; approving it must not light
        # up the Payment stage prematurely.
        #
        # Include PENDING alongside APPROVED so the "Awaiting payment
        # approval" branch in ``_build_pipeline`` actually sees the
        # row — otherwise a customer who just signed a FINAL sees
        # the payment stage sit at "future" until finance approves,
        # even though the invoice is already on the finance queue.
        # ``-created_at`` ordering surfaces the newest row so a
        # VOIDED-then-recreated cycle picks the current one.
        payment = (
            Payment.objects.filter(
                formulation_id=formulation_id,
                status__in=(
                    PaymentStatus.APPROVED,
                    PaymentStatus.PENDING,
                ),
                kind=PaymentKind.FINAL,
            )
            .order_by("-created_at")
            .first()
        )
        # CFFSubmission timestamps come from Wix as ``wix_created_date``
        # (the customer-side submit time) and ``imported_at`` (when our
        # poller mirrored the row). We sort on the former so the FIRST
        # submission the customer ever sent surfaces in the pipeline.
        cff = (
            CFFSubmission.objects.filter(
                submitter_email__iexact=request.user.email
            )
            .order_by("wix_created_date")
            .first()
        )

        from apps.client_portal.queries import formulation_display_name

        return Response(
            {
                "product": {
                    "id": str(formulation.id),
                    "code": formulation.code,
                    # Customer-friendly title. On RTG this prefers
                    # ``rtg_display_name`` ("Ultimate Fat Burner Drink")
                    # over the internal SKU code ("RTG00001"). Falls
                    # back through name → code → placeholder so the
                    # header never renders empty.
                    "name": formulation_display_name(formulation),
                    "project_status": formulation.project_status,
                    "created_at": _iso(formulation.created_at),
                    "updated_at": _iso(formulation.updated_at),
                },
                # Surface the latest customer-side rejection reason
                # (proposal declined via kiosk) or the void reason on
                # any voided payment. Null when nothing bad happened —
                # the FE just skips the banner in that case. Both
                # sources are already captured in the domain; this
                # block is a compact aggregator so the FE doesn't have
                # to know which surface to peek at.
                "cancellation": _build_cancellation(
                    proposals=proposals,
                    formulation_id=formulation_id,
                ),
                "pipeline": _build_pipeline(
                    formulation=formulation,
                    proposals=proposals,
                    sheets=sheets,
                    validations=validations,
                    label_design=label_design,
                    payment=payment,
                    cff=cff,
                ),
                "next_action": _build_next_action(
                    formulation=formulation,
                    proposals=proposals,
                    sheets=sheets,
                    label_design=label_design,
                ),
                "documents": _build_documents(
                    proposals=proposals,
                    sheets=sheets,
                    label_design=label_design,
                    label_designs_all=label_designs_all,
                ),
                "timeline": _build_timeline(
                    proposals=proposals,
                    sheets=sheets,
                    label_design=label_design,
                ),
                # Chat anchor — the primary proposal id lets the FE
                # bind its chat panel to /api/portal/proposals/<id>/
                # proposal-messages/ without a second round-trip. Null
                # on projects that don't have a proposal yet (chat
                # isn't available until sales sends one).
                "primary_proposal": _primary_proposal_ref(proposals),
                # PSP-derived production status. Populated the moment
                # PSP fires an ``OrderWizard.notify_co_changed`` push
                # (every MO / PO / session / closeout state change).
                # Null when the project hasn't reached production on
                # PSP yet — the portal then hides the production card
                # and shows only the pre-production roadmap. Once
                # production starts, this + the label-design card
                # render side-by-side so the customer sees both
                # concurrent workstreams.
                "production_status": _build_production_status(
                    formulation=formulation,
                    proposals=proposals,
                ),
            }
        )


def _primary_proposal_ref(proposals: list[Proposal]) -> dict | None:
    """The proposal chat should attach to. Prefer the latest sent
    proposal (that's what "this deal" usually means), fall back to
    the latest draft — the customer can still open a conversation
    while the quote is being finalised."""

    if not proposals:
        return None
    # ``proposals`` came in newest-first (proposals_covering_formulation
    # orders by -updated_at). Prefer sent / accepted first, else the
    # freshest of any status.
    live = next((p for p in proposals if p.status in ("sent", "accepted")), None)
    p = live or proposals[0]
    return {"id": str(p.id), "code": p.code, "status": p.status}


def _build_cancellation(
    *,
    proposals: list[Proposal],
    formulation_id,
) -> dict | None:
    """Compact "why did this stop moving" block for the FE banner.

    Sources, priority order:
      1. Customer-declined proposal (``customer_rejected_at`` set) —
         the reason is the customer's own words from the kiosk decline
         modal.
      2. Voided payment on this formulation — reason lives in the
         payment's notes, appended by ``void_payment`` under a
         ``--- voided ---`` marker.

    Returns ``None`` when neither condition holds so the FE can
    ``!== null`` gate the banner cheaply.
    """

    rejected = next(
        (
            p
            for p in proposals
            if getattr(p, "customer_rejected_at", None) is not None
        ),
        None,
    )
    if rejected is not None:
        return {
            "source": "proposal_declined",
            "reason": (rejected.customer_rejection_reason or "").strip(),
            "at": _iso(rejected.customer_rejected_at),
            "reference_code": rejected.code,
        }
    # Only DEPOSIT / FINAL voids are project-cancelling. An
    # ADDITIONAL_SAMPLES void is a routine finance rejection of a
    # customer top-up request — it drops the trial-batch cycle
    # back into its terminal-choice prompt (see
    # ``reject_additional_samples_on_payment_voided``) and mustn't
    # nuke the whole project card with a fatal red banner.
    voided = (
        Payment.objects.filter(
            formulation_id=formulation_id,
            status=PaymentStatus.VOIDED,
            kind__in=(PaymentKind.DEPOSIT, PaymentKind.FINAL),
        )
        .order_by("-updated_at")
        .first()
    )
    if voided is not None:
        # Notes on a voided payment carry the void reason appended
        # after a "--- voided ---" marker (see void_payment). Split
        # so the banner shows just the reason, not the payment's
        # pre-existing notes body.
        raw = voided.notes or ""
        reason = raw.split("--- voided ---", 1)[-1].strip() if raw else ""
        # Human-readable label for the payment kind — the portal
        # customer knows "deposit" and "final invoice", not the
        # internal enum values.
        kind_label = {
            PaymentKind.DEPOSIT: "Deposit invoice",
            PaymentKind.FINAL: "Final invoice",
        }.get(voided.kind, "Invoice")
        return {
            "source": "payment_voided",
            "payment_kind": voided.kind,
            "payment_kind_label": kind_label,
            "amount": str(voided.amount),
            "currency": voided.currency or "GBP",
            "invoice_number": (voided.invoice_number or "").strip(),
            "reason": reason,
            "at": _iso(voided.updated_at),
            # Prefer the finance-facing invoice number when set; fall
            # back to the payment uuid for uniqueness.
            "reference_code": (
                (voided.invoice_number or "").strip() or str(voided.id)
            ),
        }
    return None


class PortalProductRoutingChoiceView(PortalAPIView):
    """``POST /api/portal/products/<formulation_id>/routing-choice/`` —
    customer submits their 3PL vs direct-shipment choice for a bespoke
    NPD-formulation project.

    Body::

        {"choice": "three_pl" | "shipment"}

    Ownership: same customer_ids union guard as the product detail
    view. The choice is relayed to PSP; on 200 we upsert the local
    ``PspProductionStatus.routing_request`` with PSP's echo so the
    portal card reflects the new state without waiting for PSP's
    next production_status push. Websocket broadcast fires so
    other open tabs update.

    Responses:
      * 200 — ``{"routing_request": {...updated}}``
      * 400 — bad or missing choice
      * 404 — formulation not visible to this account / no CO uuid
      * 409 — request in wrong state (already applied, etc.)
      * 502 — PSP unreachable / relay failed
    """

    def post(self, request: Request, formulation_id) -> Response:
        from apps.client_portal.queries import (
            customer_ids_for_account,
            customer_owns_formulation,
        )
        from apps.psp.models import PspProductionStatus
        from apps.psp.services import get_psp_config, PspClient

        choice = (request.data.get("choice") or "").strip()
        if choice not in ("three_pl", "shipment"):
            return Response(
                {"detail": "invalid_choice"},
                status=400,
            )

        customer_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=customer_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = get_object_or_404(Formulation, id=formulation_id)

        status_row = getattr(formulation, "psp_production_status", None)
        if status_row is None or not status_row.psp_customer_order_uuid:
            return Response(
                {"detail": "no_routing_request"},
                status=404,
            )

        # Relay to PSP.
        config = get_psp_config(organization=formulation.organization)
        client = PspClient(config)
        echo = client.submit_customer_order_routing_choice(
            status_row.psp_customer_order_uuid, choice=choice,
        )

        if echo is None:
            return Response(
                {"detail": "psp_relay_failed"},
                status=502,
            )

        # Merge PSP's echo into the locally-stored routing_request
        # block. Keep any keys the current model already carries so a
        # partial echo doesn't wipe our snapshot cache.
        existing = status_row.routing_request or {}
        merged = {
            **existing,
            "uuid": echo.get("uuid") or existing.get("uuid"),
            "state": echo.get("state") or existing.get("state"),
            "customer_choice": echo.get("customer_choice"),
            "team_decision_reason": echo.get("team_decision_reason"),
            "customer_chose_at": echo.get("customer_chose_at"),
            "team_reviewed_at": echo.get("team_reviewed_at"),
            "frozen_snapshot": echo.get("estimate_snapshot")
            or existing.get("frozen_snapshot"),
        }
        status_row.routing_request = merged
        status_row.save(update_fields=["routing_request", "updated_at"])

        # Portal WebSocket fanout — other open tabs update without
        # polling. Silent no-op if Channels isn't wired.
        try:
            from apps.client_portal.consumers import (
                broadcast_production_status_changed,
            )

            broadcast_production_status_changed(formulation)
        except Exception:  # pragma: no cover - defensive
            pass

        return Response(
            {"routing_request": merged},
            status=200,
        )


class PortalProductPickupEventDeliveryView(PortalAPIView):
    """``POST /api/portal/products/<formulation_id>/dispatch/pickup-events/<event_uuid>/confirm-delivery/``
    — per-event customer POD for a custom-formulation project.

    Same shape as the sample-detail per-event confirmation view
    (:class:`~apps.client_portal.api.sample_detail_views.PortalSamplePickupEventDeliveryView`).
    Body: ``{"recipient_signatory": "...", "delivery_notes": "..."}``.
    """

    def post(self, request: Request, formulation_id, event_uuid) -> Response:
        from apps.client_portal.queries import (
            customer_ids_for_account,
            customer_owns_formulation,
        )
        from apps.psp.services import (
            confirm_psp_dispatch_event_delivery_for_co,
        )

        signatory = (request.data.get("recipient_signatory") or "").strip()
        if not signatory:
            return Response(
                {"detail": "recipient_signatory_required"}, status=400
            )

        customer_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=customer_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = get_object_or_404(Formulation, id=formulation_id)

        status_row = getattr(formulation, "psp_production_status", None)
        co_uuid = status_row and status_row.psp_customer_order_uuid
        if not co_uuid:
            return Response({"detail": "no_dispatch"}, status=404)

        notes = (request.data.get("delivery_notes") or "").strip()

        result = confirm_psp_dispatch_event_delivery_for_co(
            organization=formulation.organization,
            co_uuid=str(co_uuid),
            event_uuid=str(event_uuid),
            recipient_signatory=signatory,
            delivery_notes=notes,
        )
        if result is None:
            return Response(
                {"detail": "confirmation_failed"}, status=502
            )
        return Response(result, status=200)


class PortalProductDispatchPhotoView(PortalAPIView):
    """``GET /api/portal/products/<formulation_id>/dispatch/photos/<file_uuid>/``
    — proxy-download one truck-arrival photo for the CO backing this
    formulation. Custom-formulation counterpart to
    :class:`~apps.client_portal.api.sample_detail_views.PortalSampleDispatchPhotoView`.

    Ownership guard matches :class:`PortalProductDetailView`: the
    account must own the formulation via a proposal covering it. The
    guard here stops a leaked file uuid from downloading for an
    unrelated account.
    """

    def get(self, request: Request, formulation_id, file_uuid) -> Response:
        from apps.client_portal.queries import (
            customer_ids_for_account,
            customer_owns_formulation,
        )
        from apps.psp.services import fetch_psp_dispatch_photo_for_co
        from django.http import HttpResponse

        customer_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=customer_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = get_object_or_404(Formulation, id=formulation_id)
        status_row = getattr(formulation, "psp_production_status", None)
        co_uuid = status_row and status_row.psp_customer_order_uuid
        if not co_uuid:
            raise NotFound("dispatch_photo_not_found")

        result = fetch_psp_dispatch_photo_for_co(
            organization=formulation.organization,
            co_uuid=str(co_uuid),
            file_uuid=file_uuid,
        )
        if result is None:
            raise NotFound("dispatch_photo_not_found")

        body, mime, filename = result
        response = HttpResponse(body, content_type=mime)
        response["Content-Disposition"] = f'inline; filename="{filename}"'
        response["Cache-Control"] = "private, max-age=86400, immutable"
        return response


class PortalProductReleaseDocumentView(PortalAPIView):
    """``GET /api/portal/products/<formulation_id>/release-documents/<file_uuid>/``
    — proxy-download one Final Product Release document (CoA / BMR
    / micro / label proof / retain-sample photo) for the CO backing
    this formulation. Custom-formulation counterpart to
    :class:`~apps.client_portal.api.sample_detail_views.PortalSampleReleaseDocumentView`.
    """

    def get(self, request: Request, formulation_id, file_uuid) -> Response:
        from apps.client_portal.queries import (
            customer_ids_for_account,
            customer_owns_formulation,
        )
        from apps.psp.services import fetch_psp_release_document_for_co
        from django.http import HttpResponse

        customer_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=customer_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = get_object_or_404(Formulation, id=formulation_id)
        status_row = getattr(formulation, "psp_production_status", None)
        co_uuid = status_row and status_row.psp_customer_order_uuid
        if not co_uuid:
            raise NotFound("release_document_not_found")

        result = fetch_psp_release_document_for_co(
            organization=formulation.organization,
            co_uuid=str(co_uuid),
            file_uuid=file_uuid,
        )
        if result is None:
            raise NotFound("release_document_not_found")

        body, mime, filename = result
        # PDFs render inline in the portal iframe; everything else
        # (Word / Excel / photos) suggests a filename download.
        disposition = "inline" if (mime or "").lower().startswith("application/pdf") else "attachment"
        response = HttpResponse(body, content_type=mime)
        response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
        response["Cache-Control"] = "private, max-age=86400, immutable"
        return response
