"""Tests for the password-reset flow.

The suite pins three orthogonal contracts that the feature is built
around:

* **Enumeration safety** — the request endpoint must respond
  identically for known and unknown emails; the only difference is
  whether a mail is dispatched.
* **Token lifecycle** — issued → consumed | expired | invalidated,
  with each terminal state emitting a distinct, machine-readable
  code so the frontend can render a precise message.
* **Abuse resistance** — per-email and per-IP throttles cap the
  endpoints below the thresholds an attacker would need for
  inbox-flooding or token brute-forcing.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core import mail as django_mail
from django.core.cache import cache
from django.urls import reverse
from django.utils import timezone
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.models import PASSWORD_RESET_TOKEN_TTL, PasswordResetToken
from apps.accounts.services import (
    PasswordResetPasswordInvalid,
    PasswordResetTokenExpired,
    PasswordResetTokenInvalidated,
    PasswordResetTokenInvalid,
    PasswordResetTokenUsed,
    _hash_token,
    consume_password_reset_token,
    request_password_reset,
    validate_password_reset_token,
)
from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory

pytestmark = pytest.mark.django_db

UserModel = get_user_model()
NEW_PASSWORD = "Br4nd-new!Pa55phrase"


@pytest.fixture(autouse=True)
def _flush_throttle_cache() -> None:
    """Wipe DRF's throttle cache between tests.

    Throttles live in the default Django cache, which persists
    across tests in a single process. Without an explicit flush a
    test that exercises the limit would poison every later test
    that tries to hit the same endpoint.
    """

    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _request_url() -> str:
    return reverse("accounts:password-reset-request")


def _validate_url() -> str:
    return reverse("accounts:password-reset-validate")


def _confirm_url() -> str:
    return reverse("accounts:password-reset-confirm")


# ---------------------------------------------------------------------------
# Service: request_password_reset
# ---------------------------------------------------------------------------


class TestRequestPasswordResetService:
    def test_returns_none_for_unknown_email(self) -> None:
        result = request_password_reset(email="ghost@nowhere.test")
        assert result is None
        assert PasswordResetToken.objects.count() == 0

    def test_returns_none_for_inactive_user(self) -> None:
        user = UserFactory(email="sleepy@vita.test")
        user.is_active = False
        user.save(update_fields=["is_active"])

        result = request_password_reset(email="sleepy@vita.test")
        assert result is None
        assert PasswordResetToken.objects.filter(user=user).count() == 0

    def test_issues_fresh_token_for_active_user(self) -> None:
        user = UserFactory(email="alex@vita.test")

        issued = request_password_reset(
            email="alex@vita.test", requested_ip="203.0.113.7"
        )
        assert issued is not None
        assert issued.plaintext  # actually has content
        assert issued.record.user_id == user.id
        assert issued.record.requested_ip == "203.0.113.7"
        # The plaintext should not equal the stored hash — the row
        # only carries the digest.
        assert issued.record.token_hash != issued.plaintext
        assert issued.record.token_hash == _hash_token(issued.plaintext)
        # Expiry honours the documented TTL.
        delta = issued.record.expires_at - issued.record.created_at
        assert abs(delta - PASSWORD_RESET_TOKEN_TTL) < timedelta(seconds=2)

    def test_email_lookup_is_case_insensitive(self) -> None:
        UserFactory(email="case@vita.test")
        issued = request_password_reset(email="CASE@VITA.TEST")
        assert issued is not None

    def test_second_request_invalidates_first_token(self) -> None:
        user = UserFactory(email="repeat@vita.test")
        first = request_password_reset(email="repeat@vita.test")
        assert first is not None

        second = request_password_reset(email="repeat@vita.test")
        assert second is not None
        assert second.record.id != first.record.id

        first.record.refresh_from_db()
        assert first.record.invalidated_at is not None
        assert second.record.invalidated_at is None


# ---------------------------------------------------------------------------
# Service: validate / consume
# ---------------------------------------------------------------------------


class TestValidatePasswordResetToken:
    def test_validates_fresh_token(self) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        record = validate_password_reset_token(token=issued.plaintext)
        assert record.id == issued.record.id

    def test_unknown_token_raises_invalid(self) -> None:
        with pytest.raises(PasswordResetTokenInvalid):
            validate_password_reset_token(token="not-a-real-token")

    def test_empty_token_raises_invalid(self) -> None:
        with pytest.raises(PasswordResetTokenInvalid):
            validate_password_reset_token(token="")

    def test_expired_token_raises_expired(self) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        # Drag expiry into the past.
        PasswordResetToken.objects.filter(pk=issued.record.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        with pytest.raises(PasswordResetTokenExpired):
            validate_password_reset_token(token=issued.plaintext)

    def test_used_token_raises_used(self) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        consume_password_reset_token(
            token=issued.plaintext, new_password=NEW_PASSWORD
        )
        with pytest.raises(PasswordResetTokenUsed):
            validate_password_reset_token(token=issued.plaintext)

    def test_invalidated_token_raises_invalidated(self) -> None:
        UserFactory(email="alex@vita.test")
        first = request_password_reset(email="alex@vita.test")
        request_password_reset(email="alex@vita.test")  # supersedes
        assert first is not None
        with pytest.raises(PasswordResetTokenInvalidated):
            validate_password_reset_token(token=first.plaintext)


class TestConsumePasswordResetToken:
    def test_consumes_and_rotates_password(self) -> None:
        user = UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        old_hash = user.password

        consume_password_reset_token(
            token=issued.plaintext, new_password=NEW_PASSWORD
        )

        user.refresh_from_db()
        assert user.password != old_hash
        assert user.check_password(NEW_PASSWORD)
        issued.record.refresh_from_db()
        assert issued.record.used_at is not None

    def test_consume_burns_sibling_active_tokens(self) -> None:
        user = UserFactory(email="alex@vita.test")
        # Two outstanding requests that haven't yet been
        # invalidated by a fresher mail (simulate a race window
        # where the request endpoint dispatched the email before
        # the next request arrived).
        first = request_password_reset(email="alex@vita.test")
        second = request_password_reset(email="alex@vita.test")
        assert first is not None and second is not None
        # Manually un-invalidate first so we can verify the
        # consume path also kills siblings, not just the request
        # path.
        PasswordResetToken.objects.filter(pk=first.record.pk).update(
            invalidated_at=None
        )

        consume_password_reset_token(
            token=second.plaintext, new_password=NEW_PASSWORD
        )

        first.record.refresh_from_db()
        assert first.record.invalidated_at is not None
        # The user really did get the new password from the second
        # request — first row stays unused.
        assert first.record.used_at is None
        user.refresh_from_db()
        assert user.check_password(NEW_PASSWORD)

    def test_rejects_weak_password(self) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        with pytest.raises(PasswordResetPasswordInvalid) as exc:
            consume_password_reset_token(
                token=issued.plaintext, new_password="short"
            )
        assert exc.value.codes  # at least one validator code surfaced

    def test_token_state_errors_surface_through_consume(self) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        consume_password_reset_token(
            token=issued.plaintext, new_password=NEW_PASSWORD
        )
        with pytest.raises(PasswordResetTokenUsed):
            consume_password_reset_token(
                token=issued.plaintext, new_password=NEW_PASSWORD
            )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class TestPasswordResetRequestEndpoint:
    def test_known_email_sends_one_message(
        self, api_client: APIClient, settings: Any
    ) -> None:
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        django_mail.outbox.clear()
        UserFactory(email="alex@vita.test")

        response = api_client.post(
            _request_url(), {"email": "alex@vita.test"}, format="json"
        )

        assert response.status_code == http_status.HTTP_200_OK
        assert response.data == {"status": "ok"}
        assert len(django_mail.outbox) == 1
        message = django_mail.outbox[0]
        assert message.to == ["alex@vita.test"]
        assert "Vita NPD" in message.subject
        # Both text and HTML alternatives present.
        assert message.body  # plain-text non-empty
        assert any(
            mime == "text/html" for _, mime in message.alternatives
        )
        # Outlook-friendly transactional headers present.
        assert message.extra_headers.get("Auto-Submitted") == "auto-generated"
        assert message.extra_headers.get("X-Auto-Response-Suppress") == "All"
        # And the bulk-mail marker is NOT present — that would
        # actively hurt deliverability for transactional mail.
        assert "List-Unsubscribe" not in message.extra_headers

    def test_unknown_email_still_200_no_message(
        self, api_client: APIClient, settings: Any
    ) -> None:
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        django_mail.outbox.clear()

        response = api_client.post(
            _request_url(), {"email": "ghost@nowhere.test"}, format="json"
        )

        assert response.status_code == http_status.HTTP_200_OK
        assert response.data == {"status": "ok"}
        assert len(django_mail.outbox) == 0

    def test_malformed_email_returns_400(self, api_client: APIClient) -> None:
        response = api_client.post(
            _request_url(), {"email": "not-an-email"}, format="json"
        )
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST

    def test_email_throttle_blocks_fourth_request(
        self, api_client: APIClient
    ) -> None:
        UserFactory(email="rate@vita.test")
        for _ in range(3):
            response = api_client.post(
                _request_url(), {"email": "rate@vita.test"}, format="json"
            )
            assert response.status_code == http_status.HTTP_200_OK

        blocked = api_client.post(
            _request_url(), {"email": "rate@vita.test"}, format="json"
        )
        assert blocked.status_code == http_status.HTTP_429_TOO_MANY_REQUESTS


class TestPasswordResetValidateEndpoint:
    def test_valid_token(self, api_client: APIClient) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None

        response = api_client.get(
            _validate_url(), {"token": issued.plaintext}
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data == {"status": "ok"}

    def test_invalid_token_returns_codified_error(
        self, api_client: APIClient
    ) -> None:
        response = api_client.get(_validate_url(), {"token": "garbage"})
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST
        assert response.data["code"] == "password_reset_token_invalid"

    def test_expired_token_returns_codified_error(
        self, api_client: APIClient
    ) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        PasswordResetToken.objects.filter(pk=issued.record.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        response = api_client.get(
            _validate_url(), {"token": issued.plaintext}
        )
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST
        assert response.data["code"] == "password_reset_token_expired"


class TestPasswordResetConfirmEndpoint:
    def test_confirm_rotates_password(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None

        response = api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": NEW_PASSWORD,
                "password_confirm": NEW_PASSWORD,
            },
            format="json",
        )
        assert response.status_code == http_status.HTTP_200_OK
        user.refresh_from_db()
        assert user.check_password(NEW_PASSWORD)

    def test_password_mismatch_returns_400(
        self, api_client: APIClient
    ) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None

        response = api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": NEW_PASSWORD,
                "password_confirm": "different",
            },
            format="json",
        )
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST

    def test_weak_password_returns_400_with_validator_codes(
        self, api_client: APIClient
    ) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None

        response = api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": "short",
                "password_confirm": "short",
            },
            format="json",
        )
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST
        assert "password" in response.data

    def test_used_token_returns_codified_error(
        self, api_client: APIClient
    ) -> None:
        UserFactory(email="alex@vita.test")
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None
        # First successful consume.
        api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": NEW_PASSWORD,
                "password_confirm": NEW_PASSWORD,
            },
            format="json",
        )
        # Replay.
        replay = api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": NEW_PASSWORD,
                "password_confirm": NEW_PASSWORD,
            },
            format="json",
        )
        assert replay.status_code == http_status.HTTP_400_BAD_REQUEST
        assert replay.data["code"] == "password_reset_token_used"

    def test_does_not_set_auth_cookies(
        self, api_client: APIClient, settings: Any
    ) -> None:
        UserFactory(email="alex@vita.test", password=DEFAULT_TEST_PASSWORD)
        issued = request_password_reset(email="alex@vita.test")
        assert issued is not None

        response = api_client.post(
            _confirm_url(),
            {
                "token": issued.plaintext,
                "password": NEW_PASSWORD,
                "password_confirm": NEW_PASSWORD,
            },
            format="json",
        )
        assert response.status_code == http_status.HTTP_200_OK
        # The contract: successful reset does NOT log the user in.
        # They must explicitly sign in with the new password.
        assert settings.AUTH_COOKIE_ACCESS_NAME not in response.cookies
        assert settings.AUTH_COOKIE_REFRESH_NAME not in response.cookies
