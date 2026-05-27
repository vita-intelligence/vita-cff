"""Email hook on FINAL spec sheets transitioning ``approved → sent``.

The email itself is a thin wrapper over Django's ``EmailMultiAlternatives``
— we don't reach the SMTP relay in tests. Instead we assert that the
dispatch fired (via the in-memory ``mail.outbox`` capture) and that
key bits of the message (recipient, subject, portal link) are right.
"""

from __future__ import annotations

import pytest
from django.core import mail
from django.test import TestCase

from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)
from apps.specifications.services import transition_status


pytestmark = pytest.mark.django_db


def _make_approved_final_spec(*, customer_email: str = "max@local.test"):
    formulation = FormulationFactory(name="Hydration Serum")
    org = formulation.organization
    version = save_version(formulation=formulation, actor=org.created_by)
    sheet = SpecificationSheet.objects.create(
        organization=org,
        formulation_version=version,
        code="MA521352-FINAL",
        document_kind=SpecificationDocumentKind.FINAL,
        status=SpecificationStatus.APPROVED,
        client_name="Max Test",
        client_email=customer_email,
        client_company="Local Test Co",
        customer_email=customer_email,
        customer_name="Max Test",
        customer_company="Local Test Co",
        director_user=org.created_by,
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    return sheet, org


class TestFinalSpecEmailHook:
    # ``override_settings`` only works on TestCase subclasses; we use a
    # pytest fixture below to swap APP_BASE_URL for each test instead.
    @pytest.fixture(autouse=True)
    def _override_app_base_url(self, settings):
        settings.APP_BASE_URL = "https://app.example.test"
        yield
    def test_email_fires_on_approved_to_sent_for_final(self):
        sheet, org = _make_approved_final_spec()
        with TestCase.captureOnCommitCallbacks(execute=True):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status=SpecificationStatus.SENT,
            )
        assert len(mail.outbox) == 1
        msg = mail.outbox[0]
        assert msg.to == ["max@local.test"]
        assert "final specification" in msg.subject.lower()
        # Portal link references the spec id and the configured base URL.
        body = msg.body + (msg.alternatives[0][0] if msg.alternatives else "")
        assert "https://app.example.test/portal/specs/" in body
        assert str(sheet.pk) in body

    def test_email_skipped_when_customer_email_blank(self):
        sheet, org = _make_approved_final_spec(customer_email="")
        with TestCase.captureOnCommitCallbacks(execute=True):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status=SpecificationStatus.SENT,
            )
        assert len(mail.outbox) == 0

    def test_email_skipped_for_non_final_specs(self):
        sheet, org = _make_approved_final_spec()
        SpecificationSheet.objects.filter(pk=sheet.pk).update(
            document_kind=SpecificationDocumentKind.DRAFT,
        )
        sheet.refresh_from_db()
        with TestCase.captureOnCommitCallbacks(execute=True):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status=SpecificationStatus.SENT,
            )
        assert len(mail.outbox) == 0
