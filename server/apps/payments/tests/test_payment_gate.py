"""Payment gate end-to-end: recording + approving a payment drives
the matching LabelDesign forward from ``PAYMENT_PENDING`` to
``LABEL_PATH_PENDING``. Voiding does NOT roll back."""

from __future__ import annotations

import datetime as _dt
from decimal import Decimal

import pytest

from apps.formulations.models import ProjectStatus
from apps.formulations.tests.factories import FormulationFactory
from apps.label_design.constants import LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.payments.constants import PaymentMethod, PaymentStatus
from apps.payments.models import Payment
from apps.payments.services import (
    PaymentAlreadyApproved,
    PaymentAlreadyVoided,
    approve_payment,
    record_payment,
    void_payment,
)


pytestmark = pytest.mark.django_db


def _make_approved_project():
    """Build an APPROVED project with a LabelDesign at PAYMENT_PENDING.

    The bootstrap signal now requires a customer-signed **final**
    spec sheet to fire, and these tests care about the
    payment→LabelDesign gate rather than the bootstrap trigger
    itself. Materialising the LabelDesign directly keeps the test
    focused on the transition being verified.
    """

    formulation = FormulationFactory(project_status=ProjectStatus.APPROVED)
    label_design, _ = LabelDesign.objects.get_or_create(
        formulation=formulation,
        defaults={
            "organization": formulation.organization,
            "status": LabelDesignStatus.PAYMENT_PENDING,
        },
    )
    return formulation, label_design


class TestPaymentRecording:
    def test_recording_creates_pending_row(self):
        formulation, label_design = _make_approved_project()
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("1500.00"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
            method=PaymentMethod.BANK_TRANSFER,
            invoice_number="INV-001",
        )
        assert payment.status == PaymentStatus.PENDING
        assert payment.label_design == label_design
        assert payment.amount == Decimal("1500.00")
        # The LabelDesign is still PAYMENT_PENDING — only approval
        # advances the gate.
        label_design.refresh_from_db()
        assert label_design.status == LabelDesignStatus.PAYMENT_PENDING

    def test_recording_without_label_design_does_not_crash(self):
        # Build a project that has NOT been flipped to APPROVED so
        # the signal has not bootstrapped a LabelDesign yet. The
        # service should accept the payment with a null FK.
        formulation = FormulationFactory(project_status=ProjectStatus.IN_DEVELOPMENT)
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("500"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        assert payment.label_design is None
        assert payment.status == PaymentStatus.PENDING


class TestPaymentApproval:
    def test_approval_flips_label_design_to_label_path_pending(self):
        formulation, label_design = _make_approved_project()
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("1500"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        payment = approve_payment(payment=payment, actor=formulation.created_by)
        assert payment.status == PaymentStatus.APPROVED
        label_design.refresh_from_db()
        assert label_design.status == LabelDesignStatus.LABEL_PATH_PENDING

    def test_double_approval_raises(self):
        formulation, _ = _make_approved_project()
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("1500"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        approve_payment(payment=payment, actor=formulation.created_by)
        with pytest.raises(PaymentAlreadyApproved):
            approve_payment(payment=payment, actor=formulation.created_by)

    def test_approval_no_op_if_label_design_already_advanced(self):
        """If the workflow has already moved past PAYMENT_PENDING for
        some other reason, an approval mustn't try to roll it back —
        the transition_status validator would refuse, but the
        approve_payment service short-circuits on the status check
        so the approval still lands cleanly on the Payment row."""

        formulation, label_design = _make_approved_project()
        # Manually advance the label design past PAYMENT_PENDING.
        LabelDesign.objects.filter(pk=label_design.pk).update(
            status=LabelDesignStatus.DESIGN_IN_PROGRESS
        )
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("1500"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        payment = approve_payment(payment=payment, actor=formulation.created_by)
        assert payment.status == PaymentStatus.APPROVED
        label_design.refresh_from_db()
        assert label_design.status == LabelDesignStatus.DESIGN_IN_PROGRESS


class TestPaymentVoid:
    def test_void_marks_row_but_keeps_label_design_state(self):
        formulation, label_design = _make_approved_project()
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("1500"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        approve_payment(payment=payment, actor=formulation.created_by)
        # LabelDesign moved forward; voiding the payment must NOT
        # roll it back — forward-only on the LabelDesign side.
        label_design.refresh_from_db()
        assert label_design.status == LabelDesignStatus.LABEL_PATH_PENDING

        payment = void_payment(
            payment=payment, actor=formulation.created_by, notes="duplicate"
        )
        assert payment.status == PaymentStatus.VOIDED
        label_design.refresh_from_db()
        assert label_design.status == LabelDesignStatus.LABEL_PATH_PENDING

    def test_double_void_raises(self):
        formulation, _ = _make_approved_project()
        payment = record_payment(
            formulation=formulation,
            actor=formulation.created_by,
            amount=Decimal("100"),
            paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        )
        void_payment(payment=payment, actor=formulation.created_by)
        with pytest.raises(PaymentAlreadyVoided):
            void_payment(payment=payment, actor=formulation.created_by)
