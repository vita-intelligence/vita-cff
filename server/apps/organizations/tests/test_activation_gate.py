"""Integration tests for the pre-billing ``Organization.is_active`` gate.

These tests exercise the gate from the outside: a member's HTTP
request lands on a feature endpoint, the permission layer runs, and
the response body carries the ``organization_inactive`` code. The
gate must leave three specific paths unchanged — superuser bypass,
non-member hiding, and reactivation — so each has a dedicated case.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.catalogues.tests.factories import raw_materials_catalogue
from apps.organizations.services import create_organization

pytestmark = pytest.mark.django_db


INVENTORY_URL = "catalogues:item-list"
INVITATION_URL = "organizations:invitation-list"


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _deactivate(organization) -> None:
    """Flip the org off directly — bypasses the test conftest helper that
    forces new orgs to activate."""
    organization.is_active = False
    organization.save(update_fields=["is_active", "updated_at"])


# ---------------------------------------------------------------------------
# Feature endpoints (catalogues stands in for everything gated by has_capability)
# ---------------------------------------------------------------------------


class TestCatalogueAccessOnInactiveOrg:
    def test_owner_gets_403_with_inactive_code(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Locked Co")
        raw_materials_catalogue(organization=org)
        _deactivate(org)
        _login(api_client, user)

        response = api_client.get(
            reverse(
                INVENTORY_URL, kwargs={"org_id": str(org.id), "slug": "raw_materials"}
            )
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert response.data["code"] == "organization_inactive"

    def test_superuser_bypasses_gate(self, api_client: APIClient) -> None:
        admin = UserFactory(
            password=DEFAULT_TEST_PASSWORD, is_superuser=True, is_staff=True
        )
        org = create_organization(user=admin, name="Locked Co")
        raw_materials_catalogue(organization=org)
        _deactivate(org)
        _login(api_client, admin)

        response = api_client.get(
            reverse(
                INVENTORY_URL, kwargs={"org_id": str(org.id), "slug": "raw_materials"}
            )
        )

        assert response.status_code == status.HTTP_200_OK

    def test_non_member_sees_404_not_inactive_code(
        self, api_client: APIClient
    ) -> None:
        # Hiding rule: non-members must never discover whether a given
        # org exists, let alone whether it is inactive. They keep
        # getting 404 regardless of the gate.
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Hidden Co")
        raw_materials_catalogue(organization=org)
        _deactivate(org)
        _login(api_client, stranger)

        response = api_client.get(
            reverse(
                INVENTORY_URL, kwargs={"org_id": str(org.id), "slug": "raw_materials"}
            )
        )

        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_reactivation_unblocks_immediately(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Flipping Co")
        raw_materials_catalogue(organization=org)
        _deactivate(org)
        _login(api_client, user)

        url = reverse(
            INVENTORY_URL, kwargs={"org_id": str(org.id), "slug": "raw_materials"}
        )
        assert api_client.get(url).status_code == status.HTTP_403_FORBIDDEN

        org.is_active = True
        org.save(update_fields=["is_active", "updated_at"])

        assert api_client.get(url).status_code == status.HTTP_200_OK


# ---------------------------------------------------------------------------
# Invitation sending
# ---------------------------------------------------------------------------


class TestInvitationsOnInactiveOrg:
    def test_owner_cannot_send_invite(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Locked Co")
        _deactivate(org)
        _login(api_client, user)

        response = api_client.post(
            reverse(INVITATION_URL, kwargs={"org_id": str(org.id)}),
            {"email": "newhire@example.com"},
            format="json",
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert response.data["code"] == "organization_inactive"

    def test_superuser_can_still_send_invite(
        self, api_client: APIClient
    ) -> None:
        admin = UserFactory(
            password=DEFAULT_TEST_PASSWORD, is_superuser=True, is_staff=True
        )
        org = create_organization(user=admin, name="Locked Co")
        _deactivate(org)
        _login(api_client, admin)

        response = api_client.post(
            reverse(INVITATION_URL, kwargs={"org_id": str(org.id)}),
            {"email": "newhire@example.com"},
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED
