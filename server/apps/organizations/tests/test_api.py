"""Integration tests for the organizations API."""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.models import Membership, Organization
from apps.organizations.services import create_organization

pytestmark = pytest.mark.django_db


@pytest.fixture
def organizations_url() -> str:
    return reverse("organizations:organization-list")


@pytest.fixture
def login_url() -> str:
    return reverse("accounts:login")


@pytest.fixture
def authed_client(api_client: APIClient, login_url: str) -> tuple[APIClient, Any]:
    """Return ``(client, user)`` with a fresh authenticated session."""

    user = UserFactory(email="owner@vita.test", password=DEFAULT_TEST_PASSWORD)
    api_client.post(
        login_url,
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return api_client, user


class TestCreateOrganization:
    def test_authenticated_user_can_create_an_organization(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, user = authed_client
        response = client.post(
            organizations_url, {"name": "Acme Labs"}, format="json"
        )

        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["name"] == "Acme Labs"
        assert body["is_owner"] is True
        assert "id" in body

        org = Organization.objects.get(id=body["id"])
        assert org.created_by == user
        membership = Membership.objects.get(user=user, organization=org)
        assert membership.is_owner is True
        assert membership.permissions == {}

    def test_unauthenticated_request_is_rejected(
        self,
        api_client: APIClient,
        organizations_url: str,
    ) -> None:
        response = api_client.post(
            organizations_url, {"name": "Acme Labs"}, format="json"
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_missing_name_is_rejected(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.post(organizations_url, {}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["name"] == ["required"]

    def test_blank_name_is_rejected(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.post(organizations_url, {"name": ""}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["name"] == ["blank"]

    def test_whitespace_only_name_is_rejected(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.post(
            organizations_url, {"name": "   "}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["name"] == ["blank"]

    def test_name_is_trimmed_before_storage(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.post(
            organizations_url, {"name": "   Vita CFF   "}, format="json"
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["name"] == "Vita CFF"

    def test_name_too_long_is_rejected(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.post(
            organizations_url, {"name": "x" * 151}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "max_length" in response.json()["name"]


class TestListOrganizations:
    def test_unauthenticated_request_is_rejected(
        self,
        api_client: APIClient,
        organizations_url: str,
    ) -> None:
        response = api_client.get(organizations_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_returns_empty_list_for_user_with_no_orgs(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, _ = authed_client
        response = client.get(organizations_url)
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_returns_only_caller_orgs(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, user = authed_client

        mine = create_organization(user=user, name="Mine")
        stranger = UserFactory()
        create_organization(user=stranger, name="Theirs")

        response = client.get(organizations_url)
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body) == 1
        assert body[0]["id"] == str(mine.id)
        assert body[0]["name"] == "Mine"

    def test_lists_multiple_orgs_for_owner(
        self,
        authed_client: tuple[APIClient, Any],
        organizations_url: str,
    ) -> None:
        client, user = authed_client
        create_organization(user=user, name="Beta")
        create_organization(user=user, name="Alpha")

        response = client.get(organizations_url)
        assert response.status_code == status.HTTP_200_OK
        names = [row["name"] for row in response.json()]
        # Default ordering is by name ascending — see Meta.ordering.
        assert names == ["Alpha", "Beta"]
