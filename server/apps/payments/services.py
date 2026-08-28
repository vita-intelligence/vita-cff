"""Payment services — record, approve, void.

Approval is the interesting one: it drives the LabelDesign gate
forward from ``PAYMENT_PENDING`` to ``LABEL_PATH_PENDING``. The
LabelDesign FK on Payment is what wires the two together — if a
payment lands without a matching LabelDesign (e.g. project was paid
but spec was never customer-signed yet) the approval succeeds but
no transition is fired; the next time the spec is signed and the
signal creates the LabelDesign, the existing approved Payment is
checked and the gate flips immediately.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

from apps.audit.services import record as record_audit
from apps.label_design.constants import LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.label_design.services import transition_status as label_design_transition
from apps.payments.broadcast import schedule_payment_changed_broadcast
from apps.payments.constants import PaymentKind, PaymentMethod, PaymentStatus
from apps.payments.models import (
    Payment,
    SampleAllocation,
    SampleAllocationStatus,
    SamplePricingConfig,
    SamplePricingDiscountTier,
)


class PaymentAlreadyApproved(Exception):
    api_code = "payments.already_approved"


class PaymentAlreadyVoided(Exception):
    api_code = "payments.already_voided"


class PaymentKindConflict(Exception):
    api_code = "payments.kind_conflict"


# ---------------------------------------------------------------------------
# Note-builder helpers
#
# The ``notes`` column on a Payment is what finance reads on their
# queue to decide (a) what the invoice is FOR and (b) what to do
# next. The auto-create paths used to emit terse one-liners like
# "Auto-created on customer kiosk sign of PROP-0013. Expected
# 25790.00 GBP (100.00% deposit)." which forced finance to click into
# the proposal / customer / formulation to reconstruct the context
# every time. The builders below now emit a rich, self-contained
# summary: what flow triggered the row, who the customer is, what
# product they bought, the amount + breakdown, and the concrete
# action finance is expected to take next.
#
# Every builder returns a plain string (multi-line, joined by "\n")
# so a rollback / retry of the create call replays the same text.
# ---------------------------------------------------------------------------


def _format_money(amount: Any, currency: str) -> str:
    """Human-readable ``£25,790.00 GBP`` style money string."""

    try:
        value = Decimal(amount)
    except Exception:  # noqa: BLE001
        return f"{amount} {currency}"
    quantised = value.quantize(Decimal("0.01"))
    whole, _, frac = f"{quantised:.2f}".partition(".")
    whole_grouped = f"{int(whole):,}"
    return f"{whole_grouped}.{frac} {currency}"


def _customer_label(customer) -> str:
    if customer is None:
        return "Unknown customer"
    parts = []
    name = (getattr(customer, "name", "") or "").strip()
    company = (getattr(customer, "company", "") or "").strip()
    email = (getattr(customer, "email", "") or "").strip()
    if name and company and name != company:
        parts.append(f"{name} ({company})")
    elif name:
        parts.append(name)
    elif company:
        parts.append(company)
    if email:
        parts.append(f"<{email}>")
    return " ".join(parts) if parts else "Unknown customer"


def _formulation_label(formulation) -> str:
    if formulation is None:
        return "Unknown product"
    # Prefer the customer-facing marketing name on RTG SKUs so
    # finance reads "Ultimate Fat Burner Drink" instead of the
    # internal SKU code. Lazy import — the queries module already
    # depends on the formulations model, and importing here avoids
    # a boot-time cycle from this bottom-of-stack service module.
    from apps.client_portal.queries import formulation_display_name

    display = formulation_display_name(formulation)
    code = (getattr(formulation, "code", "") or "").strip()
    if display and code and display != code:
        return f"{display} · {code}"
    return display or code or "Unknown product"


def _build_deposit_notes(
    *, proposal, amount: Decimal, currency: str, percent: Decimal, total: Decimal
) -> str:
    """Rich notes for :func:`ensure_pending_deposit_payment`.

    Custom deposit — X% up-front slice unlocking the trial-batch
    stage of the R&D workflow. RTG deposit — the storefront checkout
    forces ``deposit_percent = 100`` so the row IS the full order
    invoice; approving it authorises production directly.
    """

    from apps.proposals.models import ProposalTemplateType

    is_rtg = proposal.template_type == ProposalTemplateType.READY_TO_GO.value
    formulation = None
    version = getattr(proposal, "formulation_version", None)
    if version is not None:
        formulation = getattr(version, "formulation", None)
    customer = getattr(proposal, "customer", None)
    lines = []
    if is_rtg:
        lines.append(
            "=== Ready-to-Go storefront order — full invoice (100% deposit) ==="
        )
        lines.append(
            "This row is the ENTIRE order invoice. There is no remainder "
            "FINAL invoice on RTG orders — approving this row authorises "
            "label design + production."
        )
    else:
        lines.append(
            f"=== Custom-formulation deposit invoice ({percent}% of order total) ==="
        )
        lines.append(
            "Approving this row unlocks the trial-batch cycle for the "
            "R&D team. The remaining balance is invoiced separately "
            "after the customer signs the FINAL specification."
        )
    lines.append("")
    lines.append(f"Customer:      {_customer_label(customer)}")
    lines.append(f"Product:       {_formulation_label(formulation)}")
    lines.append(f"Proposal:      {proposal.code or proposal.id}")
    quantity = getattr(proposal, "quantity", None) or 0
    unit_price = getattr(proposal, "unit_price", None)
    if quantity and unit_price is not None:
        try:
            lines.append(
                f"Quantity:      {int(quantity):,} × "
                f"{_format_money(unit_price, currency)}/unit"
            )
        except Exception:  # noqa: BLE001
            lines.append(f"Quantity:      {quantity}")
    lines.append(
        f"Order total:   {_format_money(total, currency)} "
        "(subtotal + freight, excl. VAT)"
    )
    lines.append(
        f"THIS INVOICE:  {_format_money(amount, currency)} "
        f"({percent}% of order total)"
    )
    lines.append("")
    lines.append("Finance next steps:")
    lines.append(
        "  1. Send the invoice to the customer via your usual channel."
    )
    lines.append(
        "  2. Once the bank transfer lands, mark this row Approved."
    )
    if is_rtg:
        lines.append(
            "  3. On Approve: the label workflow bootstraps + PSP receives "
            "the production-authorised signal automatically."
        )
    else:
        lines.append(
            "  3. On Approve: the R&D team is unblocked to schedule the "
            "first trial batch."
        )
    return "\n".join(lines)


def _build_final_payment_notes(
    *,
    formulation,
    sheet,
    total: Decimal,
    deposit_paid: Decimal,
    amount_due: Decimal,
    currency: str,
) -> str:
    """Rich notes for :func:`ensure_final_payment_for_formulation`.

    Fires only on Custom projects — the ``and not is_ready_to_go``
    guard on the caller keeps RTG out of this path (RTG rides the
    100% deposit row above).
    """

    from apps.client_portal.queries import formulation_display_name

    lines = [
        "=== Custom-formulation FINAL invoice (remainder after deposit) ===",
        "This row is the second half of the customer's payment — auto-",
        "created when they signed the FINAL specification. Approving it",
        "unlocks the label-design workflow and pushes the production-",
        "authorised signal to PSP.",
        "",
    ]
    customer = getattr(formulation, "customer", None)
    lines.append(f"Customer:      {_customer_label(customer)}")
    lines.append(f"Product:       {_formulation_label(formulation)}")
    lines.append(
        f"FINAL spec:    {sheet.code or sheet.id} "
        f"(signed {sheet.customer_signed_at.date() if sheet.customer_signed_at else '?'})"
    )
    lines.append(
        f"Final total:   {_format_money(total, currency)} "
        f"({int(getattr(sheet, 'quantity', 0)):,} units × "
        f"{_format_money(getattr(sheet, 'final_price', 0), currency)}/unit)"
    )
    lines.append(f"Deposit paid:  {_format_money(deposit_paid, currency)}")
    lines.append(
        f"THIS INVOICE:  {_format_money(amount_due, currency)} "
        "(final total − deposit paid)"
    )
    lines.append("")
    lines.append("Finance next steps:")
    lines.append(
        "  1. Send the FINAL invoice to the customer via your usual channel."
    )
    lines.append(
        "  2. Once payment lands, mark this row Approved."
    )
    lines.append(
        "  3. On Approve: label workflow advances past PAYMENT_PENDING and "
        "PSP moves the CO into production planning."
    )
    return "\n".join(lines)


@transaction.atomic
def record_payment(
    *,
    actor,
    amount: Decimal,
    paid_at: datetime,
    kind: str = PaymentKind.FINAL,
    formulation=None,
    proposal=None,
    method: str = PaymentMethod.BANK_TRANSFER,
    currency: str = "GBP",
    external_reference: str = "",
    invoice_number: str = "",
    notes: str = "",
    label_design: LabelDesign | None = None,
    customer=None,
) -> Payment:
    """Persist a new payment in ``PENDING`` status.

    ``kind`` decides which target is required:

    * ``FINAL`` — formulation required (per-formulation gate,
      matches the existing labelling flow). The label-design link
      is best-effort: if not passed we look it up by formulation.
    * ``DEPOSIT`` — proposal required (bundle-level gate that
      unlocks trial batches for every formulation on that proposal).
      Formulation stays null.

    A mismatched combination raises :class:`PaymentKindConflict` so
    an accidentally-swapped payload never lands a half-wired row.

    ``customer`` is optional — when the caller doesn't pass one, we
    resolve it from the linked formulation / proposal so the finance
    queue's "who ordered this" column stays populated without every
    caller having to plumb the FK through.
    """

    if kind == PaymentKind.DEPOSIT:
        if proposal is None or formulation is not None:
            raise PaymentKindConflict()
        organization = proposal.organization
        label_design = None
    else:
        if formulation is None or proposal is not None:
            raise PaymentKindConflict()
        organization = formulation.organization
        if label_design is None:
            label_design = LabelDesign.objects.filter(formulation=formulation).first()

    if customer is None:
        if formulation is not None:
            customer = getattr(formulation, "customer", None)
        elif proposal is not None:
            customer = getattr(proposal, "customer", None)

    payment = Payment.objects.create(
        organization=organization,
        kind=kind,
        formulation=formulation,
        proposal=proposal,
        label_design=label_design,
        customer=customer,
        amount=amount,
        currency=currency,
        method=method,
        external_reference=external_reference.strip(),
        invoice_number=invoice_number.strip(),
        paid_at=paid_at,
        recorded_by=actor,
        status=PaymentStatus.PENDING,
        notes=notes.strip(),
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="payment.record",
        target=payment,
        before=None,
        after={
            "kind": kind,
            "amount": str(amount),
            "currency": currency,
            "method": method,
            "status": payment.status,
        },
    )

    # Finance team notification — fires only for sample payments
    # (kind=FINAL + RTG formulation), the ``staff_notifications``
    # module gates on that. Best-effort delivery; on_commit so an
    # SMTP failure never rolls back the record itself.
    payment_pk = payment.pk

    def _fire_finance_notification() -> None:
        from apps.payments.staff_notifications import (
            notify_finance_new_sample_payment,
        )

        notify_finance_new_sample_payment(payment_id=payment_pk)

    transaction.on_commit(_fire_finance_notification)

    # Live push to every open ``/finance/payments/`` tab on this org.
    # The FE hook invalidates the payments query cache on receive so
    # the new PENDING row lands in the "Needs attention" column
    # without a page reload — matters most for the storefront-checkout
    # path, which is a completely different app (localhost:3000) and
    # therefore has no way to invalidate the staff app's TanStack
    # Query cache directly.
    schedule_payment_changed_broadcast(payment, "created")

    return payment


@transaction.atomic
def approve_payment(*, payment: Payment, actor: Any) -> Payment:
    """Approve a PENDING payment and advance its single LabelDesign
    from ``PAYMENT_PENDING`` to ``LABEL_PATH_PENDING``.

    Migration ``label_design.0005`` collapsed the model to one
    LabelDesign per formulation, so the historical fan-out (loop
    over every pending label-design on the project) is no longer
    needed. Look up the row by formulation, transition it if it's
    still pending. A payment approval on a formulation whose label
    workflow already advanced is a no-op on the LabelDesign side.
    """

    if payment.status == PaymentStatus.APPROVED:
        raise PaymentAlreadyApproved()
    if payment.status == PaymentStatus.VOIDED:
        raise PaymentAlreadyVoided()

    payment.status = PaymentStatus.APPROVED
    payment.approved_by = actor
    payment.approved_at = timezone.now()
    payment.save(
        update_fields=["status", "approved_by", "approved_at", "updated_at"]
    )

    # LabelDesign advancement is FINAL-payment only. Deposits unlock
    # trial batches (the gate is checked at trial-batch create time
    # via :func:`is_deposit_paid_for_formulation`); they don't have
    # a mirrored state machine to advance.
    label_design = None
    advanced_ids: list[str] = []
    if payment.kind == PaymentKind.FINAL:
        # One LabelDesign per formulation. Prefer the explicit FK if
        # the payment carried one; fall back to the formulation
        # lookup for rows recorded before the FK was consistently
        # populated.
        label_design = payment.label_design
        if label_design is None:
            label_design = LabelDesign.objects.filter(
                formulation_id=payment.formulation_id
            ).first()
        if (
            label_design is not None
            and label_design.status == LabelDesignStatus.PAYMENT_PENDING
        ):
            label_design_transition(
                label_design,
                to_status=LabelDesignStatus.LABEL_PATH_PENDING,
                actor=actor,
                notes="payment approved",
                metadata={"payment_id": str(payment.id)},
            )
            advanced_ids.append(str(label_design.id))

    record_audit(
        organization=payment.organization,
        actor=actor,
        action="payment.approve",
        target=payment,
        before={"status": PaymentStatus.PENDING},
        after={
            "status": PaymentStatus.APPROVED,
            "advanced_label_designs": advanced_ids,
        },
    )

    # Notify the customer that we've received their payment + point
    # them at the portal so they can move on to label design. Fire on
    # ``transaction.on_commit`` so a rollback (rare here but possible
    # if a downstream signal raises) doesn't send a stale "received"
    # email for an approval that never actually committed.
    payment_pk = payment.pk

    def _fire_email() -> None:
        from apps.payments.email import send_payment_received_to_client

        send_payment_received_to_client(payment_id=payment_pk, actor=actor)

    transaction.on_commit(_fire_email)

    # Payment landed — push the fresh state to PSP. RTG projects keep
    # riding the sample-CO sync (keyed on payment id); custom projects
    # now trigger the main formulation sync so PSP's ``npd_payments``
    # list refreshes to include this approval + any attached invoice
    # files. Silent-degrade, no-op for anything not linked to a
    # formulation. Fires on commit so a rollback doesn't leave PSP
    # thinking we approved when we didn't.
    def _resync_payment() -> None:
        from apps.psp.services import maybe_resync_payment_to_psp

        fresh = Payment.objects.filter(pk=payment_pk).first()
        if fresh is not None:
            maybe_resync_payment_to_psp(payment=fresh)

    transaction.on_commit(_resync_payment)

    # Scientist notification — approval is when the sample is
    # actually unlocked for the scientist to spin up a trial batch.
    # Gated on sample-payment kind inside the notification module.
    def _fire_scientist_notification() -> None:
        from apps.payments.staff_notifications import (
            notify_scientists_sample_ready,
        )

        notify_scientists_sample_ready(payment_id=payment_pk)

    transaction.on_commit(_fire_scientist_notification)

    # DEPOSIT approval routes on ``proposal.template_type`` because
    # the same PaymentKind serves two conceptually different flows:
    #
    # * Custom deposit — the ~30% up-front slice that unlocks trial
    #   batches. Seeds the trial-batch cycle + pushes deposit_paid_at
    #   to PSP so the kanban advances into "Trial batches".
    # * RTG deposit — the storefront checkout forces
    #   ``deposit_percent = 100``, so the "deposit" is really the full
    #   order invoice. RTG has no trial batches, no final-spec sign,
    #   and no remainder FINAL invoice. Approval must therefore
    #   trigger the SAME "production authorised" cascade Custom fires
    #   on FINAL-payment approval: advance project_status → APPROVED,
    #   bootstrap the LabelDesign row (spec-sign was blocked from
    #   creating one pre-payment), and push the formulation-mirror to
    #   PSP so the CO advances into production planning.
    proposal_template_rtg = False
    if payment.kind == PaymentKind.DEPOSIT and payment.proposal_id is not None:
        from apps.proposals.models import ProposalTemplateType

        proposal_template_rtg = (
            payment.proposal.template_type
            == ProposalTemplateType.READY_TO_GO.value
        )

    if payment.kind == PaymentKind.DEPOSIT and not proposal_template_rtg:
        def _seed_trial_batch_cycle() -> None:
            from apps.trial_batches.cycle_services import create_cycle_for_deposit

            fresh = Payment.objects.filter(pk=payment_pk).first()
            if fresh is None:
                return
            try:
                create_cycle_for_deposit(payment=fresh)
            except Exception:  # noqa: BLE001 — never break payment approval
                logger.exception(
                    "Failed to seed trial-batch cycle for payment %s",
                    payment_pk,
                )

        transaction.on_commit(_seed_trial_batch_cycle)

        # Push the fresh deposit_paid_at through to PSP's mirror so
        # the kanban card moves from :proposal_accepted ("Awaiting
        # R&D payment") into :trial_batches_in_flight ("Trial
        # batches"). Uses the proposal-merge sync path since the
        # deposit timestamp ships on the proposal-level payload
        # (per-formulation lookup, earliest-approved-wins on
        # bundled proposals).
        def _push_deposit_to_psp() -> None:
            from apps.proposals.services import _schedule_proposal_psp_merge

            fresh = Payment.objects.filter(pk=payment_pk).first()
            if fresh is None or fresh.formulation_id is None:
                return
            try:
                proposal = _signed_or_accepted_proposal_for_formulation(
                    fresh.formulation
                )
                if proposal is not None:
                    _schedule_proposal_psp_merge(proposal)
            except Exception:  # noqa: BLE001 — silent-degrade
                logger.exception(
                    "Failed to push deposit paid_at to PSP for payment %s",
                    payment_pk,
                )

        transaction.on_commit(_push_deposit_to_psp)
    elif payment.kind == PaymentKind.DEPOSIT and proposal_template_rtg:
        # RTG deposit approval = production-authorised cascade.
        # Same three effects as Custom FINAL approval:
        #   1. Advance project_status → APPROVED so the label
        #      bootstrap's gate opens.
        #   2. Bootstrap the LabelDesign row (spec-sign was blocked
        #      from creating one pre-payment). ``bootstrap_for_spec``
        #      sees deposit_percent = 100 and jumps straight to
        #      LABEL_PATH_PENDING, skipping the PAYMENT_PENDING gate
        #      — the invoice is already paid, so the customer's next
        #      step is "pick a path".
        #   3. Push the formulation-mirror to PSP so the mirrored CO
        #      moves out of ``:awaiting_customer_signature`` into
        #      ``:production_planning``.
        formulation_pk = payment.formulation_id or (
            payment.proposal.formulation_version.formulation_id
            if payment.proposal_id
            and payment.proposal.formulation_version_id
            else None
        )
        if formulation_pk is not None:
            def _rtg_production_authorised() -> None:
                from apps.formulations.models import (
                    Formulation as _Formulation,
                    ProjectStatus,
                )
                from apps.formulations.services import (
                    _maybe_advance_project_status,
                )
                from apps.label_design.services import (
                    bootstrap_for_formulation,
                )

                fresh = _Formulation.objects.filter(pk=formulation_pk).first()
                if fresh is None:
                    return
                try:
                    _maybe_advance_project_status(
                        formulation=fresh,
                        target_status=ProjectStatus.APPROVED.value,
                        actor=actor,
                    )
                except Exception:  # noqa: BLE001 — never break approve
                    logger.exception(
                        "RTG deposit approval: project_status advance "
                        "bubbled for formulation %s",
                        formulation_pk,
                    )
                try:
                    bootstrap_for_formulation(fresh)
                except Exception:  # noqa: BLE001 — never break approve
                    logger.exception(
                        "RTG deposit approval: label_design bootstrap "
                        "bubbled for formulation %s",
                        formulation_pk,
                    )
                try:
                    _sync_formulation_proposal_to_psp(fresh)
                except Exception:  # noqa: BLE001 — never break approve
                    logger.exception(
                        "RTG deposit approval: PSP sync bubbled for "
                        "formulation %s",
                        formulation_pk,
                    )

            transaction.on_commit(_rtg_production_authorised)
    elif payment.kind == PaymentKind.ADDITIONAL_SAMPLES:
        def _apply_additional_samples() -> None:
            from apps.trial_batches.cycle_services import (
                apply_additional_samples_on_payment_approved,
            )

            fresh = Payment.objects.filter(pk=payment_pk).first()
            if fresh is None:
                return
            try:
                apply_additional_samples_on_payment_approved(payment=fresh)
            except Exception:  # noqa: BLE001 — never break payment approval
                logger.exception(
                    "Failed to apply additional-samples approval for payment %s",
                    payment_pk,
                )

        transaction.on_commit(_apply_additional_samples)

    # FINAL payment approval — push the "production authorised"
    # signal to PSP. The proposal-merge payload gains
    # ``npd_final_payment_approved_at`` which promotes the CO from
    # ``:awaiting_final_spec`` to ``:production_planning``
    # ("Need MO created"). Silent-degrade on any failure — finance
    # can retry the sync via the manual re-sync path if PSP was
    # down at approve time.
    if payment.kind == PaymentKind.FINAL and payment.formulation_id is not None:
        formulation_pk = payment.formulation_id

        def _push_final_payment_to_psp() -> None:
            from apps.formulations.models import Formulation as _Formulation

            fresh = _Formulation.objects.filter(pk=formulation_pk).first()
            if fresh is None:
                return
            try:
                _sync_formulation_proposal_to_psp(fresh)
            except Exception:  # noqa: BLE001 — never break approve
                logger.exception(
                    "Failed to push FINAL payment approval to PSP for "
                    "formulation %s",
                    formulation_pk,
                )

        transaction.on_commit(_push_final_payment_to_psp)

        # Advance the label workflow's payment gate. The label
        # bootstraps at ``PAYMENT_PENDING`` on customer FINAL-spec
        # sign, then sits there until finance approves the FINAL
        # invoice. Kicking this on ``transaction.on_commit`` so a
        # rollback of the approve doesn't leave the label in a
        # never-should-have-happened state.
        def _advance_label_after_final_approval() -> None:
            from apps.formulations.models import Formulation as _Formulation
            from apps.label_design.services import advance_label_if_final_paid

            fresh = _Formulation.objects.filter(pk=formulation_pk).first()
            if fresh is None:
                return
            try:
                advance_label_if_final_paid(fresh)
            except Exception:  # noqa: BLE001 — never break approve
                logger.exception(
                    "Failed to advance label workflow after FINAL "
                    "payment approval for formulation %s",
                    formulation_pk,
                )

        transaction.on_commit(_advance_label_after_final_approval)

    if payment.kind == PaymentKind.LABEL_DESIGN and payment.formulation_id is not None:
        design_formulation_pk = payment.formulation_id

        def _advance_label_after_design_fee_approval() -> None:
            from apps.formulations.models import Formulation as _Formulation
            from apps.label_design.services import (
                advance_label_after_design_fee_paid,
            )

            fresh = _Formulation.objects.filter(pk=design_formulation_pk).first()
            if fresh is None:
                return
            try:
                advance_label_after_design_fee_paid(fresh)
            except Exception:  # noqa: BLE001 — never break approve
                logger.exception(
                    "Failed to advance label workflow after LABEL_DESIGN "
                    "payment approval for formulation %s",
                    design_formulation_pk,
                )

        transaction.on_commit(_advance_label_after_design_fee_approval)

    # Live push — moves the row from the Needs-attention column into
    # Approved on every open finance tab.
    schedule_payment_changed_broadcast(payment, "approved")

    return payment


@transaction.atomic
def void_payment(*, payment: Payment, actor: Any, notes: str = "") -> Payment:
    """Mark a payment as VOIDED. Forward-only on the LabelDesign
    side — voiding an approved payment does not roll the workflow
    back to ``PAYMENT_PENDING``."""

    if payment.status == PaymentStatus.VOIDED:
        raise PaymentAlreadyVoided()

    previous = payment.status
    payment.status = PaymentStatus.VOIDED
    if notes:
        payment.notes = (
            f"{payment.notes}\n--- voided ---\n{notes}".strip()
        )
    payment.save(update_fields=["status", "notes", "updated_at"])

    record_audit(
        organization=payment.organization,
        actor=actor,
        action="payment.void",
        target=payment,
        before={"status": previous},
        after={"status": PaymentStatus.VOIDED, "notes": notes},
    )

    # Payment voided — push the voided state to PSP so its CO detail
    # card renders "Voided" instead of a paid invoice for an order
    # that isn't happening. Same silent-degrade posture as approve.
    # Custom projects re-sync the whole payments list; RTG keeps
    # riding the sample-CO sync path.
    payment_pk = payment.pk

    def _resync_payment_on_void() -> None:
        from apps.psp.services import maybe_resync_payment_to_psp

        fresh = Payment.objects.filter(pk=payment_pk).first()
        if fresh is not None:
            maybe_resync_payment_to_psp(payment=fresh)

    transaction.on_commit(_resync_payment_on_void)

    # ADDITIONAL_SAMPLES payments — voiding the finance-queue row is
    # how "reject the top-up request" gets recorded. Mirror it onto
    # the linked AdditionalSampleRequest so the trial-batch cycle
    # can drop out of its "waiting on finance" hold and offer the
    # customer the terminal choice again. Silent-degrade posture
    # matches the approve path.
    if payment.kind == PaymentKind.ADDITIONAL_SAMPLES:
        def _reject_additional_samples() -> None:
            from apps.trial_batches.cycle_services import (
                reject_additional_samples_on_payment_voided,
            )

            fresh = Payment.objects.filter(pk=payment_pk).first()
            if fresh is None:
                return
            try:
                reject_additional_samples_on_payment_voided(payment=fresh)
            except Exception:  # noqa: BLE001 — never break payment void
                logger.exception(
                    "Failed to reject additional-samples request for voided "
                    "payment %s",
                    payment_pk,
                )

        transaction.on_commit(_reject_additional_samples)

    # Live push — moves the row from wherever it was into Voided on
    # every open finance tab. Voided is column 3 on the pipeline
    # board.
    schedule_payment_changed_broadcast(payment, "voided")

    return payment


# ---------------------------------------------------------------------------
# Deposit gate helpers — trial batches can't start until the customer has
# paid the deposit fraction of the proposal total.
# ---------------------------------------------------------------------------


def _accepted_proposal_for_formulation(formulation) -> Any | None:
    """Find the accepted proposal (if any) that this formulation was
    bundled into. Walks ``ProposalLine`` — same lookup shape as
    :func:`apps.specifications.services.resolve_linked_proposal`.
    ``None`` means the formulation was never signed onto a
    proposal, so no deposit gate applies.
    """

    from apps.proposals.models import ProposalLine, ProposalStatus

    line = (
        ProposalLine.objects.filter(
            formulation_version__formulation=formulation,
            proposal__status=ProposalStatus.ACCEPTED.value,
        )
        .select_related("proposal")
        .order_by("-proposal__updated_at")
        .first()
    )
    return line.proposal if line else None


def deposit_required_for_proposal(proposal) -> bool:
    """A deposit gate exists only when ``deposit_percent > 0``.
    0% means the whole invoice is deferred to the final payment —
    trial batches unlock immediately on kiosk sign.
    """

    percent = getattr(proposal, "deposit_percent", None)
    if percent is None:
        return False
    try:
        return Decimal(percent) > 0
    except Exception:  # noqa: BLE001
        return False


def is_deposit_paid_for_proposal(proposal) -> bool:
    """True when an APPROVED deposit Payment exists on this proposal.
    Approve is the trigger that opens the gate — a PENDING record is
    not enough."""

    return Payment.objects.filter(
        proposal=proposal,
        kind=PaymentKind.DEPOSIT,
        status=PaymentStatus.APPROVED,
    ).exists()


def trial_batch_gate_status(formulation) -> dict[str, Any]:
    """Compact status blob for the trial-batch gate on a given
    formulation. FE / API / trial-batch service all read from here
    so the semantics stay consistent.

    Keys:

    * ``unlocked`` — bool. True when no proposal-driven gate applies
      OR the deposit is paid.
    * ``reason`` — short code the FE can key off (
      ``no_proposal`` / ``no_deposit_required`` / ``deposit_paid``
      / ``deposit_pending``).
    * ``proposal_id`` / ``proposal_code`` — the accepted proposal
      that owns the gate, when present.
    * ``deposit_percent`` — the % expected on the deposit.
    * ``pending_payment_id`` — the pending deposit Payment row (if
      finance already materialised one), else null.
    """

    # Widen from "accepted only" to "customer has signed" so the
    # gate flips into deposit-tracking mode the moment the customer
    # commits — not only after finance has finalized the proposal.
    # Sample-selection confirm now auto-creates the Payment before
    # finance touches anything (see
    # ``ensure_bundled_deposit_payment_for_formulation``), so the
    # gate needs to see that Payment even if the proposal is still
    # at ``status = sent``.
    proposal = (
        _accepted_proposal_for_formulation(formulation)
        or _signed_or_accepted_proposal_for_formulation(formulation)
    )
    if proposal is None:
        return {
            "unlocked": True,
            "reason": "no_proposal",
            "proposal_id": None,
            "proposal_code": None,
            "deposit_percent": None,
            "pending_payment_id": None,
        }
    if not deposit_required_for_proposal(proposal):
        return {
            "unlocked": True,
            "reason": "no_deposit_required",
            "proposal_id": str(proposal.id),
            "proposal_code": proposal.code,
            "deposit_percent": "0",
            "pending_payment_id": None,
        }
    paid = is_deposit_paid_for_proposal(proposal)
    pending = (
        None
        if paid
        else Payment.objects.filter(
            proposal=proposal,
            kind=PaymentKind.DEPOSIT,
            status=PaymentStatus.PENDING,
        )
        .order_by("-created_at")
        .values_list("id", flat=True)
        .first()
    )
    return {
        "unlocked": paid,
        "reason": "deposit_paid" if paid else "deposit_pending",
        "proposal_id": str(proposal.id),
        "proposal_code": proposal.code,
        "deposit_percent": str(proposal.deposit_percent),
        "pending_payment_id": str(pending) if pending else None,
    }


@transaction.atomic
def ensure_pending_deposit_payment(*, proposal, actor=None) -> Payment | None:
    """Idempotently create a PENDING deposit Payment for this proposal
    (if one is required + doesn't already exist).

    Called from :func:`apps.proposals.services.finalize_proposal_kiosk`
    on ``sent → accepted``, so finance has a row to work off the
    moment the customer signs. Safe to re-fire — the existence check
    prevents duplicates on retry / edge cases (proposal accepted
    twice via idempotent path, kiosk re-fires, etc).

    Returns the Payment row on create, ``None`` when the gate is
    N/A or a row already exists.
    """

    if not deposit_required_for_proposal(proposal):
        return None
    existing = Payment.objects.filter(
        proposal=proposal, kind=PaymentKind.DEPOSIT
    ).first()
    if existing is not None:
        return None
    # ``total_excl_vat`` is the proposal's authoritative subtotal
    # (subtotal + freight) — same number the rendered document
    # shows the client. VAT stays out of the deposit maths on
    # purpose; the invoice stage adds it back.
    total = getattr(proposal, "total_excl_vat", None) or Decimal("0")
    total = Decimal(total)
    percent = Decimal(proposal.deposit_percent or 0)
    expected_amount = (total * percent / Decimal("100")).quantize(Decimal("0.01"))
    currency = getattr(proposal, "currency", "GBP")
    # Set the ``formulation`` FK on the payment so the PSP-sync
    # payload builder ``_bundled_deposit_paid_at`` can find it. That
    # helper filters ``Payment.objects.filter(formulation_id__in=...)``
    # by the proposal's formulations — without the FK set, an approved
    # RTG deposit is invisible to it and ``npd_deposit_paid_at`` stays
    # null on PSP, so PSP's kanban never advances the CO past
    # ``:proposal_accepted``. Custom deposits landed via a different
    # code path that always set the FK; this hook needs to match.
    #
    # We pin the FK to the first line's formulation. RTG proposals are
    # single-line by construction (one storefront cart line ⇒ one
    # proposal ⇒ one line — see ``_create_line_proposal`` in
    # ``client_portal/checkout_services.py``), so this reads the only
    # formulation there is. Multi-line Custom bundles keep firing this
    # helper through their own path and won't come through this branch
    # because the sample-selection service creates the bundled deposit
    # payment WITH ``formulation`` already set — see
    # ``ensure_bundled_deposit_payment_for_formulation``.
    formulation = None
    first_line = proposal.lines.select_related(
        "formulation_version__formulation"
    ).order_by("id").first()
    if first_line and first_line.formulation_version_id:
        formulation = first_line.formulation_version.formulation
    payment = Payment.objects.create(
        organization=proposal.organization,
        kind=PaymentKind.DEPOSIT,
        proposal=proposal,
        formulation=formulation,
        customer=getattr(proposal, "customer", None),
        amount=expected_amount,
        currency=currency,
        method=PaymentMethod.BANK_TRANSFER,
        paid_at=timezone.now(),
        recorded_by=actor
        or getattr(proposal, "updated_by", None)
        or getattr(proposal, "created_by", None),
        status=PaymentStatus.PENDING,
        notes=_build_deposit_notes(
            proposal=proposal,
            amount=expected_amount,
            currency=currency,
            percent=percent,
            total=total,
        ),
    )
    # Same live push as :func:`record_payment` — deposit rows created
    # off the kiosk-accept path need to appear on the finance queue
    # without a reload, same as sample rows created off the storefront
    # checkout.
    schedule_payment_changed_broadcast(payment, "created")
    return payment


# ---------------------------------------------------------------------------
# Sample pricing — config + tiers + compute
# ---------------------------------------------------------------------------


def get_or_create_sample_pricing_config(organization) -> SamplePricingConfig:
    """Return the org's :class:`SamplePricingConfig`, creating a
    defaults row on first access.

    Lazily created so finance never has to explicitly "set up" the
    module to unblock a customer — the first portal call that needs
    sample pricing will materialise the row with the model's defaults
    (2 free / £0 per extra / no discount tiers). Idempotent per org
    because of the ``OneToOne`` FK on :class:`SamplePricingConfig`.
    """

    config, _created = SamplePricingConfig.objects.get_or_create(
        organization=organization,
    )
    return config


@transaction.atomic
def upsert_sample_pricing_config(
    *,
    organization,
    actor: Any,
    free_samples_included: int,
    price_per_extra_sample: Decimal,
    currency_code: str,
    tiers: list[dict[str, Any]],
    label_design_fee_amount: Decimal | None = None,
) -> SamplePricingConfig:
    """Wholesale-replace the org's sample pricing config + discount
    tier list.

    ``tiers`` is the full ordered list — every existing tier row is
    deleted and each entry is re-created from the payload. Mirrors
    the "wholesale replace on save" pattern the stage-templates and
    formulation-stages editors use, so the settings UI can treat the
    tier table as a plain array without tracking per-row diffs.

    Guards:
    * ``free_samples_included`` clamped to >= 0.
    * ``price_per_extra_sample`` clamped to >= 0.
    * Each tier: ``quantity_threshold`` > 0, ``discount_percent`` in
      [0, 100]. Duplicates on ``quantity_threshold`` are rejected at
      the DB layer via the unique constraint (serializer enforces the
      friendlier error message).
    """

    config = get_or_create_sample_pricing_config(organization)
    config.free_samples_included = max(0, int(free_samples_included))
    config.price_per_extra_sample = max(
        Decimal("0"), Decimal(str(price_per_extra_sample or 0))
    )
    config.currency_code = (currency_code or "").strip().upper()[:3]
    # Only overwrite the design fee when the caller explicitly sent
    # a value — the settings API may add / remove this field
    # independently; ``None`` preserves whatever's on the row so a
    # partial payload doesn't silently zero it out.
    if label_design_fee_amount is not None:
        config.label_design_fee_amount = max(
            Decimal("0"), Decimal(str(label_design_fee_amount))
        )
    config.updated_by = actor
    config.save(
        update_fields=[
            "free_samples_included",
            "price_per_extra_sample",
            "currency_code",
            "label_design_fee_amount",
            "updated_by",
            "updated_at",
        ]
    )

    # Wholesale replace the tier list. The unique constraint on
    # ``(config, quantity_threshold)`` catches duplicate rows the
    # serializer's own validator missed (defence in depth).
    SamplePricingDiscountTier.objects.filter(config=config).delete()
    ordered = []
    for idx, tier in enumerate(tiers or []):
        threshold = int(tier.get("quantity_threshold") or 0)
        if threshold <= 0:
            continue
        percent = Decimal(str(tier.get("discount_percent") or 0))
        if percent < 0:
            percent = Decimal("0")
        if percent > 100:
            percent = Decimal("100")
        ordered.append(
            SamplePricingDiscountTier(
                config=config,
                quantity_threshold=threshold,
                discount_percent=percent,
                sort_order=idx,
            )
        )
    SamplePricingDiscountTier.objects.bulk_create(ordered)

    record_audit(
        organization=organization,
        actor=actor,
        action="sample_pricing.upsert",
        target=config,
        after={
            "free_samples_included": config.free_samples_included,
            "price_per_extra_sample": str(config.price_per_extra_sample),
            "currency_code": config.currency_code,
            "tier_count": len(ordered),
        },
    )
    return config


def compute_sample_extras_cost(
    *,
    config: SamplePricingConfig,
    ordered_quantity: int,
) -> dict[str, Any]:
    """Compute the "extras" line-item finance charges alongside the
    deposit for a given ``ordered_quantity``.

    Returns a dict with the full breakdown so callers can BOTH persist
    the numbers (SampleAllocation row in PR #3) AND surface them on
    the portal picker (running-total renderer). Shape:

    .. code-block:: python

        {
          "ordered_quantity": 10,
          "free_samples_included": 2,
          "extras_count": 8,
          "unit_price": "250.00",
          "subtotal": "2000.00",
          "discount_percent": "15.00",  # tier or 0
          "discount_amount": "300.00",
          "total": "1700.00",
          "tier_threshold": 10,          # or None if no tier hit
        }

    Discount tier selection: highest ``quantity_threshold`` whose
    value is ``≤ ordered_quantity`` wins. Applies AT THE END to the
    extras subtotal (matching what the user described — "if your
    total is £1,000 and you have 10% discount, you pay £900"). Does
    NOT touch the deposit portion of the bundled invoice; the deposit
    amount rides on the accepted proposal's own ``deposit_percent``
    and gets added on top by the invoice-generation service in
    PR #4.
    """

    ordered_quantity = max(0, int(ordered_quantity or 0))
    free = int(config.free_samples_included or 0)
    extras = max(0, ordered_quantity - free)
    unit_price = Decimal(str(config.price_per_extra_sample or 0))
    subtotal = (unit_price * extras).quantize(Decimal("0.01"))

    tier_threshold: int | None = None
    discount_percent = Decimal("0")
    if extras > 0:
        winning = (
            config.discount_tiers.filter(
                quantity_threshold__lte=ordered_quantity,
            )
            .order_by("-quantity_threshold")
            .first()
        )
        if winning is not None:
            tier_threshold = winning.quantity_threshold
            discount_percent = Decimal(str(winning.discount_percent or 0))

    discount_amount = (
        subtotal * discount_percent / Decimal("100")
    ).quantize(Decimal("0.01"))
    total = (subtotal - discount_amount).quantize(Decimal("0.01"))

    return {
        "ordered_quantity": ordered_quantity,
        "free_samples_included": free,
        "extras_count": extras,
        "unit_price": str(unit_price.quantize(Decimal("0.01"))),
        "subtotal": str(subtotal),
        "discount_percent": str(discount_percent.quantize(Decimal("0.01"))),
        "discount_amount": str(discount_amount),
        "total": str(total),
        "tier_threshold": tier_threshold,
    }


# ---------------------------------------------------------------------------
# Sample allocation — customer's confirmed pick of trial-sample count
# ---------------------------------------------------------------------------


class SampleAllocationLocked(Exception):
    """Raised when a caller tries to edit an already-confirmed
    allocation. Signals the FE to refetch (state moved under it) —
    ``409`` on the wire."""


def get_or_create_sample_allocation(*, formulation) -> SampleAllocation:
    """Idempotent fetch — creates a ``draft`` row at zero quantity
    on first access so the portal picker always has an editable
    target. Wholesale-scoped by the formulation's organization so
    a cross-org accident can't attach to the wrong org's row."""

    allocation, _ = SampleAllocation.objects.get_or_create(
        formulation=formulation,
        defaults={"organization": formulation.organization},
    )
    return allocation


@transaction.atomic
def confirm_sample_allocation(
    *,
    formulation,
    actor,
    quantity_ordered: int,
) -> SampleAllocation:
    """Lock the customer's choice + snapshot the pricing breakdown.

    Rejects re-confirmation of an already-confirmed row — the
    :class:`SampleAllocation` FSM is one-way (draft → confirmed) so
    a customer changing their mind post-confirm has to go through a
    staff-side rollback that isn't wired yet. FE surfaces the 409 as
    "your choice is already locked in".

    Snapshots the compute output onto the row so any subsequent
    settings-page edit to :class:`SamplePricingConfig` doesn't
    retroactively re-price the customer.
    """

    allocation = get_or_create_sample_allocation(formulation=formulation)
    if allocation.status == SampleAllocationStatus.CONFIRMED:
        raise SampleAllocationLocked()

    config = get_or_create_sample_pricing_config(formulation.organization)
    breakdown = compute_sample_extras_cost(
        config=config, ordered_quantity=quantity_ordered,
    )

    allocation.status = SampleAllocationStatus.CONFIRMED
    allocation.quantity_ordered = breakdown["ordered_quantity"]
    allocation.free_samples_included_snapshot = breakdown[
        "free_samples_included"
    ]
    allocation.extras_count = breakdown["extras_count"]
    allocation.unit_price = Decimal(breakdown["unit_price"])
    allocation.subtotal = Decimal(breakdown["subtotal"])
    allocation.discount_percent = Decimal(breakdown["discount_percent"])
    allocation.discount_amount = Decimal(breakdown["discount_amount"])
    allocation.total_extras_cost = Decimal(breakdown["total"])
    allocation.currency_code = (
        config.currency_code or ""
    ).strip().upper()[:3]
    allocation.tier_threshold = breakdown["tier_threshold"]
    allocation.confirmed_at = timezone.now()
    # ``actor`` is the ClientAccount from the portal session — a
    # separate model from platform User, so we can't put it on the
    # audit's ``actor`` FK, but we CAN pin it on ``confirmed_by`` for
    # the sample-allocation audit trail specifically.
    allocation.confirmed_by = actor
    allocation.save()

    record_audit(
        organization=formulation.organization,
        actor=None,  # portal actor isn't a platform user
        action="sample_allocation.confirm",
        target=allocation,
        after={
            "formulation_id": str(formulation.id),
            "quantity_ordered": allocation.quantity_ordered,
            "extras_count": allocation.extras_count,
            "total_extras_cost": str(allocation.total_extras_cost),
            "currency_code": allocation.currency_code,
            "confirmed_by_client_account_id": str(actor.id) if actor else None,
        },
    )

    # Auto-generate the bundled deposit+samples Payment so finance
    # has ONE ready-to-invoice row on their queue the moment the
    # customer commits. Same "one row per commitment" contract the
    # user asked for. Guarded inside the helper (short-circuits if
    # no proposal to compute against, or if a Payment already
    # exists for this proposal — safe on retry).
    payment = ensure_bundled_deposit_payment_for_formulation(
        formulation=formulation,
    )
    if payment is not None:
        allocation.deposit_payment = payment
        allocation.save(update_fields=["deposit_payment", "updated_at"])

    # Push the sample-allocation state to PSP so the kanban board's
    # ``:awaiting_sample_selection`` column updates without a manual
    # sync. Hooked via the proposal-merge sync path since the
    # allocation state ships on the per-line payload there.
    _sync_formulation_proposal_to_psp(formulation)

    return allocation


def _sync_formulation_proposal_to_psp(formulation) -> None:
    """Kick a PSP sync for whichever proposal this formulation is
    attached to. Deferred via ``transaction.on_commit`` so the
    sample-allocation row is committed before PSP fetches — a race
    would leave PSP staring at the old state. Silently no-ops when
    no signed / accepted proposal is attached OR when PSP integration
    isn't configured for the org.
    """

    from django.db import transaction as _transaction

    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    if proposal is None:
        return

    def _do_sync():
        # Local import to dodge the payments → proposals → payments
        # circular that the ``_schedule_proposal_psp_merge`` module
        # already sits behind.
        from apps.proposals.services import _schedule_proposal_psp_merge

        _schedule_proposal_psp_merge(proposal)

    _transaction.on_commit(_do_sync)


def _signed_or_accepted_proposal_for_formulation(formulation) -> Any | None:
    """Find the customer-committed proposal — accepted OR sent-and-
    signed — bundled onto this formulation.

    Wider than :func:`_accepted_proposal_for_formulation`: the
    proposal FSM keeps ``status = sent`` after the customer signs
    (finance flips to ``accepted`` separately), so a customer who's
    signed but whose deal hasn't been finance-accepted yet still
    counts as "committed" for the sample-selection Payment-generation
    flow. Without this widening the Payment could only be created
    AFTER finance accepted the proposal, but the user's design has
    the customer's sample-selection confirm as the trigger — before
    finance touches anything.
    """

    from apps.proposals.models import ProposalLine, ProposalStatus
    from django.db.models import Q

    line = (
        ProposalLine.objects.filter(
            Q(proposal__status=ProposalStatus.ACCEPTED.value)
            | Q(
                proposal__status=ProposalStatus.SENT.value,
                proposal__customer_signed_at__isnull=False,
            ),
            formulation_version__formulation=formulation,
        )
        .select_related("proposal")
        .order_by("-proposal__updated_at")
        .first()
    )
    return line.proposal if line else None


@transaction.atomic
def ensure_bundled_deposit_payment_for_formulation(
    *, formulation, actor=None
) -> Payment | None:
    """Idempotently create a PENDING deposit Payment that bundles
    the proposal-level deposit + the confirmed sample-extras cost
    into a single line on the finance queue.

    Called from :func:`confirm_sample_allocation` so finance sees
    ONE row for the customer's total commitment (per the design:
    "so they have to approve only one line on finance table").

    Guards / no-ops:
    * No customer-committed proposal (signed + sent OR accepted) →
      returns None. Sample-selection confirm without a signed
      proposal can't happen in the FE flow but we defend anyway.
    * No ``deposit_percent > 0`` on the proposal → returns None
      (the whole thing rides the final gate).
    * An existing Payment (kind=DEPOSIT) already exists on this
      proposal → returns None. Prevents dup on retry, on double-
      confirm (which the FSM already blocks but belt-and-braces),
      and on the kiosk-finalize path running after us.

    ``amount = deposit_from_proposal + confirmed_extras_cost``.
    Notes carry the itemised breakdown so finance sees the split
    without having to reconstruct it from two models.
    """

    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    if proposal is None:
        return None
    if not deposit_required_for_proposal(proposal):
        return None
    existing = Payment.objects.filter(
        proposal=proposal, kind=PaymentKind.DEPOSIT,
    ).first()
    if existing is not None:
        return None

    # Deposit portion — same formula as
    # :func:`ensure_pending_deposit_payment` for consistency.
    total_excl_vat = Decimal(str(getattr(proposal, "total_excl_vat", None) or 0))
    percent = Decimal(str(proposal.deposit_percent or 0))
    deposit_amount = (total_excl_vat * percent / Decimal("100")).quantize(
        Decimal("0.01")
    )

    # Samples portion — from the confirmed allocation (may be zero
    # if the customer stayed at the free allowance).
    allocation = SampleAllocation.objects.filter(
        formulation=formulation
    ).first()
    samples_amount = Decimal("0.00")
    samples_qty = 0
    if (
        allocation is not None
        and allocation.status == SampleAllocationStatus.CONFIRMED
    ):
        samples_amount = Decimal(str(allocation.total_extras_cost or 0))
        samples_qty = allocation.quantity_ordered

    total = (deposit_amount + samples_amount).quantize(Decimal("0.01"))
    currency = (
        getattr(proposal, "currency", None) or "GBP"
    ).upper()[:3]

    customer = getattr(proposal, "customer", None)
    samples_line = (
        f"Samples ({samples_qty} units, discount already applied) = "
        f"{_format_money(samples_amount, currency)}"
        if samples_amount > 0
        else f"Samples ({samples_qty} units, all within free allowance) = "
        f"{_format_money(Decimal('0'), currency)}"
    )
    notes_parts = [
        "=== Custom-formulation bundled deposit + samples invoice ===",
        "The customer confirmed their trial-sample quantity, so we're",
        "bundling the R&D deposit and any paid-samples top-up into a",
        "single invoice. Approving this row unlocks the trial-batch",
        "cycle for the R&D team.",
        "",
        f"Customer:      {_customer_label(customer)}",
        f"Product:       {_formulation_label(formulation)}",
        f"Proposal:      {proposal.code or proposal.id}",
        f"Order total:   {_format_money(total_excl_vat, currency)} "
        "(subtotal + freight, excl. VAT)",
        f"Deposit line:  {_format_money(deposit_amount, currency)} "
        f"({percent}% of order total)",
        f"Samples line:  {samples_line}",
        f"THIS INVOICE:  {_format_money(total, currency)}",
        "",
        "Finance next steps:",
        "  1. Send the invoice to the customer via your usual channel.",
        "  2. Mark Approved once payment lands.",
        "  3. On Approve: R&D is unblocked to schedule the first trial",
        "     batch and the sample production starts.",
    ]

    payment = Payment.objects.create(
        organization=proposal.organization,
        kind=PaymentKind.DEPOSIT,
        proposal=proposal,
        formulation=formulation,
        customer=getattr(proposal, "customer", None),
        amount=total,
        currency=currency,
        method=PaymentMethod.BANK_TRANSFER,
        paid_at=timezone.now(),
        recorded_by=(
            actor
            or getattr(proposal, "updated_by", None)
            or getattr(proposal, "created_by", None)
        ),
        status=PaymentStatus.PENDING,
        notes="\n".join(notes_parts),
    )
    schedule_payment_changed_broadcast(payment, "created")
    return payment


# ---------------------------------------------------------------------------
# Final payment (post final-spec-sign)
# ---------------------------------------------------------------------------


# Threshold on the delta between the final-spec-derived invoice and
# the original proposal remainder. When exceeded, the portal sign
# flow surfaces an "Updated price" acknowledgement block instead of
# letting the customer sign against a number they haven't been
# warned about. 15% mirrors the tolerance the sales team already
# uses when re-quoting mid-project.
FINAL_SPEC_DELTA_ACKNOWLEDGEMENT_THRESHOLD_PCT = Decimal("15")


def compute_final_spec_delta(sheet) -> dict[str, Any] | None:
    """Return the "how much has the final invoice moved vs. the
    original proposal remainder?" packet the portal needs to render
    the Updated-price banner + acknowledgement checkbox.

    Returns ``None`` when the sheet isn't a FINAL, has no commercial
    fields set, or has no upstream proposal to compare against —
    the portal hides the banner in those cases and falls back to the
    plain sign card.

    Shape (all string-serialised Decimals for wire safety):

    .. code-block:: python

        {
          "final_spec_total": "12500.00",
          "deposit_paid": "5000.00",
          "amount_due": "7500.00",
          "proposal_remainder": "6250.00",
          "delta_amount": "1250.00",
          "delta_percent": "20.00",
          "requires_acknowledgement": True,
          "currency": "GBP",
        }
    """

    from apps.specifications.models import SpecificationDocumentKind

    if (
        getattr(sheet, "document_kind", None)
        != SpecificationDocumentKind.FINAL
    ):
        return None

    final_total = _final_spec_total(sheet)
    if final_total is None:
        return None

    formulation = getattr(
        getattr(sheet, "formulation_version", None), "formulation", None
    )
    if formulation is None:
        return None

    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    if proposal is None:
        return None
    total_excl_vat = Decimal(str(getattr(proposal, "total_excl_vat", None) or 0))
    deposit_pct = Decimal(str(getattr(proposal, "deposit_percent", None) or 0))
    if total_excl_vat <= 0:
        # No proposal number to compare against — nothing meaningful
        # to render on the banner. Fall back to plain sign.
        return None
    remainder_pct = Decimal("100") - deposit_pct
    proposal_remainder = (
        total_excl_vat * remainder_pct / Decimal("100")
    ).quantize(Decimal("0.01"))

    deposit_paid = deposit_paid_amount_for_formulation(formulation)
    amount_due = (final_total - deposit_paid).quantize(Decimal("0.01"))
    if amount_due < 0:
        amount_due = Decimal("0.00")

    delta_amount = (amount_due - proposal_remainder).quantize(Decimal("0.01"))
    if proposal_remainder == 0:
        delta_percent = Decimal("0")
    else:
        delta_percent = (
            delta_amount / proposal_remainder * Decimal("100")
        ).quantize(Decimal("0.01"))
    requires_ack = (
        abs(delta_percent) > FINAL_SPEC_DELTA_ACKNOWLEDGEMENT_THRESHOLD_PCT
    )
    currency = (getattr(sheet, "currency", "GBP") or "GBP").upper()[:3]
    return {
        "final_spec_total": str(final_total),
        "deposit_paid": str(deposit_paid),
        "amount_due": str(amount_due),
        "proposal_remainder": str(proposal_remainder),
        "delta_amount": str(delta_amount),
        "delta_percent": str(delta_percent),
        "requires_acknowledgement": bool(requires_ack),
        "threshold_percent": str(
            FINAL_SPEC_DELTA_ACKNOWLEDGEMENT_THRESHOLD_PCT
        ),
        "currency": currency,
    }


def deposit_paid_amount_for_formulation(formulation) -> Decimal:
    """Sum of APPROVED deposit Payment amounts on this formulation's
    accepted / signed proposal. Used as the credit against the
    final-spec total when generating the final invoice — customer
    paid £X at deposit, so the final invoice is
    ``final_spec_total − X``.
    """

    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    if proposal is None:
        return Decimal("0.00")
    approved = Payment.objects.filter(
        proposal=proposal,
        kind=PaymentKind.DEPOSIT,
        status=PaymentStatus.APPROVED,
    )
    total = sum((p.amount or Decimal("0")) for p in approved)
    return Decimal(total).quantize(Decimal("0.01"))


def is_final_payment_approved_for_formulation(formulation) -> bool:
    """Mirror of :func:`is_deposit_paid_for_proposal` for the FINAL
    invoice that lands after the customer signs the final spec.
    Powers the pipeline "Payment received" state on the portal.
    """

    return Payment.objects.filter(
        formulation=formulation,
        kind=PaymentKind.FINAL,
        status=PaymentStatus.APPROVED,
    ).exists()


def _final_spec_total(sheet) -> Decimal | None:
    """Return the final invoice total from the sheet's own commercial
    fields — ``final_price × quantity``. Returns ``None`` when the
    scientist hasn't set a price on the spec yet (nothing to invoice).
    """

    final_price = getattr(sheet, "final_price", None)
    quantity = getattr(sheet, "quantity", None) or 0
    if final_price is None or quantity <= 0:
        return None
    total = (Decimal(str(final_price)) * Decimal(int(quantity))).quantize(
        Decimal("0.01")
    )
    return total


@transaction.atomic
def ensure_final_payment_for_formulation(
    *, formulation, sheet, actor=None
) -> Payment | None:
    """Idempotently create the FINAL invoice Payment once the customer
    signs a FINAL spec.

    Called from :func:`apps.specifications.services.accept_as_customer`
    on a FINAL sign via ``transaction.on_commit`` so a rollback in
    the sign path doesn't leak a Payment row.

    Amount math:

    * ``final_spec_total = sheet.final_price × sheet.quantity``
    * ``deposit_paid = sum(approved DEPOSIT amounts on proposal)``
    * ``amount_due = max(0, final_spec_total − deposit_paid)``

    The deposit-credit split lives in ``notes`` so finance sees the
    reasoning without having to reconstruct it from two models.

    Guards / no-ops:

    * The sheet has no ``final_price`` / ``quantity > 0`` — nothing
      to invoice; returns None.
    * A ``Payment(kind=FINAL, formulation=…)`` already exists —
      idempotent short-circuit. Handles double-fire (retry, replay).
    * The sign wasn't on a FINAL spec — caller filters this, but the
      guard is here defensively.
    """

    from apps.specifications.models import SpecificationDocumentKind

    if (
        getattr(sheet, "document_kind", None)
        != SpecificationDocumentKind.FINAL
    ):
        return None

    existing = Payment.objects.filter(
        formulation=formulation,
        kind=PaymentKind.FINAL,
    ).first()
    if existing is not None:
        return None

    total = _final_spec_total(sheet)
    if total is None:
        logger.error(
            "Final spec %s has no final_price × quantity set — cannot "
            "auto-create the FINAL Payment.",
            getattr(sheet, "id", None),
        )
        return None

    deposit_paid = deposit_paid_amount_for_formulation(formulation)
    amount_due = (total - deposit_paid).quantize(Decimal("0.01"))
    if amount_due < 0:
        # Customer paid more at deposit than the final spec now says —
        # log so finance can process a credit / refund, but still
        # create a zero-amount row so the pipeline advances and
        # finance has a place to record their decision.
        logger.warning(
            "Final invoice for formulation %s would be negative "
            "(deposit %s > final %s). Creating at 0.00; finance to "
            "process credit manually.",
            getattr(formulation, "id", None),
            deposit_paid,
            total,
        )
        amount_due = Decimal("0.00")

    currency = (getattr(sheet, "currency", "GBP") or "GBP").upper()[:3]
    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    customer = (
        getattr(proposal, "customer", None)
        or getattr(formulation, "customer", None)
    )
    recorded_by = (
        actor
        or getattr(formulation, "updated_by", None)
        or getattr(formulation, "created_by", None)
    )

    payment = Payment.objects.create(
        organization=formulation.organization,
        kind=PaymentKind.FINAL,
        formulation=formulation,
        customer=customer,
        amount=amount_due,
        currency=currency,
        method=PaymentMethod.BANK_TRANSFER,
        paid_at=timezone.now(),
        recorded_by=recorded_by,
        status=PaymentStatus.PENDING,
        notes=_build_final_payment_notes(
            formulation=formulation,
            sheet=sheet,
            total=total,
            deposit_paid=deposit_paid,
            amount_due=amount_due,
            currency=currency,
        ),
    )
    schedule_payment_changed_broadcast(payment, "created")
    return payment


def ensure_label_design_payment_for_formulation(
    *, formulation, actor=None
) -> Payment | None:
    """Idempotently create the LABEL_DESIGN invoice Payment when the
    customer picks ``design_by_us`` on the label workflow.

    Called from :class:`PortalLabelDesignChoosePathView.post` inside
    the same transaction as the ``LABEL_PATH_PENDING → DESIGN_FEE_PENDING``
    transition, so a rollback of the choose-path request tears the
    payment down too.

    Amount pulled from
    :class:`~apps.payments.models.SamplePricingConfig.label_design_fee_amount`
    for the workflow's org. Returns ``None`` when the fee is 0 /
    unset — the caller then skips the ``DESIGN_FEE_PENDING`` gate
    and transitions straight to ``DESIGN_PREFERENCES_PENDING`` for a
    free design.
    """

    existing = Payment.objects.filter(
        formulation=formulation,
        kind=PaymentKind.LABEL_DESIGN,
        status__in=(PaymentStatus.PENDING, PaymentStatus.APPROVED),
    ).first()
    if existing is not None:
        return existing

    config = get_or_create_sample_pricing_config(formulation.organization)
    amount = Decimal(config.label_design_fee_amount or 0)
    if amount <= 0:
        return None

    currency_from_config = (config.currency_code or "").strip()
    company_currency = (
        getattr(getattr(formulation.organization, "company", None), "currency_code", "")
        or ""
    ).strip()
    currency = (currency_from_config or company_currency or "GBP").upper()[:3]

    proposal = _signed_or_accepted_proposal_for_formulation(formulation)
    customer = (
        getattr(proposal, "customer", None)
        or getattr(formulation, "customer", None)
    )
    recorded_by = (
        actor
        or getattr(formulation, "updated_by", None)
        or getattr(formulation, "created_by", None)
    )

    notes = "\n".join(
        [
            "=== Label-design fee (customer picked ‘Vita designs’) ===",
            "The customer chose to have our design team produce the",
            "artwork rather than uploading their own. This row is the",
            "design fee — approving it unlocks the design-brief step",
            "on the label workflow so the customer can send us their",
            "brand colours, style, and inspirational examples.",
            "",
            f"Customer:      {_customer_label(customer)}",
            f"Product:       {_formulation_label(formulation)}",
            f"THIS INVOICE:  {_format_money(amount, currency)}",
            "",
            "Finance next steps:",
            "  1. Send the design-fee invoice to the customer.",
            "  2. Mark Approved once payment lands.",
            "  3. On Approve: the design team is unblocked and the",
            "     customer sees ‘Share your design brief’ on the portal.",
        ]
    )

    payment = Payment.objects.create(
        organization=formulation.organization,
        kind=PaymentKind.LABEL_DESIGN,
        formulation=formulation,
        customer=customer,
        amount=amount,
        currency=currency,
        method=PaymentMethod.BANK_TRANSFER,
        paid_at=timezone.now(),
        recorded_by=recorded_by,
        status=PaymentStatus.PENDING,
        notes=notes,
    )
    schedule_payment_changed_broadcast(payment, "created")
    return payment
