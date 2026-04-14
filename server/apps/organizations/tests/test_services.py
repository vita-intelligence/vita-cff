"""Tests for the organizations service layer."""

from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import Membership, Organization
from apps.organizations.modules import PermissionLevel
from apps.organizations.services import (
    create_organization,
    get_membership,
    has_permission,
    list_user_organizations,
)
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


class TestCreateOrganization:
    def test_creates_org_and_owner_membership(self) -> None:
        user = UserFactory()

        org = create_organization(user=user, name="Acme Labs")

        assert Organization.objects.count() == 1
        assert org.name == "Acme Labs"
        assert org.created_by == user

        membership = Membership.objects.get(user=user, organization=org)
        assert membership.is_owner is True
        assert membership.permissions == {}

    def test_creating_two_orgs_for_same_user_yields_two_memberships(self) -> None:
        user = UserFactory()

        create_organization(user=user, name="Alpha")
        create_organization(user=user, name="Beta")

        assert Membership.objects.filter(user=user).count() == 2
        assert list_user_organizations(user).count() == 2


class TestListUserOrganizations:
    def test_returns_only_orgs_the_user_belongs_to(self) -> None:
        alice = UserFactory()
        bob = UserFactory()

        alice_org = create_organization(user=alice, name="Alice Co")
        create_organization(user=bob, name="Bob Co")

        result = list(list_user_organizations(alice))
        assert result == [alice_org]

    def test_returns_empty_queryset_for_user_with_no_orgs(self) -> None:
        loner = UserFactory()
        OrganizationFactory()  # someone else's org
        assert list(list_user_organizations(loner)) == []


class TestGetMembership:
    def test_returns_membership_when_user_is_a_member(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Solo")
        membership = get_membership(user, org)
        assert membership is not None
        assert membership.is_owner is True

    def test_returns_none_when_user_is_not_a_member(self) -> None:
        user = UserFactory()
        org = OrganizationFactory()
        assert get_membership(user, org) is None


class TestHasPermission:
    def test_none_membership_is_always_denied(self) -> None:
        assert has_permission(None, "members", PermissionLevel.READ) is False

    def test_owner_is_always_allowed(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        assert has_permission(membership, "members", PermissionLevel.ADMIN) is True

    def test_unknown_module_is_always_denied_even_for_owner(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        assert (
            has_permission(membership, "nonexistent_module", PermissionLevel.READ)
            is False
        )

    @pytest.mark.parametrize(
        ("granted", "required", "expected"),
        [
            ("read", PermissionLevel.READ, True),
            ("read", PermissionLevel.WRITE, False),
            ("write", PermissionLevel.READ, True),
            ("write", PermissionLevel.WRITE, True),
            ("write", PermissionLevel.ADMIN, False),
            ("admin", PermissionLevel.ADMIN, True),
        ],
    )
    def test_non_owner_permission_matrix(
        self, granted: str, required: PermissionLevel, expected: bool
    ) -> None:
        membership = MembershipFactory(
            permissions={"members": granted},
            is_owner=False,
        )
        assert has_permission(membership, "members", required) is expected

    def test_non_owner_with_no_grant_is_denied(self) -> None:
        membership = MembershipFactory(permissions={}, is_owner=False)
        assert has_permission(membership, "members", PermissionLevel.READ) is False

    def test_non_owner_with_garbage_grant_is_denied(self) -> None:
        membership = MembershipFactory(
            permissions={"members": "not-a-level"},
            is_owner=False,
        )
        assert has_permission(membership, "members", PermissionLevel.READ) is False
