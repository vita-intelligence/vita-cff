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
from apps.payments.constants import PaymentMethod, PaymentStatus
from apps.payments.models import Payment


class PaymentAlreadyApproved(Exception):
    api_code = "payments.already_approved"


class PaymentAlreadyVoided(Exception):
    api_code = "payments.already_voided"


@transaction.atomic
def record_payment(
    *,
    formulation,
    actor,
    amount: Decimal,
    paid_at: datetime,
    method: str = PaymentMethod.BANK_TRANSFER,
    currency: str = "GBP",
    external_reference: str = "",
    invoice_number: str = "",
    notes: str = "",
    label_design: LabelDesign | None = None,
) -> Payment:
    """Persist a new payment in ``PENDING`` status.

    The label-design link is best-effort: if the caller does not
    pass one we look up the matching ``LabelDesign`` by
    ``formulation`` (and accept None if the project has not yet
    been bootstrapped — the signal will catch up later).
    """

    if label_design is None:
        label_design = LabelDesign.objects.filter(formulation=formulation).first()

    payment = Payment.objects.create(
        organization=formulation.organization,
        formulation=formulation,
        label_design=label_design,
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
        organization=formulation.organization,
        actor=actor,
        action="payment.record",
        target=payment,
        before=None,
        after={
            "amount": str(amount),
            "currency": currency,
            "method": method,
            "status": payment.status,
        },
    )
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

    # One LabelDesign per formulation. Prefer the explicit FK if the
    # payment carried one; fall back to the formulation lookup for
    # rows recorded before the FK was consistently populated.
    label_design = payment.label_design
    if label_design is None:
        label_design = LabelDesign.objects.filter(
            formulation_id=payment.formulation_id
        ).first()
    advanced_ids: list[str] = []
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
    return payment
