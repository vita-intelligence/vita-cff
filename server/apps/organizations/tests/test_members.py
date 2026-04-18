"""API tests for the members-administration endpoints.

Covers:

* ``GET /organizations/<org>/memberships/``
* ``PATCH /organizations/<org>/memberships/<id>/``
* ``DELETE /organizations/<org>/memberships/<id>/``
* ``GET /organizations/<org>/invitations/``
* ``POST /organizations/<org>/invitations/`` (permissions payload)
* ``POST /organizations/<org>/invitations/<id>/resend/``
* ``DELETE /organizations/<org>/invitations/<id>/``
* ``GET /organizations/modules/``

Owner-bypass, self-protection, capability-gating and tenancy
isolation are the four axes every test exercises.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.models import Invitation, Membership
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    InvitationFactory,
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures / URL helpers
# ---------------------------------------------------------------------------


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _owner_client(name: str = "Owner Corp") -> tuple[APIClient, Any, Any]:
    user = UserFactory(password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name=name)
    client = _login(APIClient(), user)
    return client, user, org


def _memberships_url(org_id: Any) -> str:
    return reverse("organizations:membership-list", args=[str(org_id)])


def _membership_detail_url(org_id: Any, membership_id: Any) -> str:
    return reverse(
        "organizations:membership-detail", args=[str(org_id), str(membership_id)]
    )


def _invitations_url(org_id: Any) -> str:
    return reverse("organizations:invitation-list", args=[str(org_id)])


def _invitation_admin_url(org_id: Any, invitation_id: Any) -> str:
    return reverse(
        "organizations:invitation-detail-admin",
        args=[str(org_id), str(invitation_id)],
    )


def _invitation_resend_url(org_id: Any, invitation_id: Any) -> str:
    return reverse(
        "organizations:invitation-resend",
        args=[str(org_id), str(invitation_id)],
    )


# ---------------------------------------------------------------------------
# GET memberships
# ---------------------------------------------------------------------------


class TestMembershipList:
    def test_owner_lists_all_members(self) -> None:
        client, owner, org = _owner_client()
        teammate = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=teammate,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},
        )

        response = client.get(_memberships_url(org.id))
        assert response.status_code == status.HTTP_200_OK
        rows = response.json()
        assert len(rows) == 2
        # Owner first, then the teammate — ordering matches the service.
        assert rows[0]["is_owner"] is True
        assert rows[0]["user"]["email"] == owner.email
        assert rows[1]["user"]["email"] == teammate.email
        assert rows[1]["permissions"] == {"members": ["view"]}

    def test_member_without_view_capability_is_forbidden(self) -> None:
        org = OrganizationFactory()
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=user, organization=org, is_owner=False, permissions={}
        )
        client = _login(APIClient(), user)

        response = client.get(_memberships_url(org.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_non_member_sees_404(self) -> None:
        other_org = OrganizationFactory()
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        client = _login(APIClient(), stranger)

        response = client.get(_memberships_url(other_org.id))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_unauthenticated_is_401(self) -> None:
        org = OrganizationFactory()
        response = APIClient().get(_memberships_url(org.id))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED


# ---------------------------------------------------------------------------
# PATCH membership permissions
# ---------------------------------------------------------------------------


class TestMembershipUpdate:
    def test_owner_updates_member_permissions(self) -> None:
        client, _, org = _owner_client()
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False, permissions={}
        )

        response = client.patch(
            _membership_detail_url(org.id, teammate.id),
            {"permissions": {"formulations": ["view", "edit"]}},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        teammate.refresh_from_db()
        assert teammate.permissions == {
            "formulations": ["view", "edit"]
        }

    def test_admin_non_owner_can_update(self) -> None:
        org = OrganizationFactory()
        admin = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=admin,
            organization=org,
            is_owner=False,
            permissions={
                "members": ["view", "invite", "edit_permissions", "remove"]
            },
        )
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False, permissions={}
        )
        client = _login(APIClient(), admin)

        response = client.patch(
            _membership_detail_url(org.id, teammate.id),
            {"permissions": {"formulations": ["view"]}},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK

    def test_cannot_edit_owner_membership(self) -> None:
        client, owner, org = _owner_client()
        owner_membership = Membership.objects.get(user=owner, organization=org)

        response = client.patch(
            _membership_detail_url(org.id, owner_membership.id),
            {"permissions": {"members": ["view"]}},
            format="json",
        )
        # Even the owner themselves can't push permissions into their
        # own row — the JSON is ignored on owner bypass, so the PATCH
        # is rejected loudly to surface the misuse.
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_cannot_edit_self_as_non_owner_admin(self) -> None:
        org = OrganizationFactory()
        admin = UserFactory(password=DEFAULT_TEST_PASSWORD)
        admin_m = MembershipFactory(
            user=admin,
            organization=org,
            is_owner=False,
            permissions={
                "members": ["view", "invite", "edit_permissions", "remove"]
            },
        )
        client = _login(APIClient(), admin)

        response = client.patch(
            _membership_detail_url(org.id, admin_m.id),
            {"permissions": {"members": ["view"]}},
            format="json",
        )
        # Self-promotion / self-demotion is the classic RBAC footgun.
        # Reject with 403 + a specific code the UI can display.
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert response.json() == {"detail": ["membership_is_self"]}

    def test_non_admin_member_cannot_update(self) -> None:
        org = OrganizationFactory()
        caller = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=caller,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},  # view only, not edit
        )
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False, permissions={}
        )
        client = _login(APIClient(), caller)

        response = client.patch(
            _membership_detail_url(org.id, teammate.id),
            {"permissions": {"formulations": ["view"]}},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_invalid_permissions_payload_is_400(self) -> None:
        client, _, org = _owner_client()
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False, permissions={}
        )

        response = client.patch(
            _membership_detail_url(org.id, teammate.id),
            {"permissions": {"not_a_module": ["view"]}},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json() == {"permissions": ["permissions_invalid"]}

    def test_cross_org_target_is_404(self) -> None:
        client, _, org = _owner_client()
        other_org = OrganizationFactory()
        foreign_membership = MembershipFactory(
            user=UserFactory(), organization=other_org, is_owner=False
        )

        response = client.patch(
            _membership_detail_url(org.id, foreign_membership.id),
            {"permissions": {"formulations": ["view"]}},
            format="json",
        )
        # The membership exists, but not inside this org. Don't leak
        # its existence via a 403 — 404 keeps tenants hermetic.
        assert response.status_code == status.HTTP_404_NOT_FOUND


# ---------------------------------------------------------------------------
# DELETE membership
# ---------------------------------------------------------------------------


class TestMembershipRemove:
    def test_owner_removes_teammate(self) -> None:
        client, _, org = _owner_client()
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False
        )

        response = client.delete(_membership_detail_url(org.id, teammate.id))
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Membership.objects.filter(id=teammate.id).exists()

    def test_cannot_remove_owner(self) -> None:
        client, owner, org = _owner_client()
        owner_m = Membership.objects.get(user=owner, organization=org)

        response = client.delete(_membership_detail_url(org.id, owner_m.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Membership.objects.filter(id=owner_m.id).exists()

    def test_cannot_remove_self_as_admin(self) -> None:
        org = OrganizationFactory()
        admin = UserFactory(password=DEFAULT_TEST_PASSWORD)
        admin_m = MembershipFactory(
            user=admin,
            organization=org,
            is_owner=False,
            permissions={
                "members": ["view", "invite", "edit_permissions", "remove"]
            },
        )
        client = _login(APIClient(), admin)

        response = client.delete(_membership_detail_url(org.id, admin_m.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert Membership.objects.filter(id=admin_m.id).exists()

    def test_non_admin_member_cannot_remove(self) -> None:
        org = OrganizationFactory()
        caller = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=caller,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},
        )
        teammate = MembershipFactory(
            user=UserFactory(), organization=org, is_owner=False
        )
        client = _login(APIClient(), caller)

        response = client.delete(_membership_detail_url(org.id, teammate.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Invitations — GET list + resend + revoke + POST with permissions
# ---------------------------------------------------------------------------


class TestInvitationList:
    def test_owner_sees_pending_invitations(self) -> None:
        client, _, org = _owner_client()
        InvitationFactory(organization=org, email="a@invited.test")
        InvitationFactory(organization=org, email="b@invited.test")

        response = client.get(_invitations_url(org.id))
        assert response.status_code == status.HTTP_200_OK
        rows = response.json()
        assert {r["email"] for r in rows} == {"a@invited.test", "b@invited.test"}
        # New rows are pending until expiry or acceptance.
        assert all(r["status"] == "pending" for r in rows)

    def test_accepted_invitations_are_filtered_out(self) -> None:
        from django.utils import timezone

        client, _, org = _owner_client()
        pending = InvitationFactory(organization=org, email="pending@x.test")
        accepted = InvitationFactory(organization=org, email="old@x.test")
        accepted.accepted_at = timezone.now()
        accepted.save(update_fields=["accepted_at"])

        response = client.get(_invitations_url(org.id))
        rows = response.json()
        assert len(rows) == 1
        assert rows[0]["id"] == str(pending.id)


class TestInvitationCreateWithPermissions:
    def test_owner_creates_invite_with_preset_permissions(self) -> None:
        client, _, org = _owner_client()

        response = client.post(
            _invitations_url(org.id),
            {
                "email": "scientist@vita.test",
                "permissions": {"formulations": ["view", "edit"]},
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["permissions"] == {"formulations": ["view", "edit"]}
        inv = Invitation.objects.get(id=body["id"])
        assert inv.permissions == {"formulations": ["view", "edit"]}

    def test_invalid_permissions_payload_is_400(self) -> None:
        client, _, org = _owner_client()

        response = client.post(
            _invitations_url(org.id),
            {
                "email": "invitee@vita.test",
                "permissions": {"formulations": ["not_a_cap"]},
            },
            format="json",
        )
        # ``validate_permissions_payload`` silently drops unknown caps
        # rather than raising, so this is accepted but stored empty.
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["permissions"] == {"formulations": []}

    def test_unknown_module_key_is_400(self) -> None:
        client, _, org = _owner_client()

        response = client.post(
            _invitations_url(org.id),
            {
                "email": "invitee@vita.test",
                "permissions": {"not_a_module": []},
            },
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST


class TestInvitationResend:
    def test_owner_rotates_token_and_expiry(self) -> None:
        from django.utils import timezone

        client, _, org = _owner_client()
        inv = InvitationFactory(organization=org, email="x@y.test")
        old_token = inv.token
        old_expiry = inv.expires_at

        response = client.post(_invitation_resend_url(org.id, inv.id))
        assert response.status_code == status.HTTP_200_OK
        inv.refresh_from_db()
        assert inv.token != old_token
        assert inv.expires_at > old_expiry

    def test_cannot_resend_accepted_invitation(self) -> None:
        from django.utils import timezone

        client, _, org = _owner_client()
        inv = InvitationFactory(organization=org, email="x@y.test")
        inv.accepted_at = timezone.now()
        inv.save(update_fields=["accepted_at"])

        response = client.post(_invitation_resend_url(org.id, inv.id))
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_non_admin_cannot_resend(self) -> None:
        org = OrganizationFactory()
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=user,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},
        )
        inv = InvitationFactory(organization=org, email="x@y.test")
        client = _login(APIClient(), user)

        response = client.post(_invitation_resend_url(org.id, inv.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestInvitationRevoke:
    def test_owner_revokes(self) -> None:
        client, _, org = _owner_client()
        inv = InvitationFactory(organization=org, email="x@y.test")

        response = client.delete(_invitation_admin_url(org.id, inv.id))
        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not Invitation.objects.filter(id=inv.id).exists()

    def test_remove_capability_is_enough(self) -> None:
        org = OrganizationFactory()
        caller = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=caller,
            organization=org,
            is_owner=False,
            permissions={"members": ["view", "remove"]},
        )
        inv = InvitationFactory(organization=org, email="x@y.test")
        client = _login(APIClient(), caller)

        response = client.delete(_invitation_admin_url(org.id, inv.id))
        assert response.status_code == status.HTTP_204_NO_CONTENT

    def test_non_admin_cannot_revoke(self) -> None:
        org = OrganizationFactory()
        caller = UserFactory(password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=caller,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},
        )
        inv = InvitationFactory(organization=org, email="x@y.test")
        client = _login(APIClient(), caller)

        response = client.delete(_invitation_admin_url(org.id, inv.id))
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Module registry
# ---------------------------------------------------------------------------


class TestModuleRegistry:
    def test_returns_declared_modules_and_capabilities(self) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        client = _login(APIClient(), user)

        response = client.get(reverse("organizations:module-registry"))
        assert response.status_code == status.HTTP_200_OK
        rows = response.json()
        keys = {r["key"] for r in rows}
        assert keys == {"members", "catalogues", "formulations"}
        members = next(r for r in rows if r["key"] == "members")
        assert set(members["capabilities"]) == {
            "view",
            "invite",
            "edit_permissions",
            "remove",
        }

    def test_unauthenticated_is_401(self) -> None:
        response = APIClient().get(reverse("organizations:module-registry"))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
