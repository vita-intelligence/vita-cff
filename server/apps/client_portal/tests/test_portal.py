"""Tests for the client portal foundation.

Coverage focuses on the load-bearing seams:

* Activation happy / sad paths (token resolution, customer email,
  re-activation lockout).
* Login + invalid-credential timing (does not branch on response
  shape between unknown email and wrong password).
* Authenticated session sees ``MeView`` + the dashboard list
  filtered to the logged-in customer.
* Cross-customer isolation — a client signed into customer A
  cannot see customer B's proposals.

The tests use the existing ``ProposalFactory`` for the proposal
side and create :class:`Customer` rows inline (no shared factory
in the customers app yet).
"""

from __future__ import annotations

import uuid

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.client_portal.models import ClientAccount
from apps.client_portal.services import (
    ensure_pending_account,
)
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.tests.factories import ProposalFactory


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def org(db):
    return OrganizationFactory()


@pytest.fixture
def customer_with_email(db, org):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="Jane Doe",
        company="Acme Foods Ltd",
        email="jane@acme.example.com",
        created_by=actor,
        updated_by=actor,
    )


@pytest.fixture
def customer_no_email(db, org):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="John Q",
        company="No Email Co",
        email="",
        created_by=actor,
        updated_by=actor,
    )


@pytest.fixture
def proposal_for(customer_with_email):
    proposal = ProposalFactory(
        organization=customer_with_email.organization,
        customer=customer_with_email,
        public_token=uuid.uuid4(),
        # Fixed code so tests don't need to peek at the row to
        # know what to type. The real send path generates a random
        # one via ``request_activation_code``; tests pin a known
        # value + a fresh ``sent_at`` so the TTL guard passes.
        activation_code="123456",
        activation_code_sent_at=timezone.now(),
    )
    return proposal


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestActivation:
    def test_preview_renders_for_pending_customer(self, proposal_for):
        client = APIClient()
        url = (
            f"/api/portal/activate/{proposal_for.public_token}/preview/"
        )
        r = client.get(url)
        assert r.status_code == 200, r.content
        body = r.json()
        assert body["customer_company"] == "Acme Foods Ltd"
        assert body["already_activated"] is False
        assert body["email_masked"].endswith("@acme.example.com")

    def test_first_time_activation_creates_account_and_sets_cookie(
        self, proposal_for,
    ):
        client = APIClient()
        url = f"/api/portal/activate/{proposal_for.public_token}/"
        r = client.post(url, {"password": "supersecret-12345", "code": "123456"})
        assert r.status_code == 200, r.content
        # Cookie issued
        assert "vita_portal_access" in r.cookies
        # Account exists and is activated
        account = ClientAccount.objects.get(email="jane@acme.example.com")
        assert account.is_activated
        assert account.customer_id == proposal_for.customer_id

    def test_missing_customer_email_returns_409(self, db, customer_no_email):
        proposal = ProposalFactory(
            organization=customer_no_email.organization,
            customer=customer_no_email,
            public_token=uuid.uuid4(),
            activation_code="123456",
            activation_code_sent_at=timezone.now(),
        )
        client = APIClient()
        url = f"/api/portal/activate/{proposal.public_token}/"
        r = client.post(url, {"password": "supersecret-12345", "code": "123456"})
        assert r.status_code == 409
        assert r.json()["code"] == "customer_email_missing"

    def test_already_activated_returns_409(self, proposal_for):
        client = APIClient()
        url = f"/api/portal/activate/{proposal_for.public_token}/"
        r = client.post(url, {"password": "supersecret-12345", "code": "123456"})
        assert r.status_code == 200
        # Second attempt with same token
        r2 = client.post(url, {"password": "differentpass-12345", "code": "123456"})
        assert r2.status_code == 409
        assert r2.json()["code"] == "account_already_activated"

    def test_invalid_token_returns_404(self):
        client = APIClient()
        url = f"/api/portal/activate/{uuid.uuid4()}/"
        r = client.post(url, {"password": "supersecret-12345", "code": "123456"})
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Login + me
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestLogin:
    def test_login_with_correct_password_sets_cookie(self, customer_with_email):
        ClientAccount.objects.create_account(
            email=customer_with_email.email,
            customer=customer_with_email,
            password="goodpassword-12345",
        )
        # Mark as activated so the login path doesn't reject as pending.
        ClientAccount.objects.filter(
            email=customer_with_email.email,
        ).update(activated_at="2026-01-01T00:00:00Z")

        client = APIClient()
        r = client.post(
            "/api/portal/auth/login/",
            {
                "email": customer_with_email.email,
                "password": "goodpassword-12345",
            },
            format="json",
        )
        assert r.status_code == 200, r.content
        assert "vita_portal_access" in r.cookies

    def test_login_wrong_password_returns_401(self, customer_with_email):
        ClientAccount.objects.create_account(
            email=customer_with_email.email,
            customer=customer_with_email,
            password="goodpassword-12345",
        )
        client = APIClient()
        r = client.post(
            "/api/portal/auth/login/",
            {
                "email": customer_with_email.email,
                "password": "nope-nope-nope",
            },
            format="json",
        )
        assert r.status_code == 401
        assert r.json()["code"] == "invalid_credentials"

    def test_login_unknown_email_returns_401(self):
        client = APIClient()
        r = client.post(
            "/api/portal/auth/login/",
            {
                "email": "nobody@nowhere.example.com",
                "password": "anything-12345",
            },
            format="json",
        )
        assert r.status_code == 401

    def test_me_requires_auth(self):
        r = APIClient().get("/api/portal/auth/me/")
        assert r.status_code in (401, 403)

    def test_me_returns_payload_after_activation(self, proposal_for):
        client = APIClient()
        url = f"/api/portal/activate/{proposal_for.public_token}/"
        client.post(url, {"password": "supersecret-12345", "code": "123456"})
        # The cookie from activation should authenticate /me/.
        r = client.get("/api/portal/auth/me/")
        assert r.status_code == 200, r.content
        body = r.json()
        assert body["email"] == "jane@acme.example.com"
        assert body["customer_company"] == "Acme Foods Ltd"


# ---------------------------------------------------------------------------
# Dashboard isolation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestProposalList:
    def test_list_returns_only_my_proposals(self, proposal_for):
        client = APIClient()
        # Activate as Customer A's client.
        url = f"/api/portal/activate/{proposal_for.public_token}/"
        client.post(url, {"password": "supersecret-12345", "code": "123456"})

        # Build Customer B with a proposal — client A should NOT see it.
        actor = UserFactory()
        other_customer = Customer.objects.create(
            organization=proposal_for.organization,
            name="Other",
            company="Other Ltd",
            email="other@other.example.com",
            created_by=actor,
            updated_by=actor,
        )
        ProposalFactory(
            organization=proposal_for.organization,
            customer=other_customer,
            public_token=uuid.uuid4(),
        )

        r = client.get("/api/portal/proposals/")
        assert r.status_code == 200, r.content
        rows = r.json()["results"]
        assert len(rows) == 1
        assert rows[0]["id"] == str(proposal_for.id)


# ---------------------------------------------------------------------------
# Pre-creation hook
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEnsurePendingAccount:
    def test_creates_inactive_account(self, customer_with_email):
        account = ensure_pending_account(customer=customer_with_email)
        assert account is not None
        assert not account.has_usable_password()
        assert account.activated_at is None

    def test_returns_existing_account(self, customer_with_email):
        first = ensure_pending_account(customer=customer_with_email)
        second = ensure_pending_account(customer=customer_with_email)
        assert first.pk == second.pk

    def test_returns_none_for_missing_email(self, customer_no_email):
        assert ensure_pending_account(customer=customer_no_email) is None
