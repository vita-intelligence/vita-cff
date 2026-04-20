"""API tests for the spec-sheet visibility toggle endpoint.

Exercises the capability split: ``formulations.edit`` alone is
insufficient, and a user with only ``manage_spec_visibility`` (no
edit) can still toggle sections. Also confirms a partial payload
preserves previously-hidden sections and that the render endpoint
reflects the write.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _visibility_url(org_id: str, sheet_id: str) -> str:
    return reverse(
        "specifications:specification-visibility",
        kwargs={"org_id": org_id, "sheet_id": sheet_id},
    )


def _render_url(org_id: str, sheet_id: str) -> str:
    return reverse(
        "specifications:specification-render",
        kwargs={"org_id": org_id, "sheet_id": sheet_id},
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


class TestVisibilityEndpoint:
    def test_owner_can_toggle(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Toggle Co")
        sheet = SpecificationSheetFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _visibility_url(str(org.id), str(sheet.id)),
            {"visibility": {"amino_acids": False, "ingredients": False}},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data["visibility"]["amino_acids"] is False
        assert response.data["visibility"]["ingredients"] is False
        # Sections not in the payload stay visible.
        assert response.data["visibility"]["actives"] is True

    def test_edit_capability_alone_is_not_enough(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Split Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"formulations": ["view", "edit"]},
        )
        sheet = SpecificationSheetFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, editor)

        response = api_client.put(
            _visibility_url(str(org.id), str(sheet.id)),
            {"visibility": {"amino_acids": False}},
            format="json",
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_manage_capability_alone_is_enough(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory()
        manager = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Manage Co")
        MembershipFactory(
            user=manager,
            organization=org,
            permissions={
                "formulations": ["view", "manage_spec_visibility"]
            },
        )
        sheet = SpecificationSheetFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, manager)

        response = api_client.put(
            _visibility_url(str(org.id), str(sheet.id)),
            {"visibility": {"amino_acids": False}},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK

    def test_render_endpoint_reflects_toggle(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Echo Co")
        sheet = SpecificationSheetFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        api_client.put(
            _visibility_url(str(org.id), str(sheet.id)),
            {"visibility": {"signatures": False}},
            format="json",
        )

        resp = api_client.get(_render_url(str(org.id), str(sheet.id)))
        assert resp.data["visibility"]["signatures"] is False

    def test_missing_visibility_payload_is_400(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Bad Payload Co")
        sheet = SpecificationSheetFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _visibility_url(str(org.id), str(sheet.id)),
            {"not_visibility": True},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
