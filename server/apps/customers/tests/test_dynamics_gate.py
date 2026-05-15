"""Tests for the Dynamics-live gate on customer creation.

Pins three contracts together so a future refactor can't quietly
unblock manual creation on a Dynamics-managed org:

* ``is_dynamics_live`` reads ``enabled AND has_secret`` from the
  org's ``dynamics_config`` — and only that pair.
* ``create_customer`` raises :class:`CustomerCreationDisabledByDynamics`
  on a live org so the local Customer table cannot diverge from
  the Dataverse source of truth.
* The API endpoint surfaces the exception as ``409 customer_creation_disabled_by_dynamics``
  so the frontend banner and the wire response stay in sync when
  a stale client tries to POST anyway.

Edits remain unblocked (no auto-sync today; a local tweak isn't a
conflict) and the Dynamics import path bypasses the gate by
calling ``Customer.objects.create`` directly — that asymmetry is
the whole point of the design.
"""

from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.customers.models import Customer
from apps.customers.services import (
    CustomerCreationDisabledByDynamics,
    create_customer,
    is_dynamics_live,
    set_dynamics_config,
    update_customer,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _enable_dynamics(org) -> None:
    """Seed the org's ``dynamics_config`` so :func:`is_dynamics_live`
    returns ``True``. Stays close to what the real PUT
    ``/integrations/dynamics/`` endpoint would write."""

    set_dynamics_config(
        organization=org,
        actor=org.created_by,
        enabled=True,
        dataverse_url="https://contoso.crm.dynamics.com",
        tenant_id="tenant-1",
        client_id="client-1",
        client_secret="fake-secret",
    )
    org.refresh_from_db()


# ---------------------------------------------------------------------------
# is_dynamics_live helper
# ---------------------------------------------------------------------------


class TestIsDynamicsLive:
    def test_returns_false_on_empty_config(self) -> None:
        org = OrganizationFactory()
        assert is_dynamics_live(org) is False

    def test_returns_true_when_enabled_and_credentials_stored(self) -> None:
        org = OrganizationFactory()
        _enable_dynamics(org)
        assert is_dynamics_live(org) is True

    def test_returns_false_when_disabled_even_with_credentials(self) -> None:
        # Operator pauses the integration but keeps the credentials
        # in case they want to flip it back on. While paused the
        # gate must release so the team isn't stuck unable to add
        # customers.
        org = OrganizationFactory()
        _enable_dynamics(org)
        set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=False,
            dataverse_url="https://contoso.crm.dynamics.com",
            tenant_id="tenant-1",
            client_id="client-1",
            client_secret=None,  # keep existing secret
        )
        org.refresh_from_db()
        assert is_dynamics_live(org) is False

    def test_returns_false_when_enabled_but_no_secret_yet(self) -> None:
        # Owner toggled on but hasn't pasted credentials in.
        # ``enabled`` alone is not enough — we'd be locking out
        # customer creation against a half-built integration.
        org = OrganizationFactory()
        org.dynamics_config = {"enabled": True}
        org.save(update_fields=["dynamics_config"])
        assert is_dynamics_live(org) is False


# ---------------------------------------------------------------------------
# create_customer service guard
# ---------------------------------------------------------------------------


class TestCreateCustomerGuard:
    def test_creates_on_org_without_dynamics(self) -> None:
        org = OrganizationFactory()
        customer = create_customer(
            organization=org,
            actor=org.created_by,
            name="Alex",
            company="Buyer Co",
        )
        assert customer.pk is not None
        assert Customer.objects.filter(organization=org).count() == 1

    def test_rejects_on_dynamics_live_org(self) -> None:
        org = OrganizationFactory()
        _enable_dynamics(org)

        with pytest.raises(CustomerCreationDisabledByDynamics):
            create_customer(
                organization=org,
                actor=org.created_by,
                name="Alex",
                company="Buyer Co",
            )
        # Critical: no row landed on the rollback either — the
        # guard runs before the INSERT so a partial write can't
        # leak into the table.
        assert Customer.objects.filter(organization=org).count() == 0

    def test_edits_still_allowed_on_dynamics_live_org(self) -> None:
        # Edit is a separate decision from create: we explicitly
        # allow local tweaks to previously-imported rows because
        # there's no auto-sync today. The guard must only fire on
        # the create path.
        org = OrganizationFactory()
        # Create *before* turning Dynamics on so the row exists.
        customer = create_customer(
            organization=org,
            actor=org.created_by,
            name="Alex",
            company="Old Co",
        )
        _enable_dynamics(org)

        updated = update_customer(
            customer=customer,
            actor=org.created_by,
            company="New Co",
        )
        assert updated.company == "New Co"

    def test_per_org_isolation(self) -> None:
        # Tenancy: Dynamics being live on ORG A must not gate
        # creation on ORG B. The guard reads ``organization.dynamics_config``
        # directly, but the test would still catch a future refactor
        # that accidentally cached the flag at module scope.
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        _enable_dynamics(org_a)

        # Org A: blocked.
        with pytest.raises(CustomerCreationDisabledByDynamics):
            create_customer(
                organization=org_a,
                actor=org_a.created_by,
                name="A",
            )
        # Org B: unaffected.
        b_customer = create_customer(
            organization=org_b,
            actor=org_b.created_by,
            name="B",
        )
        assert b_customer.organization_id == org_b.id


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _login(client: APIClient, user) -> None:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )


def _customers_url(org_id) -> str:
    # The customers list-create endpoint is namespaced ``customers``;
    # ``customer-list`` is the DRF default name for ``ListCreateView``.
    return f"/api/organizations/{org_id}/customers/"


class TestCustomerCreateEndpoint:
    def test_201_on_normal_org(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory(created_by=owner)
        _login(api_client, owner)

        response = api_client.post(
            _customers_url(org.id),
            {"name": "Alex", "company": "Buyer Co"},
            format="json",
        )
        assert response.status_code == http_status.HTTP_201_CREATED
        assert response.data["name"] == "Alex"

    def test_409_on_dynamics_managed_org(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory(created_by=owner)
        _enable_dynamics(org)
        _login(api_client, owner)

        response = api_client.post(
            _customers_url(org.id),
            {"name": "Alex", "company": "Buyer Co"},
            format="json",
        )
        assert response.status_code == http_status.HTTP_409_CONFLICT
        assert response.data["code"] == "customer_creation_disabled_by_dynamics"
        # Defense in depth — even a successful 409 must not have
        # written a row.
        assert Customer.objects.filter(organization=org).count() == 0


# ---------------------------------------------------------------------------
# Serializer flag
# ---------------------------------------------------------------------------


class TestOrganizationSerializerFlag:
    def test_flag_false_by_default(self) -> None:
        from apps.organizations.api.serializers import (
            OrganizationReadSerializer,
        )

        org = OrganizationFactory()
        data = OrganizationReadSerializer(org).data
        assert data["dynamics_customers_managed"] is False

    def test_flag_true_when_dynamics_live(self) -> None:
        from apps.organizations.api.serializers import (
            OrganizationReadSerializer,
        )

        org = OrganizationFactory()
        _enable_dynamics(org)
        data = OrganizationReadSerializer(org).data
        assert data["dynamics_customers_managed"] is True
