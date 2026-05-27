"""Email hook on Payment ``pending → approved``.

Mirrors ``apps/specifications/tests/test_final_spec_email.py`` —
``mail.outbox`` capture, fixture-driven ``APP_BASE_URL`` override.
"""

from __future__ import annotations

import datetime as _dt
from decimal import Decimal

import pytest
from django.core import mail
from django.test import TestCase

from apps.formulations.models import ProjectStatus
from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.payments.constants import PaymentMethod
from apps.payments.models import Payment
from apps.payments.services import approve_payment, record_payment
from apps.proposals.models import Proposal


pytestmark = pytest.mark.django_db


def _make_paid_project(*, customer_email: str = "max@local.test"):
    formulation = FormulationFactory(project_status=ProjectStatus.APPROVED)
    org = formulation.organization
    version = save_version(formulation=formulation, actor=org.created_by)

    # Build a customer + proposal so the email service can find a
    # recipient via the same chain it uses in production.
    from apps.customers.models import Customer

    customer = Customer.objects.create(
        organization=org,
        email=customer_email,
        name="Max Test",
        company="Test Co",
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    Proposal.objects.create(
        organization=org,
        formulation_version=version,
        code="PROP-EMAIL-001",
        template_type="custom",
        status="accepted",
        currency="GBP",
        quantity=1,
        customer=customer,
        customer_name=customer.name,
        customer_email=customer.email,
        customer_company=customer.company,
        created_by=org.created_by,
        updated_by=org.created_by,
    )

    payment = record_payment(
        formulation=formulation,
        actor=org.created_by,
        amount=Decimal("1500.00"),
        paid_at=_dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc),
        method=PaymentMethod.BANK_TRANSFER,
        invoice_number="INV-EMAIL-001",
        external_reference="REF-7",
    )
    return payment, org


class TestPaymentReceivedEmailHook:
    @pytest.fixture(autouse=True)
    def _override_app_base_url(self, settings):
        settings.APP_BASE_URL = "https://app.example.test"
        yield

    def test_email_fires_on_approve(self):
        payment, org = _make_paid_project()
        with TestCase.captureOnCommitCallbacks(execute=True):
            approve_payment(payment=payment, actor=org.created_by)
        assert len(mail.outbox) == 1
        msg = mail.outbox[0]
        assert msg.to == ["max@local.test"]
        assert "payment received" in msg.subject.lower()
        body = msg.body + (msg.alternatives[0][0] if msg.alternatives else "")
        # Receipt fields render.
        assert "1500.00" in body
        assert "INV-EMAIL-001" in body
        # Portal CTA points at the per-project journey page.
        assert "https://app.example.test/portal/products/" in body

    def test_email_skipped_when_no_customer_email(self):
        payment, org = _make_paid_project(customer_email="")
        with TestCase.captureOnCommitCallbacks(execute=True):
            approve_payment(payment=payment, actor=org.created_by)
        assert len(mail.outbox) == 0
