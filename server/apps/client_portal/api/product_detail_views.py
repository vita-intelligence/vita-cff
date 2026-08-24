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
# Pipeline derivation — eight ordered stages
# ---------------------------------------------------------------------------


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
        if (
            (
                cycle.status == TrialBatchCycleStatus.SATISFIED
                or team_closed_and_customer_confirmed
            )
            and remaining_open == 0
        ):
            trial_stage = {
                "key": "trial",
                "label": (
                    "Trial batches complete — you approved slot "
                    f"{satisfied.sequence_no}"
                    if satisfied is not None
                    else "Trial batches complete"
                ),
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
                "label": (
                    f"Trial batches — all {cycle.total_slots} sent, "
                    "waiting on you"
                ),
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
                "label": "Trial batches wrapped — waiting on you",
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
                "label": (
                    f"Trial batches — {used} of {cycle.total_slots} in flight"
                ),
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
                "label": "Trial batch passed",
                "state": "done",
                "completed_at": _iso(passed_validation.updated_at),
                "detail": "Quality checks all passed — final specification incoming.",
            }
        elif failed_validation is not None:
            trial_stage = {
                "key": "trial",
                "label": "Trial batch failed — investigating",
                "state": "current",
                "completed_at": None,
                "detail": "Our team is investigating the failure and will be in touch.",
            }
        elif in_progress_validation is not None:
            trial_stage = {
                "key": "trial",
                "label": "Trial batch in progress",
                "state": "current",
                "completed_at": None,
                "detail": "We're producing a trial batch and running quality checks.",
            }
        else:
            trial_stage = {
                "key": "trial",
                "label": "Trial batch",
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
    production_done = (
        label_design is not None
        and label_design.status == LabelDesignStatus.LABEL_APPROVED
    )
    production_stage = {
        "key": "production",
        "label": "Production",
        "state": "current" if production_done else "future",
        "completed_at": None,
        "detail": (
            "Your product is heading into production scheduling."
            if production_done
            else "After label sign-off, production planning begins."
        ),
    }

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
    # Same reorder for RTG (no trial + no final spec) so both project
    # types read consistently.
    if formulation.project_type == ProjectType.READY_TO_GO.value:
        return [
            request_stage,
            draft_stage,
            proposal_stage,
            sample_stage,
            deposit_stage,
            payment_stage,
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
        # Two doors: proposal-attachment OR already-signed (paper trail).
        already_signed = sheet.customer_signed_at is not None
        proposal_attached = sheet.id in customer_visible_sheet_ids
        if not already_signed and not proposal_attached:
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
        payment = (
            Payment.objects.filter(
                formulation_id=formulation_id,
                status=PaymentStatus.APPROVED,
                kind=PaymentKind.FINAL,
            ).order_by("-approved_at")
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

        return Response(
            {
                "product": {
                    "id": str(formulation.id),
                    "code": formulation.code,
                    "name": formulation.name,
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
