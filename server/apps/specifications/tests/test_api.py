"""Integration tests for the specifications API."""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.services import replace_lines, save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from apps.specifications.models import SpecificationSheet
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _list_url(org_id: str) -> str:
    return reverse(
        "specifications:specification-list", kwargs={"org_id": org_id}
    )


def _detail_url(org_id: str, sheet_id: str) -> str:
    return reverse(
        "specifications:specification-detail",
        kwargs={"org_id": org_id, "sheet_id": sheet_id},
    )


def _render_url(org_id: str, sheet_id: str) -> str:
    return reverse(
        "specifications:specification-render",
        kwargs={"org_id": org_id, "sheet_id": sheet_id},
    )


def _status_url(org_id: str, sheet_id: str) -> str:
    return reverse(
        "specifications:specification-status",
        kwargs={"org_id": org_id, "sheet_id": sheet_id},
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _grant(user: Any, org: Any, level: str) -> None:
    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"specifications": level},
    )


def _seed_version(org):
    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        attributes={
            "type": "Others",
            "purity": "1",
            "ingredient_list_name": "Seeded Ingredient",
            "vegan": "Vegan",
            "organic": "Organic",
            "halal": "Halal",
            "kosher": "Kosher",
        },
    )
    formulation = FormulationFactory(
        organization=org, dosage_form="capsule", capsule_size="double_00"
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "10"}],
    )
    return save_version(formulation=formulation, actor=org.created_by)


@pytest.fixture
def owner_client(api_client: APIClient) -> tuple[APIClient, Any, Any]:
    user = UserFactory(
        email="owner@spec.test", password=DEFAULT_TEST_PASSWORD
    )
    org = create_organization(user=user, name="Spec Co")
    _login(api_client, user)
    return api_client, user, org


class TestListCreate:
    def test_owner_creates_sheet(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        version = _seed_version(org)
        response = client.post(
            _list_url(str(org.id)),
            {
                "formulation_version_id": str(version.id),
                "code": "SPEC-1",
                "client_name": "ACME",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert SpecificationSheet.objects.filter(organization=org).count() == 1

    def test_foreign_version_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        other = OrganizationFactory()
        foreign_version = _seed_version(other)
        response = client.post(
            _list_url(str(org.id)),
            {
                "formulation_version_id": str(foreign_version.id),
            },
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["formulation_version_id"] == [
            "formulation_version_not_in_org"
        ]

    def test_list_is_paginated(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        for _ in range(3):
            SpecificationSheetFactory(organization=org)
        response = client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert set(body.keys()) == {"next", "previous", "results"}
        assert len(body["results"]) == 3

    def test_unauthenticated_is_rejected(self, api_client: APIClient) -> None:
        org = OrganizationFactory()
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_sees_404(self, api_client: APIClient) -> None:
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        other = OrganizationFactory()
        _login(api_client, stranger)
        response = api_client.get(_list_url(str(other.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_read_member_can_list(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant(user, org, "read")
        SpecificationSheetFactory(organization=org)
        _login(api_client, user)
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()["results"]) == 1

    def test_read_member_cannot_create(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant(user, org, "read")
        _login(api_client, user)
        response = api_client.post(
            _list_url(str(org.id)),
            {"formulation_version_id": "00000000-0000-0000-0000-000000000000"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestDetail:
    def test_cross_org_is_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, my_org = owner_client
        other = OrganizationFactory()
        foreign = SpecificationSheetFactory(organization=other)
        response = client.get(
            _detail_url(str(my_org.id), str(foreign.id))
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_delete_requires_admin(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        _grant(user, org, "write")
        _login(api_client, user)
        response = api_client.delete(
            _detail_url(str(org.id), str(sheet.id))
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestRender:
    def test_render_view_returns_expected_shape(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        version = _seed_version(org)
        created = client.post(
            _list_url(str(org.id)),
            {"formulation_version_id": str(version.id)},
            format="json",
        ).json()
        response = client.get(
            _render_url(str(org.id), created["id"])
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["limits"]
        assert body["compliance"]["flags"]
        assert body["actives"][0]["ingredient_list_name"] == "Seeded Ingredient"


class TestStatusEndpoint:
    def test_happy_path_transition(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        response = client.post(
            _status_url(str(org.id), str(sheet.id)),
            {"status": "in_review"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        sheet.refresh_from_db()
        assert sheet.status == "in_review"

    def test_invalid_transition(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        response = client.post(
            _status_url(str(org.id), str(sheet.id)),
            {"status": "approved"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["status"] == ["invalid_status_transition"]
