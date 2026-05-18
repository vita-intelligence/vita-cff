"""Tests for the manual "Notify client" kiosk-alert path."""

from __future__ import annotations

import datetime as _dt
import uuid

import pytest
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.tests.factories import UserFactory
from apps.comments.kiosk_alerts import (
    CUSTOM_NOTE_MAX_LENGTH,
    CustomNoteTooLong,
    NoIdentifiedClients,
    notify_kiosk_clients,
)
from apps.comments.models import (
    KIOSK_ALERT_COOLDOWN_SECONDS,
    KioskAlert,
    KioskAlertStatus,
    KioskSession,
)
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from apps.specifications.tests.factories import SpecificationSheetFactory


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def workspace(mailoutbox):
    org = OrganizationFactory()
    owner = org.created_by
    # The notify-client path keys on ``public_token`` to find kiosk
    # sessions — sheets are private (token NULL) until a public link
    # is explicitly generated. We stamp one on the fixture sheet so
    # the seeded KioskSession rows can hang off the same token.
    sheet = SpecificationSheetFactory(
        organization=org,
        created_by=owner,
        public_token=uuid.uuid4(),
    )
    return {"org": org, "owner": owner, "sheet": sheet, "mail": mailoutbox}


def _seed_kiosk_session(*, sheet, name="Alice", email="alice@client.test"):
    return KioskSession.objects.create(
        public_token=sheet.public_token,
        guest_name=name,
        guest_email=email,
        session_hash=f"hash-{email}",
    )


def _api_client_for(user):
    from django.conf import settings

    client = APIClient()
    token = str(AccessToken.for_user(user))
    client.cookies[settings.AUTH_COOKIE_ACCESS_NAME] = token
    return client


# ---------------------------------------------------------------------------
# Service: notify_kiosk_clients
# ---------------------------------------------------------------------------


class TestNotifyKioskClients:
    def test_sends_one_email_per_unique_recipient(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        # Same email, different casing — must collapse to one send.
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="ALICE@CLIENT.TEST"
        )
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="bob@client.test"
        )

        result = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )

        assert result.notified_count == 2
        assert set(result.sent_emails) == {
            "alice@client.test",
            "bob@client.test",
        }
        assert len(workspace["mail"]) == 2

    def test_skips_revoked_sessions(self, workspace) -> None:
        revoked = _seed_kiosk_session(
            sheet=workspace["sheet"], email="ghost@client.test"
        )
        revoked.revoked_at = _dt.datetime(
            2026, 1, 1, tzinfo=_dt.timezone.utc
        )
        revoked.save(update_fields=["revoked_at"])
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alive@client.test"
        )

        result = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )

        assert result.sent_emails == ("alive@client.test",)

    def test_raises_when_no_identified_clients(self, workspace) -> None:
        with pytest.raises(NoIdentifiedClients):
            notify_kiosk_clients(
                sheet=workspace["sheet"],
                actor=workspace["owner"],
            )

    def test_cooldown_skips_recent_recipient(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )

        first = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )
        second = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )

        assert first.sent_emails == ("alice@client.test",)
        assert second.sent_emails == ()
        assert second.skipped_emails == ("alice@client.test",)
        # Mailbox should only have the first send.
        assert len(workspace["mail"]) == 1

    def test_cooldown_clears_after_window(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        first = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )
        # Roll the first send's sent_at backwards so the cooldown
        # window has elapsed.
        from django.utils import timezone

        row = KioskAlert.objects.get(
            recipient_email="alice@client.test",
            status=KioskAlertStatus.SENT,
        )
        row.sent_at = timezone.now() - timezone.timedelta(
            seconds=KIOSK_ALERT_COOLDOWN_SECONDS + 10
        )
        row.save(update_fields=["sent_at"])

        second = notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
        )
        assert first.notified_count == 1
        assert second.notified_count == 1
        assert second.sent_emails == ("alice@client.test",)

    def test_custom_note_too_long(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        with pytest.raises(CustomNoteTooLong):
            notify_kiosk_clients(
                sheet=workspace["sheet"],
                actor=workspace["owner"],
                custom_note="x" * (CUSTOM_NOTE_MAX_LENGTH + 1),
            )
        assert len(workspace["mail"]) == 0

    def test_custom_note_embedded_in_email_body(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        notify_kiosk_clients(
            sheet=workspace["sheet"],
            actor=workspace["owner"],
            custom_note="We've adjusted the pricing — please review.",
        )
        assert len(workspace["mail"]) == 1
        sent = workspace["mail"][0]
        assert "adjusted the pricing" in sent.body
        # HTML alternative must also include the note (quoted card).
        html_alts = [
            content for content, mime in sent.alternatives if mime == "text/html"
        ]
        assert html_alts, "expected HTML alternative"
        assert "adjusted the pricing" in html_alts[0]


# ---------------------------------------------------------------------------
# REST endpoint
# ---------------------------------------------------------------------------


class TestNotifyClientEndpoint:
    def test_post_notifies_clients(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        # Owner has all caps via is_owner short-circuit.
        client = _api_client_for(workspace["owner"])
        url = reverse(
            "comments:specification-notify-client",
            kwargs={
                "org_id": workspace["org"].id,
                "sheet_id": workspace["sheet"].id,
            },
        )
        response = client.post(url, {"note": "Pricing update inside."}, format="json")
        assert response.status_code == 200
        body = response.json()
        assert body["notified_count"] == 1
        assert body["sent_emails"] == ["alice@client.test"]
        assert len(workspace["mail"]) == 1

    def test_get_returns_recipient_count(self, workspace) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="bob@client.test"
        )
        client = _api_client_for(workspace["owner"])
        url = reverse(
            "comments:specification-notify-client",
            kwargs={
                "org_id": workspace["org"].id,
                "sheet_id": workspace["sheet"].id,
            },
        )
        response = client.get(url)
        assert response.status_code == 200
        body = response.json()
        assert body["recipient_count"] == 2
        assert body["last_alert"] is None

    def test_post_without_clients_is_409(self, workspace) -> None:
        client = _api_client_for(workspace["owner"])
        url = reverse(
            "comments:specification-notify-client",
            kwargs={
                "org_id": workspace["org"].id,
                "sheet_id": workspace["sheet"].id,
            },
        )
        response = client.post(url, {}, format="json")
        assert response.status_code == 409
        assert response.json()["detail"] == "no_identified_clients"

    def test_post_without_write_capability_is_forbidden(
        self, workspace
    ) -> None:
        _seed_kiosk_session(
            sheet=workspace["sheet"], email="alice@client.test"
        )
        # Reader: comments_view but no comments_write.
        reader = UserFactory(email="reader@vita.test")
        MembershipFactory(
            user=reader,
            organization=workspace["org"],
            permissions={"formulations": ["view", "comments_view"]},
        )
        client = _api_client_for(reader)
        url = reverse(
            "comments:specification-notify-client",
            kwargs={
                "org_id": workspace["org"].id,
                "sheet_id": workspace["sheet"].id,
            },
        )
        response = client.post(url, {}, format="json")
        assert response.status_code in (403, 401)
        assert len(workspace["mail"]) == 0
