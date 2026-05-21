"""Tests for the customer-portal invite flow.

Covers the full lifecycle of a :class:`CustomerPortalInvite`:

* Staff-side creation via ``POST /api/organizations/<org>/customers/
  <id>/portal-invites/``.
* Public ``GET .../preview/`` shape.
* Public ``POST .../activate/`` against the right code, wrong code,
  expired invite, and already-redeemed invite.
* Re-issuing an invite supersedes the previous open row.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.client_portal.invite_services import (
    INVITE_TTL,
    _hash_code,
    create_invite,
)
from apps.client_portal.models import ClientAccount, CustomerPortalInvite
from apps.customers.models import Customer
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def org(db):
    return OrganizationFactory()


@pytest.fixture
def customer(db, org):
    """A customer with an email — the happy-path invite target."""

    return Customer.objects.create(
        organization=org,
        name="Jane Doe",
        company="Acme Foods Ltd",
        email="jane@acme.example.com",
        created_by=org.created_by,
        updated_by=org.created_by,
    )


@pytest.fixture
def staff_with_edit(db, org):
    """An org member with formulations.edit so they can issue an invite."""

    user = UserFactory(email="triager@vita.test")
    MembershipFactory(
        user=user,
        organization=org,
        permissions={"formulations": ["view", "edit"]},
    )
    return user


@pytest.fixture
def staff_view_only(db, org):
    """An org member without formulations.edit — must be 403'd."""

    user = UserFactory(email="viewer@vita.test")
    MembershipFactory(
        user=user,
        organization=org,
        permissions={"formulations": ["view"]},
    )
    return user


def _staff_invite_url(org, customer):
    return reverse(
        "customers:customer-portal-invite",
        kwargs={"org_id": str(org.id), "customer_id": str(customer.id)},
    )


# ---------------------------------------------------------------------------
# Staff-side creation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestStaffIssue:
    @pytest.mark.django_db(transaction=True)
    def test_issuer_with_edit_creates_invite_and_mails_code(
        self, org, customer, staff_with_edit,
    ):
        # ``transaction=True`` so the ``transaction.on_commit`` hook
        # the service uses to queue the email actually fires — under
        # the default rollback-only DB fixture, on_commit hooks are
        # silently dropped and the mock assertion would never see
        # the call.
        client = APIClient()
        client.force_authenticate(user=staff_with_edit)

        with patch(
            "apps.client_portal.invite_services.send_portal_invite_email"
        ) as mock_mail:
            r = client.post(_staff_invite_url(org, customer))

        assert r.status_code == 201, r.content
        body = r.json()
        assert "activation_url" in body
        assert body["activation_url"].endswith(
            f"/portal/activate-invite/{CustomerPortalInvite.objects.get().token}"
        )
        assert body["email_snapshot"] == "jane@acme.example.com"

        # The code goes through send_portal_invite_email so we never
        # let it round-trip back to the staff caller — and the test
        # doesn't have to peek at the hashed column to assert delivery.
        mock_mail.assert_called_once()

    def test_view_only_member_is_forbidden(
        self, org, customer, staff_view_only,
    ):
        client = APIClient()
        client.force_authenticate(user=staff_view_only)
        r = client.post(_staff_invite_url(org, customer))
        assert r.status_code == 403

    def test_outsider_gets_404(self, org, customer, db):
        outsider = UserFactory(email="outsider@elsewhere.test")
        client = APIClient()
        client.force_authenticate(user=outsider)
        r = client.post(_staff_invite_url(org, customer))
        assert r.status_code == 404

    def test_customer_without_email_returns_409(
        self, org, staff_with_edit,
    ):
        no_email = Customer.objects.create(
            organization=org,
            name="No Email",
            company="Anon Inc",
            email="",
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        client = APIClient()
        client.force_authenticate(user=staff_with_edit)
        r = client.post(_staff_invite_url(org, no_email))
        assert r.status_code == 409
        assert r.json()["detail"] == ["customer_email_missing"]

    def test_re_issuing_invalidates_previous_open_invite(
        self, org, customer, staff_with_edit,
    ):
        client = APIClient()
        client.force_authenticate(user=staff_with_edit)
        with patch("apps.client_portal.invite_services.send_portal_invite_email"):
            client.post(_staff_invite_url(org, customer))
            client.post(_staff_invite_url(org, customer))

        rows = list(
            CustomerPortalInvite.objects
            .filter(customer=customer)
            .order_by("created_at")
        )
        assert len(rows) == 2
        assert rows[0].invalidated_at is not None  # superseded
        assert rows[1].invalidated_at is None       # still open

    def test_already_activated_customer_is_409(
        self, org, customer, staff_with_edit,
    ):
        # Pre-create + activate the portal account.
        account = ClientAccount.objects.create_account(
            email=customer.email,
            customer=customer,
            password="goodpassword-12345",
        )
        ClientAccount.objects.filter(pk=account.pk).update(
            activated_at=timezone.now(),
        )
        client = APIClient()
        client.force_authenticate(user=staff_with_edit)
        r = client.post(_staff_invite_url(org, customer))
        assert r.status_code == 409
        assert r.json()["detail"] == ["portal_account_already_activated"]


# ---------------------------------------------------------------------------
# Public preview + activate
# ---------------------------------------------------------------------------


def _issue_invite(*, customer, actor):
    """Create an invite without triggering an email — used by every
    redemption test below so we can pin a known plaintext code."""

    with patch(
        "apps.client_portal.invite_services.send_portal_invite_email"
    ):
        issued = create_invite(customer=customer, actor=actor)
    return issued.invite


def _force_code(invite: CustomerPortalInvite, plaintext: str) -> None:
    """Overwrite the row's ``code_hash`` to a known plaintext so a
    test can submit a known-good code without scraping the email."""

    invite.code_hash = _hash_code(plaintext)
    invite.save(update_fields=["code_hash"])


@pytest.mark.django_db
class TestInviteRedemption:
    def test_preview_renders_company_and_masked_email(
        self, org, customer, staff_with_edit,
    ):
        invite = _issue_invite(customer=customer, actor=staff_with_edit)
        client = APIClient()
        r = client.get(f"/api/portal/invites/{invite.token}/preview/")
        assert r.status_code == 200
        body = r.json()
        assert body["customer_company"] == "Acme Foods Ltd"
        assert body["already_activated"] is False
        assert body["email_masked"].endswith("@acme.example.com")

    def test_activate_with_correct_code_creates_account_and_sets_cookie(
        self, org, customer, staff_with_edit,
    ):
        invite = _issue_invite(customer=customer, actor=staff_with_edit)
        _force_code(invite, "654321")

        client = APIClient()
        r = client.post(
            f"/api/portal/invites/{invite.token}/activate/",
            {"password": "supersecret-12345", "code": "654321"},
            format="json",
        )
        assert r.status_code == 200, r.content
        assert "vita_portal_access" in r.cookies

        account = ClientAccount.objects.get(email=customer.email)
        assert account.is_activated
        assert account.customer_id == customer.id

        invite.refresh_from_db()
        assert invite.used_at is not None

    def test_wrong_code_returns_400_and_does_not_consume_invite(
        self, org, customer, staff_with_edit,
    ):
        invite = _issue_invite(customer=customer, actor=staff_with_edit)
        _force_code(invite, "654321")

        client = APIClient()
        r = client.post(
            f"/api/portal/invites/{invite.token}/activate/",
            {"password": "supersecret-12345", "code": "000000"},
            format="json",
        )
        assert r.status_code == 400
        assert r.json()["code"] == "invalid_activation_code"
        invite.refresh_from_db()
        assert invite.used_at is None

    def test_expired_invite_returns_410(
        self, org, customer, staff_with_edit,
    ):
        invite = _issue_invite(customer=customer, actor=staff_with_edit)
        _force_code(invite, "654321")
        # Backdate so the lifecycle check trips.
        CustomerPortalInvite.objects.filter(pk=invite.pk).update(
            expires_at=timezone.now() - timedelta(seconds=1),
        )

        client = APIClient()
        r = client.post(
            f"/api/portal/invites/{invite.token}/activate/",
            {"password": "supersecret-12345", "code": "654321"},
            format="json",
        )
        assert r.status_code == 410
        assert r.json()["code"] == "invite_expired"

    def test_single_use_second_attempt_returns_409(
        self, org, customer, staff_with_edit,
    ):
        invite = _issue_invite(customer=customer, actor=staff_with_edit)
        _force_code(invite, "654321")

        client = APIClient()
        url = f"/api/portal/invites/{invite.token}/activate/"
        first = client.post(
            url,
            {"password": "supersecret-12345", "code": "654321"},
            format="json",
        )
        assert first.status_code == 200

        # Second attempt with same token — account exists with a
        # usable password, so we route to the "already activated"
        # branch (the same outcome the kiosk path produces).
        second = client.post(
            url,
            {"password": "different-12345", "code": "654321"},
            format="json",
        )
        assert second.status_code == 409
        assert second.json()["code"] == "account_already_activated"

    def test_invalid_token_returns_404(self):
        import uuid as _uuid
        client = APIClient()
        r = client.post(
            f"/api/portal/invites/{_uuid.uuid4()}/activate/",
            {"password": "supersecret-12345", "code": "654321"},
            format="json",
        )
        assert r.status_code == 404
        assert r.json()["code"] == "invalid_invite_token"

    def test_ttl_constant_is_seven_days(self):
        """Guard against an accidental cadence change — the user
        explicitly chose a 7-day window."""

        assert INVITE_TTL == timedelta(days=7)
