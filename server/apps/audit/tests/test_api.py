"""API tests for the audit log list endpoint."""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.audit.models import AuditLog
from apps.formulations.services import create_formulation
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)


pytestmark = pytest.mark.django_db


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _owner_client() -> tuple[APIClient, Any, Any]:
    user = UserFactory(password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Audit Corp")
    client = _login(APIClient(), user)
    return client, user, org


def _list_url(org_id: Any) -> str:
    return reverse("audit:audit-log-list", args=[str(org_id)])


class TestAuditLogPermissions:
    def test_unauthenticated_is_401(self) -> None:
        org = OrganizationFactory()
        response = APIClient().get(_list_url(org.id))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_is_404(self) -> None:
        other_org = OrganizationFactory()
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        client = _login(APIClient(), stranger)
        response = client.get(_list_url(other_org.id))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_without_view_is_403(self) -> None:
        org = OrganizationFactory()
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=user,
            organization=org,
            is_owner=False,
            permissions={"formulations": ["view"]},
        )
        client = _login(APIClient(), user)
        response = client.get(_list_url(org.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_member_with_audit_view_is_allowed(self) -> None:
        org = OrganizationFactory()
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=user,
            organization=org,
            is_owner=False,
            permissions={"audit": ["view"]},
        )
        client = _login(APIClient(), user)
        response = client.get(_list_url(org.id))
        assert response.status_code == status.HTTP_200_OK


class TestAuditLogList:
    def test_owner_sees_rows_for_their_org(self) -> None:
        client, user, org = _owner_client()
        # Each write records a row; one create = one audit entry.
        create_formulation(
            organization=org, actor=user, name="Entry One"
        )
        create_formulation(
            organization=org, actor=user, name="Entry Two"
        )
        response = client.get(_list_url(org.id))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["results"], "expected at least one audit row"
        actions = {row["action"] for row in body["results"]}
        assert "formulation.create" in actions

    def test_does_not_leak_other_orgs(self) -> None:
        client, user, org = _owner_client()
        other = OrganizationFactory()
        # A write in the OTHER org should not appear for the
        # caller — audit is org-scoped and cross-tenant leakage
        # would be catastrophic.
        AuditLog.objects.create(
            organization=other,
            actor=None,
            action="formulation.create",
            target_type="formulation",
            target_id="00000000-0000-0000-0000-000000000000",
        )
        response = client.get(_list_url(org.id))
        body = response.json()
        for row in body["results"]:
            assert row["target_id"] != "00000000-0000-0000-0000-000000000000"

    def test_action_filter_narrows_results(self) -> None:
        client, user, org = _owner_client()
        formulation = create_formulation(
            organization=org, actor=user, name="Filter Demo"
        )
        # Produce a distinct second action so filters have
        # something to exclude.
        from apps.formulations.services import update_formulation

        update_formulation(
            formulation=formulation, actor=user, name="Renamed"
        )
        response = client.get(
            _list_url(org.id), {"action": "formulation.update"}
        )
        body = response.json()
        assert all(
            row["action"] == "formulation.update" for row in body["results"]
        )

    def test_action_prefix_groups_module_events(self) -> None:
        client, user, org = _owner_client()
        formulation = create_formulation(
            organization=org, actor=user, name="Prefix Demo"
        )
        from apps.formulations.services import save_version, update_formulation

        update_formulation(
            formulation=formulation, actor=user, name="Renamed"
        )
        save_version(formulation=formulation, actor=user)

        response = client.get(
            _list_url(org.id), {"action_prefix": "formulation"}
        )
        body = response.json()
        assert body["results"]
        assert all(
            row["action"].startswith("formulation")
            for row in body["results"]
        )

    def test_pagination_respects_page_size(self) -> None:
        client, user, org = _owner_client()
        # ~12 writes, capped at 5 per page.
        for i in range(12):
            create_formulation(
                organization=org, actor=user, name=f"P{i}"
            )
        response = client.get(_list_url(org.id), {"page_size": 5})
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["results"]) == 5
        assert body["next"] is not None
