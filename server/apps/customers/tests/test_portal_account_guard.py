"""Customer ↔ ClientAccount integration tests.

Two contracts under test:

* :func:`list_customers` / :func:`get_customer` annotate every
  returned row with ``has_portal_account`` + ``portal_account_activated``
  flags, so the customers list page can render a "Portal login"
  badge + gate the delete affordance without a second round-trip.
* :func:`delete_customer` refuses to delete a customer that has
  any linked :class:`ClientAccount`, raising
  :class:`CustomerHasPortalAccount`. Without the guard the
  ``on_delete=PROTECT`` on ``ClientAccount.customer`` would fire
  a ``ProtectedError`` and the FE would see an opaque 500.
"""

from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.client_portal.models import ClientAccount
from apps.customers.models import Customer
from apps.customers.services import (
    CustomerHasPortalAccount,
    delete_customer,
    get_customer,
    list_customers,
)
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


def _make_customer(*, org, name: str, email: str) -> Customer:
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name=name,
        company=f"{name} Co",
        email=email,
        created_by=actor,
        updated_by=actor,
    )


class TestPortalAccountAnnotation:
    def test_customer_without_account_has_flags_false(self):
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, name="No Account", email="no@example.com",
        )

        rows = list(list_customers(organization=org))
        assert len(rows) == 1
        assert rows[0].id == customer.id
        # ``_has_portal_account`` / ``_portal_account_activated``
        # are the queryset annotations the serializer reads from.
        assert rows[0]._has_portal_account is False
        assert rows[0]._portal_account_activated is False

    def test_pending_account_flips_has_but_not_activated(self):
        # A pre-created (kiosk-token) account row that hasn't yet
        # set a password should count as "has portal account" so
        # the delete guard fires, but ``portal_account_activated``
        # stays False so the FE badge can show "Pending" rather
        # than "Active".
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, name="Pending", email="pending@example.com",
        )
        ClientAccount.objects.create_account(
            email=customer.email,
            customer=customer,
            password="pending-password-12345",
        )

        loaded = get_customer(organization=org, customer_id=customer.id)
        assert loaded._has_portal_account is True
        assert loaded._portal_account_activated is False

    def test_activated_account_flips_both_flags(self):
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, name="Active", email="active@example.com",
        )
        account = ClientAccount.objects.create_account(
            email=customer.email,
            customer=customer,
            password="active-password-12345",
        )
        # Activation = ``activated_at`` populated. Drive it via
        # update so we don't need to import the activation flow.
        ClientAccount.objects.filter(pk=account.pk).update(
            activated_at="2026-01-01T00:00:00Z",
        )

        loaded = get_customer(organization=org, customer_id=customer.id)
        assert loaded._has_portal_account is True
        assert loaded._portal_account_activated is True


class TestDeleteGuard:
    def test_delete_without_portal_account_succeeds(self):
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, name="Delete Me", email="delete@example.com",
        )
        actor = UserFactory()

        delete_customer(customer=customer, actor=actor)
        assert (
            Customer.objects.filter(pk=customer.pk).exists() is False
        )

    def test_delete_with_portal_account_raises(self):
        # The guard fires for any linked client account — including
        # a never-activated one — so we don't fall through to the
        # FK's ``ProtectedError`` and surface an opaque 500.
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, name="Protected", email="protected@example.com",
        )
        ClientAccount.objects.create_account(
            email=customer.email,
            customer=customer,
            password="any-password-12345",
        )
        actor = UserFactory()

        with pytest.raises(CustomerHasPortalAccount):
            delete_customer(customer=customer, actor=actor)

        # The row stays put — the delete was a no-op transactionally.
        assert (
            Customer.objects.filter(pk=customer.pk).exists() is True
        )
