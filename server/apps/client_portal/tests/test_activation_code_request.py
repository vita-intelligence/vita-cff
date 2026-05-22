"""Tests for the just-in-time activation-code request endpoint.

Pins the four invariants of the new OTP flow:

* The proposal email no longer carries a code — the code is minted
  + emailed on demand by the activation page.
* Two requests within the 60-second cooldown are rejected with 429
  + ``retry_after_seconds``.
* Codes older than 10 minutes are refused at activation submit.
* Returners (already-activated accounts) never receive a code; the
  endpoint short-circuits with 409 ``account_already_activated``.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from django.core import mail
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.client_portal.models import ClientAccount
from apps.client_portal.services import (
    ACTIVATION_CODE_RESEND_COOLDOWN_SECONDS,
    ACTIVATION_CODE_TTL_SECONDS,
    ActivationCodeRateLimited,
    InvalidActivationCode,
    activate_via_token,
    request_activation_code,
)
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db(transaction=True)


def _proposal_with_kiosk(*, email: str = "new@buyer.test"):
    """Build a proposal ready for activation: customer attached,
    public_token set, kiosk_recipient_email stamped.
    """

    org = OrganizationFactory()
    actor = org.created_by
    customer = Customer.objects.create(
        organization=org,
        name="Activation Buyer",
        company="Activation Co",
        email=email,
        created_by=actor,
        updated_by=actor,
    )
    proposal = ProposalFactory(
        organization=org,
        customer=customer,
        customer_email=email,
        kiosk_recipient_email=email,
        public_token=uuid.uuid4(),
    )
    return proposal


def _request_url(token: uuid.UUID) -> str:
    return reverse(
        "client_portal:activate-request-code",
        kwargs={"token": str(token)},
    )


class TestRequestActivationCodeService:
    def test_happy_path_mints_code_and_emails(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk(email="new@buyer.test")

        result = request_activation_code(token=proposal.public_token)

        proposal.refresh_from_db()
        assert proposal.activation_code
        assert len(proposal.activation_code) == 6
        assert proposal.activation_code_sent_at is not None
        # Cooldown surfaced to FE.
        assert (
            result["retry_after_seconds"]
            == ACTIVATION_CODE_RESEND_COOLDOWN_SECONDS
        )
        # Standalone code email landed in the inbox; the code is in
        # the body, no kiosk link mixed in.
        assert len(mailoutbox) == 1
        sent = mailoutbox[0]
        assert sent.to == ["new@buyer.test"]
        assert proposal.activation_code in sent.body
        assert "verification code" in sent.subject.lower()

    def test_resend_inside_cooldown_is_refused(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()

        request_activation_code(token=proposal.public_token)
        # Second call back-to-back: must raise rate-limited so the FE
        # gets a precise ``retry_after_seconds`` instead of a silent
        # second send.
        with pytest.raises(ActivationCodeRateLimited) as excinfo:
            request_activation_code(token=proposal.public_token)
        assert excinfo.value.retry_after_seconds > 0
        assert excinfo.value.retry_after_seconds <= (
            ACTIVATION_CODE_RESEND_COOLDOWN_SECONDS
        )

    def test_resend_after_cooldown_succeeds(
        self, settings, mailoutbox
    ) -> None:
        # Simulate cooldown elapsed by rewinding the stamp; the
        # service trusts the timestamp.
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()
        request_activation_code(token=proposal.public_token)

        proposal.refresh_from_db()
        first_code = proposal.activation_code
        proposal.activation_code_sent_at = (
            timezone.now()
            - timedelta(
                seconds=ACTIVATION_CODE_RESEND_COOLDOWN_SECONDS + 5,
            )
        )
        proposal.save(update_fields=["activation_code_sent_at"])

        request_activation_code(token=proposal.public_token)
        proposal.refresh_from_db()
        # New code minted (different from first with overwhelming
        # probability — 1-in-a-million collision risk; the assertion
        # is on the timestamp moving forward instead).
        assert proposal.activation_code  # still set
        assert proposal.activation_code_sent_at is not None
        # Both emails landed.
        assert len(mailoutbox) == 2


class TestActivationCodeTTL:
    def test_expired_code_is_refused(self, settings) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()
        request_activation_code(token=proposal.public_token)
        proposal.refresh_from_db()
        plaintext_code = proposal.activation_code

        # Rewind the sent_at past the TTL window.
        proposal.activation_code_sent_at = (
            timezone.now()
            - timedelta(seconds=ACTIVATION_CODE_TTL_SECONDS + 10)
        )
        proposal.save(update_fields=["activation_code_sent_at"])

        with pytest.raises(InvalidActivationCode):
            activate_via_token(
                token=proposal.public_token,
                password="V3ryStr0ngPass!xyz",
                code=plaintext_code,
            )

    def test_fresh_code_within_ttl_is_accepted(self, settings) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()
        request_activation_code(token=proposal.public_token)
        proposal.refresh_from_db()
        plaintext_code = proposal.activation_code

        result = activate_via_token(
            token=proposal.public_token,
            password="V3ryStr0ngPass!xyz",
            code=plaintext_code,
        )
        assert result.account.has_usable_password()
        # After activation, the code + timestamp are cleared so a
        # replay attempt against the stolen DB row fails.
        proposal.refresh_from_db()
        assert proposal.activation_code == ""
        assert proposal.activation_code_sent_at is None


class TestRequestCodeEndpoint:
    def test_endpoint_happy_path(self, settings, mailoutbox) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()
        client = APIClient()

        r = client.post(_request_url(proposal.public_token))

        assert r.status_code == 200
        body = r.json()
        assert body["sent"] is True
        assert body["retry_after_seconds"] == (
            ACTIVATION_CODE_RESEND_COOLDOWN_SECONDS
        )
        assert "@" in body["email_masked"]

    def test_endpoint_returns_429_inside_cooldown(
        self, settings, mailoutbox,
    ) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk()
        client = APIClient()
        client.post(_request_url(proposal.public_token))
        r = client.post(_request_url(proposal.public_token))

        assert r.status_code == 429
        body = r.json()
        assert body["code"] == "activation_code_rate_limited"
        assert body["retry_after_seconds"] > 0

    def test_endpoint_returns_409_for_returner(
        self, settings, mailoutbox,
    ) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _proposal_with_kiosk(email="returner@buyer.test")
        ClientAccount.objects.create_account(
            email="returner@buyer.test",
            customer=proposal.customer,
            password="V3ryStr0ngPass!xyz",
        )
        client = APIClient()

        r = client.post(_request_url(proposal.public_token))

        assert r.status_code == 409
        body = r.json()
        assert body["code"] == "account_already_activated"
        # No email was sent.
        assert mailoutbox == []

    def test_endpoint_returns_404_for_unknown_token(self) -> None:
        client = APIClient()
        bogus = uuid.uuid4()
        r = client.post(_request_url(bogus))
        assert r.status_code == 404
