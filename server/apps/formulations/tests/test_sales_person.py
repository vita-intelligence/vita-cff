"""Integration tests for the sales-person assignment flow.

Covers the three invariants of the feature:

* the dedicated capability gates the endpoint — holders of the
  general ``edit`` capability cannot assign a sales person unless
  they also hold ``assign_sales_person``;
* cross-tenant or unknown users are rejected with a 400, never
  silently attached;
* the audit log captures every assignment so we can reconstruct
  the commercial handoff timeline during disputes.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.audit.models import AuditLog
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory

pytestmark = pytest.mark.django_db


def _sales_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-sales-person",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


class TestAssignSalesPerson:
    def test_owner_can_assign_member(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Assign Co")
        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": str(teammate.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data["sales_person"]["id"] == str(teammate.id)
        formulation.refresh_from_db()
        assert formulation.sales_person_id == teammate.id

    def test_clear_assignment(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Clear Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner, sales_person=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": None},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data["sales_person"] is None

    def test_edit_capability_alone_is_not_enough(
        self, api_client: APIClient
    ) -> None:
        # Editor has ``formulations.edit`` but lacks the new sales
        # capability — they should hit a 403.
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Split Perms Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"formulations": ["view", "edit"]},
        )
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, editor)

        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)
        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": str(teammate.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_sales_capability_alone_is_enough(
        self, api_client: APIClient
    ) -> None:
        # Mirror of the above: a user with only the sales capability
        # — no edit grant — must still be able to assign.
        owner = UserFactory()
        sales_admin = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Sales Only Co")
        MembershipFactory(
            user=sales_admin,
            organization=org,
            permissions={"formulations": ["assign_sales_person"]},
        )
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, sales_admin)

        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)
        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": str(teammate.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK

    def test_non_member_user_rejected(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Fortress Co")
        outsider = UserFactory()  # explicitly no membership
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": str(outsider.id)},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["user_id"] == ["sales_person_not_member"]

    def test_unknown_user_id_rejected(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Ghost Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        response = api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": "11111111-1111-1111-1111-111111111111"},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["user_id"] == ["sales_person_not_member"]

    def test_assignment_writes_audit_record(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Paper Trail Co")
        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        _login(api_client, owner)

        api_client.put(
            _sales_url(str(org.id), str(formulation.id)),
            {"user_id": str(teammate.id)},
            format="json",
        )

        audit = AuditLog.objects.filter(
            action="formulation.assign_sales_person"
        ).first()
        assert audit is not None
        assert audit.actor_id == owner.id
        assert audit.organization_id == org.id
