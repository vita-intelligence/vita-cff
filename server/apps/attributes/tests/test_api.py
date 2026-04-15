"""Integration tests for the attribute definitions API."""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.attributes.models import AttributeDefinition
from apps.attributes.tests.factories import AttributeDefinitionFactory
from apps.catalogues.tests.factories import (
    packaging_catalogue,
    raw_materials_catalogue,
)
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


def _list_url(org_id: str, slug: str = "raw_materials") -> str:
    return reverse(
        "attributes:attribute-definition-list",
        kwargs={"org_id": org_id, "slug": slug},
    )


def _detail_url(org_id: str, definition_id: str, slug: str = "raw_materials") -> str:
    return reverse(
        "attributes:attribute-definition-detail",
        kwargs={
            "org_id": org_id,
            "slug": slug,
            "definition_id": definition_id,
        },
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _grant_catalogue(user: Any, org: Any, slug: str, level: str) -> None:
    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"catalogues": {slug: level}},
    )


@pytest.fixture
def owner_client(api_client: APIClient) -> tuple[APIClient, Any, Any]:
    user = UserFactory(email="owner@attrs.test", password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Owner Co")
    _login(api_client, user)
    return api_client, user, org


class TestListDefinitions:
    def test_owner_lists_empty(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        assert response.json() == []

    def test_list_scoped_to_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        AttributeDefinitionFactory(catalogue=raw_materials_catalogue(org))
        AttributeDefinitionFactory(catalogue=raw_materials_catalogue(org))
        # A definition on a *different* catalogue must not leak in.
        AttributeDefinitionFactory(catalogue=packaging_catalogue(org))

        response = client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()) == 2

    def test_list_hides_archived_by_default(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(catalogue=catalogue, key="active")
        AttributeDefinitionFactory(
            catalogue=catalogue, key="old", is_archived=True
        )

        keys = [row["key"] for row in client.get(_list_url(str(org.id))).json()]
        assert keys == ["active"]

    def test_list_can_include_archived(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(catalogue=catalogue, key="active")
        AttributeDefinitionFactory(
            catalogue=catalogue, key="old", is_archived=True
        )

        response = client.get(
            _list_url(str(org.id)) + "?include_archived=true"
        )
        keys = {row["key"] for row in response.json()}
        assert keys == {"active", "old"}

    def test_unauthenticated_is_rejected(self, api_client: APIClient) -> None:
        org = OrganizationFactory()
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_gets_404(self, api_client: APIClient) -> None:
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        other_org = OrganizationFactory()
        _login(api_client, stranger)
        response = api_client.get(_list_url(str(other_org.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_unknown_slug_returns_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.get(_list_url(str(org.id), slug="nonexistent"))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_with_read_can_list(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", "read")
        _login(api_client, user)

        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK


class TestCreateDefinition:
    def test_owner_creates_text(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _list_url(str(org.id)),
            {
                "key": "origin",
                "label": "Origin",
                "data_type": "text",
                "required": True,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["key"] == "origin"
        assert body["data_type"] == "text"
        assert body["required"] is True
        assert AttributeDefinition.objects.filter(
            catalogue=raw_materials_catalogue(org), key="origin"
        ).exists()

    def test_invalid_key_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _list_url(str(org.id)),
            {"key": "Not Valid", "label": "Bad", "data_type": "text"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["key"] == ["attribute_key_invalid"]

    def test_duplicate_key_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org), key="origin"
        )
        response = client.post(
            _list_url(str(org.id)),
            {"key": "origin", "label": "Origin", "data_type": "text"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["key"] == ["attribute_key_conflict"]

    def test_same_key_allowed_across_catalogues(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        """The key uniqueness constraint is per-catalogue, not per-org."""

        client, _, org = owner_client
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org), key="origin"
        )
        response = client.post(
            _list_url(str(org.id), slug="packaging"),
            {"key": "origin", "label": "Origin", "data_type": "text"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED

    def test_select_requires_options(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _list_url(str(org.id)),
            {
                "key": "tier",
                "label": "Tier",
                "data_type": "single_select",
                "options": [],
            },
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["options"] == ["attribute_options_invalid"]

    def test_select_normalizes_options(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _list_url(str(org.id)),
            {
                "key": "tier",
                "label": "Tier",
                "data_type": "single_select",
                "options": [
                    {"value": "a", "label": "A"},
                    {"value": "b", "label": "B"},
                ],
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["options"] == [
            {"value": "a", "label": "A"},
            {"value": "b", "label": "B"},
        ]

    def test_non_admin_member_cannot_create(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", "read")
        _login(api_client, user)

        response = api_client.post(
            _list_url(str(org.id)),
            {"key": "k", "label": "K", "data_type": "text"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_write_member_cannot_create(self, api_client: APIClient) -> None:
        """Managing schema requires ADMIN, not WRITE."""

        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", "write")
        _login(api_client, user)

        response = api_client.post(
            _list_url(str(org.id)),
            {"key": "k", "label": "K", "data_type": "text"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestUpdateDefinition:
    def test_owner_can_archive(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        definition = AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org)
        )

        response = client.delete(
            _detail_url(str(org.id), str(definition.id))
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        definition.refresh_from_db()
        assert definition.is_archived is True

    def test_owner_can_rename_label(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        definition = AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org), label="Old"
        )

        response = client.patch(
            _detail_url(str(org.id), str(definition.id)),
            {"label": "New"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        definition.refresh_from_db()
        assert definition.label == "New"

    def test_cannot_change_key_via_update(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        definition = AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org), key="original"
        )

        response = client.patch(
            _detail_url(str(org.id), str(definition.id)),
            {"key": "renamed"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        definition.refresh_from_db()
        assert definition.key == "original"

    def test_definition_from_other_catalogue_is_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        definition = AttributeDefinitionFactory(
            catalogue=packaging_catalogue(org)
        )
        # Look it up via the raw_materials slug: must be 404.
        response = client.patch(
            _detail_url(str(org.id), str(definition.id)),
            {"label": "New"},
            format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
