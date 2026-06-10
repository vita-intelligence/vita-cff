"""Tests for the customer-portal self-registration flow.

Covers the full lifecycle of a :class:`ClientAccountRegistration`:

* Step 1 (``POST /api/portal/register/``): validates the form, creates
  a pending row, mails the OTP, returns the token.
* Step 2 (``POST /api/portal/register/confirm/``): verifies the code,
  creates Customer + ClientAccount with privacy fields stamped, sets
  the portal cookies.
* Adopt-by-email: an existing Customer (Dynamics-imported / staff-
  created) gets attached rather than duplicated.
* Enumeration safety: a registration started against an already-
  activated email returns the same shape as a fresh signup.
* Single-org guard: zero / multiple active orgs both refuse to route.
* Privacy-policy not accepted is refused at the service layer.
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.client_portal.models import (
    ClientAccount,
    ClientAccountRegistration,
    PortalEvent,
)
from apps.client_portal.registration_services import (
    DEFAULT_PRIVACY_POLICY_URL,
    REGISTRATION_TTL,
    MultipleActiveOrganizations,
    NoActiveOrganization,
    PrivacyPolicyNotAccepted,
    _hash_code,
    finalize_self_registration,
    start_self_registration,
)
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def org(db):
    """The single active organization the registration flow resolves to."""

    return OrganizationFactory(is_active=True)


@pytest.fixture
def client(db):
    return APIClient()


@pytest.fixture(autouse=True)
def _fire_on_commit_immediately():
    """``transaction.on_commit`` only fires when the outer
    transaction commits — pytest-django wraps each test in an atomic
    block that rolls back at teardown, so the registration code's
    deferred email dispatch would never run under test.

    Patch the helper to call the callback immediately. The
    ``transaction.atomic`` blocks in the service still run normally;
    only the deferred-until-commit semantics is shortcircuited.
    """

    def _immediate(fn, *args, **kwargs):
        fn()

    with patch("django.db.transaction.on_commit", _immediate):
        yield


# ---------------------------------------------------------------------------
# Service-layer: start_self_registration
# ---------------------------------------------------------------------------


def _start(**overrides):
    """Helper — start a registration with reasonable defaults."""

    defaults = {
        "email": "alex@new-customer.example.com",
        "name": "Alex Buyer",
        "company": "Acme Health Ltd",
        "password": "correcthorsebattery8",
        "privacy_accepted": True,
        "request_ip": "127.0.0.1",
    }
    defaults.update(overrides)
    return start_self_registration(**defaults)


def test_start_creates_pending_registration_row(org):
    """Happy path — a fresh row lands with hashed code + expiry."""

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        result = _start()

    assert result.token
    assert result.email_masked.startswith("a")
    assert "@new-customer.example.com" in result.email_masked

    row = ClientAccountRegistration.objects.get(token=result.token)
    assert row.email == "alex@new-customer.example.com"
    assert row.name == "Alex Buyer"
    assert row.company == "Acme Health Ltd"
    assert row.privacy_policy_version == DEFAULT_PRIVACY_POLICY_URL
    assert row.organization_id == org.id
    assert row.is_consumable
    assert (row.expires_at - row.created_at) <= REGISTRATION_TTL + timedelta(seconds=1)

    # Email dispatch happens on transaction commit — pytest-django
    # runs each test inside an atomic block, so the commit fires
    # when the test transaction unwinds; the mock should have been
    # called by then.
    mock_send.assert_called_once()
    kwargs = mock_send.call_args.kwargs
    assert kwargs["to_email"] == "alex@new-customer.example.com"
    assert kwargs["code"].isdigit() and len(kwargs["code"]) == 6


def test_start_rejects_unticked_privacy_policy(org):
    """Privacy box must be ticked — service guard refuses unaccepted."""

    with pytest.raises(PrivacyPolicyNotAccepted):
        _start(privacy_accepted=False)

    assert ClientAccountRegistration.objects.count() == 0


def test_start_invalidates_prior_open_registrations(org):
    """A repeat step-1 supersedes the prior row so only the freshest
    code in the inbox is consumable."""

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ):
        first = _start()
        second = _start()  # repeat with same email

    older = ClientAccountRegistration.objects.get(token=first.token)
    newer = ClientAccountRegistration.objects.get(token=second.token)
    assert older.invalidated_at is not None
    assert newer.invalidated_at is None
    assert newer.is_consumable


def test_start_suppresses_email_for_already_activated_account(org):
    """Enumeration safety — the response shape is the same whether
    the email is brand new or already has a working portal account."""

    customer = Customer.objects.create(
        organization=org,
        email="returner@example.com",
        company="Returner Co",
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    account = ClientAccount.objects.create_account(
        email="returner@example.com",
        customer=customer,
        password="existingpass789",
    )
    account.activated_at = timezone.now()
    account.save(update_fields=["activated_at", "updated_at"])

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        result = _start(email="returner@example.com")

    # Same wire shape as the success path…
    assert result.token
    assert result.email_masked
    # …but no row was created and no email was sent.
    assert (
        ClientAccountRegistration.objects.filter(
            email="returner@example.com"
        ).count()
        == 0
    )
    mock_send.assert_not_called()


def test_start_refuses_when_no_active_org(db):
    with pytest.raises(NoActiveOrganization):
        _start()


def test_start_refuses_when_multiple_active_orgs(db):
    OrganizationFactory(is_active=True)
    OrganizationFactory(is_active=True)
    with pytest.raises(MultipleActiveOrganizations):
        _start()


# ---------------------------------------------------------------------------
# Service-layer: finalize_self_registration
# ---------------------------------------------------------------------------


def test_finalize_creates_customer_and_account(org):
    """Happy path — confirm consumes the row and stamps every
    consent field on the new ClientAccount."""

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        start_result = _start()
    code = mock_send.call_args.kwargs["code"]

    result = finalize_self_registration(
        token=start_result.token,
        code=code,
        password="correcthorsebattery8",
    )

    customer = Customer.objects.get(email="alex@new-customer.example.com")
    assert customer.name == "Alex Buyer"
    assert customer.company == "Acme Health Ltd"
    assert customer.created_by_id is None
    assert customer.updated_by_id is None
    assert customer.organization_id == org.id

    account = ClientAccount.objects.get(email="alex@new-customer.example.com")
    assert account.is_activated
    assert account.is_active
    assert account.has_usable_password()
    assert account.privacy_accepted_at is not None
    assert account.privacy_policy_version == DEFAULT_PRIVACY_POLICY_URL
    assert account.customer_id == customer.id

    assert result.account.id == account.id
    assert result.customer_id == str(customer.id)

    row = ClientAccountRegistration.objects.get(token=start_result.token)
    assert row.used_at is not None

    assert PortalEvent.objects.filter(
        kind=PortalEvent.Kind.SELF_REGISTERED,
        client_account=account,
    ).exists()


def test_finalize_adopts_existing_customer_without_overwriting_fields(org):
    """An existing Customer row (e.g. Dynamics-imported) gets
    attached, not duplicated. The customer's existing name / company
    is preserved — the registration form's typed values do NOT
    overwrite the authoritative snapshot."""

    Customer.objects.create(
        organization=org,
        email="existing@example.com",
        name="Existing Snapshot Name",
        company="Existing Snapshot Co",
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        start_result = _start(
            email="existing@example.com",
            name="Typed Different Name",
            company="Typed Different Co",
        )
    code = mock_send.call_args.kwargs["code"]

    finalize_self_registration(
        token=start_result.token,
        code=code,
        password="correcthorsebattery8",
    )

    customers = Customer.objects.filter(email="existing@example.com")
    assert customers.count() == 1
    customer = customers.first()
    assert customer.name == "Existing Snapshot Name"
    assert customer.company == "Existing Snapshot Co"


def test_finalize_rejects_wrong_code(org):
    from apps.client_portal.registration_services import (
        InvalidRegistrationCode,
    )

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ):
        start_result = _start()

    with pytest.raises(InvalidRegistrationCode):
        finalize_self_registration(
            token=start_result.token,
            code="000000",  # wrong — the random code is almost certainly different
            password="correcthorsebattery8",
        )


def test_finalize_rejects_expired_row(org):
    from apps.client_portal.registration_services import RegistrationExpired

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        start_result = _start()
    code = mock_send.call_args.kwargs["code"]

    row = ClientAccountRegistration.objects.get(token=start_result.token)
    row.expires_at = timezone.now() - timedelta(seconds=1)
    row.save(update_fields=["expires_at"])

    with pytest.raises(RegistrationExpired):
        finalize_self_registration(
            token=start_result.token,
            code=code,
            password="correcthorsebattery8",
        )


def test_finalize_rejects_already_used_row(org):
    from apps.client_portal.registration_services import RegistrationAlreadyUsed

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        start_result = _start()
    code = mock_send.call_args.kwargs["code"]

    finalize_self_registration(
        token=start_result.token,
        code=code,
        password="correcthorsebattery8",
    )
    with pytest.raises(RegistrationAlreadyUsed):
        finalize_self_registration(
            token=start_result.token,
            code=code,
            password="correcthorsebattery8",
        )


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def test_http_register_then_confirm_then_login_round_trip(org, client):
    """End-to-end through the API:

    1. POST /api/portal/register/ — emits the token + code email.
    2. POST /api/portal/register/confirm/ — sets portal cookies +
       returns the MeSerializer payload.
    3. POST /api/portal/auth/login/ — the resulting account is a
       normal portal login that succeeds with the typed password.
    """

    with patch(
        "apps.client_portal.registration_services."
        "send_portal_registration_code_email"
    ) as mock_send:
        start_resp = client.post(
            "/api/portal/register/",
            {
                "email": "newbie@example.com",
                "name": "Newbie",
                "company": "Newbie Co",
                "password": "correcthorsebattery8",
                "privacy_accepted": True,
            },
            format="json",
        )

    assert start_resp.status_code == 200, start_resp.data
    token = start_resp.data["token"]
    assert token
    assert start_resp.data["email_masked"]

    code = mock_send.call_args.kwargs["code"]

    confirm_resp = client.post(
        "/api/portal/register/confirm/",
        {
            "token": token,
            "code": code,
            "password": "correcthorsebattery8",
        },
        format="json",
    )
    assert confirm_resp.status_code == 200, confirm_resp.data
    assert confirm_resp.data["email"] == "newbie@example.com"
    assert "vita_portal_access" in confirm_resp.cookies

    # The account should be a normal login now.
    fresh = APIClient()
    login_resp = fresh.post(
        "/api/portal/auth/login/",
        {
            "email": "newbie@example.com",
            "password": "correcthorsebattery8",
        },
        format="json",
    )
    assert login_resp.status_code == 200, login_resp.data


def test_http_register_returns_400_when_privacy_not_accepted(org, client):
    resp = client.post(
        "/api/portal/register/",
        {
            "email": "noconsent@example.com",
            "name": "No",
            "company": "Consent",
            "password": "correcthorsebattery8",
            "privacy_accepted": False,
        },
        format="json",
    )
    assert resp.status_code == 400
    assert resp.data["code"] == "privacy_policy_not_accepted"


def test_http_register_returns_503_when_no_active_org(db, client):
    """Single-org guard — the FE sees a 503 + codified body so it can
    render a 'sign-ups temporarily unavailable' message rather than
    a generic crash."""

    resp = client.post(
        "/api/portal/register/",
        {
            "email": "any@example.com",
            "name": "Any",
            "company": "Co",
            "password": "correcthorsebattery8",
            "privacy_accepted": True,
        },
        format="json",
    )
    assert resp.status_code == 503
    assert resp.data["code"] == "no_active_organization"
