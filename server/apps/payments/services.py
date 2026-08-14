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

from datetime import datetime
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record as record_audit
from apps.label_design.constants import LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.label_design.services import transition_status as label_design_transition
from apps.payments.broadcast import schedule_payment_changed_broadcast
from apps.payments.constants import PaymentKind, PaymentMethod, PaymentStatus
from apps.payments.models import Payment


class PaymentAlreadyApproved(Exception):
    api_code = "payments.already_approved"


class PaymentAlreadyVoided(Exception):
    api_code = "payments.already_voided"


class PaymentKindConflict(Exception):
    api_code = "payments.kind_conflict"


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

    # Sample payments — push the fresh payment state to PSP so the
    # CO detail's NPD-payment card reflects the approval + any
    # attached invoice files. Silent-degrade, no-op for non-sample
    # payments. Fires on commit so a rollback doesn't leave PSP
    # thinking we approved when we didn't.
    def _resync_sample() -> None:
        from apps.psp.services import maybe_resync_sample_payment_to_psp

        fresh = Payment.objects.filter(pk=payment_pk).first()
        if fresh is not None:
            maybe_resync_sample_payment_to_psp(payment=fresh)

    transaction.on_commit(_resync_sample)

    # Scientist notification — approval is when the sample is
    # actually unlocked for the scientist to spin up a trial batch.
    # Gated on sample-payment kind inside the notification module.
    def _fire_scientist_notification() -> None:
        from apps.payments.staff_notifications import (
            notify_scientists_sample_ready,
        )

        notify_scientists_sample_ready(payment_id=payment_pk)

    transaction.on_commit(_fire_scientist_notification)

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

    # Sample payments — push the voided state to PSP so the CO
    # detail card can render "Voided" instead of showing a paid
    # invoice for an order that isn't happening. Same silent-degrade
    # posture as the approve path.
    payment_pk = payment.pk

    def _resync_sample_on_void() -> None:
        from apps.psp.services import maybe_resync_sample_payment_to_psp

        fresh = Payment.objects.filter(pk=payment_pk).first()
        if fresh is not None:
            maybe_resync_sample_payment_to_psp(payment=fresh)

    transaction.on_commit(_resync_sample_on_void)

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

    proposal = _accepted_proposal_for_formulation(formulation)
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
    payment = Payment.objects.create(
        organization=proposal.organization,
        kind=PaymentKind.DEPOSIT,
        proposal=proposal,
        customer=getattr(proposal, "customer", None),
        amount=expected_amount,
        currency=getattr(proposal, "currency", "GBP"),
        method=PaymentMethod.BANK_TRANSFER,
        paid_at=timezone.now(),
        recorded_by=actor
        or getattr(proposal, "updated_by", None)
        or getattr(proposal, "created_by", None),
        status=PaymentStatus.PENDING,
        notes=(
            f"Auto-created on customer kiosk sign of {proposal.code}. "
            f"Expected {expected_amount} {getattr(proposal, 'currency', 'GBP')} "
            f"({percent}% deposit)."
        ),
    )
    # Same live push as :func:`record_payment` — deposit rows created
    # off the kiosk-accept path need to appear on the finance queue
    # without a reload, same as sample rows created off the storefront
    # checkout.
    schedule_payment_changed_broadcast(payment, "created")
    return payment
