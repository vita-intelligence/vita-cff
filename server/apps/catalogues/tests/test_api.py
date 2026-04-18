"""Integration tests for the catalogues API."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.catalogues.models import Catalogue, Item
from apps.catalogues.tests.factories import (
    CatalogueFactory,
    ItemFactory,
    packaging_catalogue,
    raw_materials_catalogue,
)
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _item_list_url(org_id: str, slug: str) -> str:
    return reverse(
        "catalogues:item-list", kwargs={"org_id": org_id, "slug": slug}
    )


def _item_detail_url(org_id: str, slug: str, item_id: str) -> str:
    return reverse(
        "catalogues:item-detail",
        kwargs={"org_id": org_id, "slug": slug, "item_id": item_id},
    )


def _catalogue_list_url(org_id: str) -> str:
    return reverse("catalogues:catalogue-list", kwargs={"org_id": org_id})


def _catalogue_detail_url(org_id: str, slug: str) -> str:
    return reverse(
        "catalogues:catalogue-detail", kwargs={"org_id": org_id, "slug": slug}
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


@pytest.fixture
def owner_client(api_client: APIClient) -> tuple[APIClient, Any, Any]:
    """``(client, owner_user, org)`` where ``owner_user`` owns ``org``."""

    user = UserFactory(email="owner@catalogues.test", password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Acme")
    _login(api_client, user)
    return api_client, user, org


def _grant_catalogue(
    user: Any, org: Any, slug: str, capabilities: list[str]
) -> None:
    """Attach a non-owner membership with a single row-scoped grant."""

    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"catalogues": {slug: capabilities}},
    )


# ---------------------------------------------------------------------------
# Item list / create
# ---------------------------------------------------------------------------


class TestItemListCreate:
    def test_owner_can_create_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, owner, org = owner_client
        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {
                "name": "Vitamin C",
                "internal_code": "VC-001",
                "unit": "g",
                "base_price": "0.5000",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["name"] == "Vitamin C"
        assert Item.objects.filter(
            catalogue=raw_materials_catalogue(org)
        ).count() == 1

    def test_owner_can_list_items(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Alpha")
        ItemFactory(catalogue=catalogue, name="Beta")

        response = client.get(_item_list_url(str(org.id), "raw_materials"))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert [row["name"] for row in body["results"]] == ["Alpha", "Beta"]

    def test_list_hides_archived_by_default(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Active")
        ItemFactory(catalogue=catalogue, name="Archived", is_archived=True)

        names = [
            row["name"]
            for row in client.get(
                _item_list_url(str(org.id), "raw_materials")
            ).json()["results"]
        ]
        assert names == ["Active"]

    def test_list_includes_archived_when_requested(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Active")
        ItemFactory(catalogue=catalogue, name="Archived", is_archived=True)

        response = client.get(
            _item_list_url(str(org.id), "raw_materials")
            + "?include_archived=true"
        )
        assert response.status_code == status.HTTP_200_OK
        names = {row["name"] for row in response.json()["results"]}
        assert names == {"Active", "Archived"}

    def test_unauthenticated_is_rejected(self, api_client: APIClient) -> None:
        org = OrganizationFactory()
        response = api_client.get(_item_list_url(str(org.id), "raw_materials"))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_sees_404(self, api_client: APIClient) -> None:
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        other_org = OrganizationFactory()
        _login(api_client, stranger)

        response = api_client.get(
            _item_list_url(str(other_org.id), "raw_materials")
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_unknown_slug_returns_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.get(_item_list_url(str(org.id), "nonexistent"))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_without_catalogue_permission_is_forbidden(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        MembershipFactory(
            user=user, organization=org, is_owner=False, permissions={}
        )
        _login(api_client, user)

        response = api_client.get(_item_list_url(str(org.id), "raw_materials"))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_member_with_read_can_list(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", ["view"])
        ItemFactory(catalogue=raw_materials_catalogue(org))
        _login(api_client, user)

        response = api_client.get(_item_list_url(str(org.id), "raw_materials"))
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()["results"]) == 1

    def test_read_on_one_catalogue_does_not_leak_another(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", ["view"])
        _login(api_client, user)

        # Has read on raw_materials, not on packaging. Packaging read
        # must be rejected with 403 — never leak across row scopes.
        response = api_client.get(_item_list_url(str(org.id), "packaging"))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_member_with_read_cannot_create(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", ["view"])
        _login(api_client, user)

        response = api_client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "Nope", "unit": "g"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_member_with_write_can_create(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", ["view", "edit", "import"])
        _login(api_client, user)

        response = api_client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "New Item", "unit": "g"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED

    def test_items_are_isolated_per_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        ItemFactory(catalogue=raw_materials_catalogue(org), name="Raw")
        ItemFactory(catalogue=packaging_catalogue(org), name="Pack")

        raw = client.get(_item_list_url(str(org.id), "raw_materials")).json()
        pack = client.get(_item_list_url(str(org.id), "packaging")).json()
        assert [r["name"] for r in raw["results"]] == ["Raw"]
        assert [r["name"] for r in pack["results"]] == ["Pack"]

    def test_items_are_isolated_per_organization(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, my_org = owner_client
        other_org = OrganizationFactory()
        ItemFactory(catalogue=raw_materials_catalogue(my_org), name="Mine")
        ItemFactory(catalogue=raw_materials_catalogue(other_org), name="Theirs")

        response = client.get(_item_list_url(str(my_org.id), "raw_materials"))
        names = [row["name"] for row in response.json()["results"]]
        assert names == ["Mine"]

    def test_missing_name_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"unit": "g"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["name"] == ["required"]

    def test_blank_name_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "   "},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["name"] == ["blank"]

    def test_duplicate_internal_code_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, internal_code="DUP-1")
        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "Second", "internal_code": "DUP-1"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["internal_code"] == ["internal_code_conflict"]


# ---------------------------------------------------------------------------
# Item detail
# ---------------------------------------------------------------------------


class TestItemDetail:
    def test_owner_can_read_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        response = client.get(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["id"] == str(item.id)

    def test_owner_can_update_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org), name="Old")
        response = client.patch(
            _item_detail_url(str(org.id), "raw_materials", str(item.id)),
            {"name": "New", "base_price": "9.9999"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        item.refresh_from_db()
        assert item.name == "New"
        assert item.base_price == Decimal("9.9999")

    def test_owner_can_archive_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        response = client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        item.refresh_from_db()
        assert item.is_archived is True

    def test_item_in_other_catalogue_is_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        # Looking up by the *packaging* slug must not find a raw_materials item.
        response = client.get(
            _item_detail_url(str(org.id), "packaging", str(item.id))
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_item_in_other_org_is_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, my_org = owner_client
        other_org = OrganizationFactory()
        stranger_item = ItemFactory(catalogue=raw_materials_catalogue(other_org))
        response = client.get(
            _item_detail_url(
                str(my_org.id), "raw_materials", str(stranger_item.id)
            )
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_read_permission_cannot_update(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        _grant_catalogue(user, org, "raw_materials", ["view"])
        _login(api_client, user)

        response = api_client.patch(
            _item_detail_url(str(org.id), "raw_materials", str(item.id)),
            {"name": "Nope"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_edit_permission_can_archive(
        self, api_client: APIClient
    ) -> None:
        # Archive is the reversible soft-delete (sets ``is_archived``),
        # so it's gated on ``edit`` — a user with edit rights can put
        # a row into the archived bin and pull it back out again.
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        _grant_catalogue(user, org, "raw_materials", ["view", "edit", "import"])
        _login(api_client, user)

        response = api_client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT

    def test_edit_permission_cannot_hard_delete(
        self, api_client: APIClient
    ) -> None:
        # Hard delete (``?hard=true``) is the irreversible one — it
        # requires the dedicated ``delete`` capability, not just
        # ``edit``.
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        _grant_catalogue(user, org, "raw_materials", ["view", "edit", "import"])
        _login(api_client, user)

        response = api_client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
            + "?hard=true"
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_admin_permission_can_hard_delete(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        _grant_catalogue(
            user,
            org,
            "raw_materials",
            ["view", "edit", "import", "manage_fields", "delete"],
        )
        _login(api_client, user)

        response = api_client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
            + "?hard=true"
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT


class TestItemHardDelete:
    def test_hard_delete_removes_row_from_database(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org))

        response = client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
            + "?hard=true"
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Item.objects.filter(id=item.id).exists()

    def test_archive_leaves_row_in_database(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(catalogue=raw_materials_catalogue(org))

        response = client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        item.refresh_from_db()
        assert item.is_archived is True
        assert Item.objects.filter(id=item.id).exists()

    def test_hard_delete_requires_admin_permission(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        _grant_catalogue(user, org, "raw_materials", ["view", "edit", "import"])
        _login(api_client, user)

        response = api_client.delete(
            _item_detail_url(str(org.id), "raw_materials", str(item.id))
            + "?hard=true"
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Item.objects.filter(id=item.id).exists()

    def test_patch_can_restore_archived_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org), is_archived=True
        )

        response = client.patch(
            _item_detail_url(str(org.id), "raw_materials", str(item.id)),
            {"is_archived": False},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        item.refresh_from_db()
        assert item.is_archived is False


# ---------------------------------------------------------------------------
# Dynamic attributes on items
# ---------------------------------------------------------------------------


class TestItemDynamicAttributes:
    def test_create_with_validated_attributes_persists_coerced(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        from apps.attributes.models import DataType
        from apps.attributes.tests.factories import AttributeDefinitionFactory

        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        AttributeDefinitionFactory(
            catalogue=catalogue, key="origin", data_type=DataType.TEXT
        )
        AttributeDefinitionFactory(
            catalogue=catalogue, key="potency", data_type=DataType.NUMBER
        )

        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {
                "name": "Vitamin C",
                "attributes": {
                    "origin": "  EU  ",
                    "potency": "12.5",
                },
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["attributes"] == {"origin": "EU", "potency": 12.5}

    def test_required_attribute_missing_rejects_create(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        from apps.attributes.models import DataType
        from apps.attributes.tests.factories import AttributeDefinitionFactory

        client, _, org = owner_client
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org),
            key="origin",
            data_type=DataType.TEXT,
            required=True,
        )

        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "Vitamin C", "attributes": {}},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["attributes"]["origin"] == ["required"]

    def test_invalid_number_rejects_create(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        from apps.attributes.models import DataType
        from apps.attributes.tests.factories import AttributeDefinitionFactory

        client, _, org = owner_client
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org),
            key="potency",
            data_type=DataType.NUMBER,
        )

        response = client.post(
            _item_list_url(str(org.id), "raw_materials"),
            {"name": "Vitamin C", "attributes": {"potency": "hello"}},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["attributes"]["potency"] == ["invalid"]

    def test_attributes_are_catalogue_scoped(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        """A definition on raw_materials must not validate packaging items."""

        from apps.attributes.models import DataType
        from apps.attributes.tests.factories import AttributeDefinitionFactory

        client, _, org = owner_client
        # ``origin`` is defined only on raw_materials, as required.
        AttributeDefinitionFactory(
            catalogue=raw_materials_catalogue(org),
            key="origin",
            data_type=DataType.TEXT,
            required=True,
        )
        # Packaging has no attributes at all; the same create payload
        # that fails on raw_materials must succeed on packaging.
        response = client.post(
            _item_list_url(str(org.id), "packaging"),
            {"name": "Bottle 500ml", "attributes": {}},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED


# ---------------------------------------------------------------------------
# Pagination + ordering
# ---------------------------------------------------------------------------


class TestItemPaginationAndOrdering:
    def test_response_has_paginated_shape(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        ItemFactory(catalogue=raw_materials_catalogue(org), name="A")
        ItemFactory(catalogue=raw_materials_catalogue(org), name="B")

        body = client.get(_item_list_url(str(org.id), "raw_materials")).json()
        assert set(body.keys()) == {"next", "previous", "results"}
        assert body["previous"] is None

    def test_cursor_paginates_across_multiple_pages(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        for idx in range(150):
            ItemFactory(catalogue=catalogue, name=f"Item {idx:03d}")

        first = client.get(
            _item_list_url(str(org.id), "raw_materials")
            + "?ordering=name&page_size=50"
        ).json()
        assert len(first["results"]) == 50
        assert first["results"][0]["name"] == "Item 000"
        assert first["next"] is not None

        second = client.get(first["next"]).json()
        assert len(second["results"]) == 50
        assert second["results"][0]["name"] == "Item 050"

        third = client.get(second["next"]).json()
        assert len(third["results"]) == 50
        assert third["results"][0]["name"] == "Item 100"
        assert third["next"] is None

    def test_ordering_by_name_ascending_and_descending(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Gamma")
        ItemFactory(catalogue=catalogue, name="Alpha")
        ItemFactory(catalogue=catalogue, name="Beta")

        asc = [
            r["name"]
            for r in client.get(
                _item_list_url(str(org.id), "raw_materials") + "?ordering=name"
            ).json()["results"]
        ]
        assert asc == ["Alpha", "Beta", "Gamma"]

        desc = [
            r["name"]
            for r in client.get(
                _item_list_url(str(org.id), "raw_materials") + "?ordering=-name"
            ).json()["results"]
        ]
        assert desc == ["Gamma", "Beta", "Alpha"]

    def test_unknown_ordering_field_falls_back_to_name(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Beta")
        ItemFactory(catalogue=catalogue, name="Alpha")

        response = client.get(
            _item_list_url(str(org.id), "raw_materials")
            + "?ordering=evil_drop_table"
        )
        names = [r["name"] for r in response.json()["results"]]
        assert names == ["Alpha", "Beta"]


# ---------------------------------------------------------------------------
# Catalogue metadata endpoints
# ---------------------------------------------------------------------------


class TestCatalogueList:
    def test_owner_sees_all_system_catalogues(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.get(_catalogue_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        slugs = {row["slug"] for row in response.json()}
        assert {"raw_materials", "packaging"} <= slugs

    def test_non_owner_sees_only_catalogues_they_have_access_to(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(user, org, "raw_materials", ["view"])
        _login(api_client, user)

        slugs = {
            row["slug"]
            for row in api_client.get(_catalogue_list_url(str(org.id))).json()
        }
        assert slugs == {"raw_materials"}

    def test_owner_can_create_custom_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _catalogue_list_url(str(org.id)),
            {
                "slug": "equipment",
                "name": "Equipment",
                "description": "Machines and tools.",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert Catalogue.objects.filter(
            organization=org, slug="equipment"
        ).exists()

    def test_non_owner_cannot_create_catalogue(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_catalogue(
            user,
            org,
            "raw_materials",
            ["view", "edit", "import", "manage_fields", "delete"],
        )
        _login(api_client, user)

        response = api_client.post(
            _catalogue_list_url(str(org.id)),
            {"slug": "equipment", "name": "Equipment"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_duplicate_slug_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _catalogue_list_url(str(org.id)),
            {"slug": "raw_materials", "name": "Dup"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["slug"] == ["catalogue_slug_conflict"]


class TestCatalogueDetail:
    def test_owner_can_read_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.get(
            _catalogue_detail_url(str(org.id), "raw_materials")
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["slug"] == "raw_materials"

    def test_cannot_delete_system_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.delete(
            _catalogue_detail_url(str(org.id), "raw_materials")
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert Catalogue.objects.filter(
            organization=org, slug="raw_materials"
        ).exists()

    def test_can_delete_custom_catalogue(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        CatalogueFactory(organization=org, slug="custom_delete_me")
        response = client.delete(
            _catalogue_detail_url(str(org.id), "custom_delete_me")
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Catalogue.objects.filter(
            organization=org, slug="custom_delete_me"
        ).exists()
