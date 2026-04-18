"""Tests for the organizations service layer."""

from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import Membership, Organization
from apps.organizations.services import (
    create_organization,
    get_membership,
    granted_capabilities,
    has_capability,
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


class TestHasCapability:
    def test_none_membership_is_always_denied(self) -> None:
        assert has_capability(None, "members", "view") is False

    def test_owner_is_always_allowed(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        assert has_capability(membership, "members", "remove") is True
        assert (
            has_capability(membership, "catalogues", "delete", scope="anything")
            is True
        )

    def test_unknown_module_is_always_denied_even_for_owner(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        assert (
            has_capability(membership, "nonexistent_module", "view") is False
        )

    def test_unknown_capability_is_always_denied_even_for_owner(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        assert (
            has_capability(membership, "members", "not_a_real_capability")
            is False
        )

    @pytest.mark.parametrize(
        ("granted", "capability", "expected"),
        [
            (["view"], "view", True),
            (["view"], "invite", False),
            (["view", "invite"], "view", True),
            (["view", "invite"], "invite", True),
            (["view", "invite"], "remove", False),
            (
                ["view", "invite", "edit_permissions", "remove"],
                "remove",
                True,
            ),
        ],
    )
    def test_non_owner_capability_matrix(
        self, granted: list[str], capability: str, expected: bool
    ) -> None:
        membership = MembershipFactory(
            permissions={"members": granted},
            is_owner=False,
        )
        assert (
            has_capability(membership, "members", capability) is expected
        )

    def test_non_owner_with_no_grant_is_denied(self) -> None:
        membership = MembershipFactory(permissions={}, is_owner=False)
        assert has_capability(membership, "members", "view") is False

    def test_non_owner_with_garbage_grant_is_denied(self) -> None:
        # Someone tampered with the JSON and stuck a string where a
        # capability list should be. Must not grant any access.
        membership = MembershipFactory(
            permissions={"members": "admin"},
            is_owner=False,
        )
        assert has_capability(membership, "members", "view") is False

    def test_row_scoped_without_scope_is_denied(self) -> None:
        membership = MembershipFactory(
            permissions={"catalogues": {"raw_materials": ["view"]}},
            is_owner=False,
        )
        assert has_capability(membership, "catalogues", "view") is False

    def test_row_scoped_grant_is_per_slug(self) -> None:
        membership = MembershipFactory(
            permissions={
                "catalogues": {
                    "raw_materials": ["view", "edit"],
                    "packaging": ["view"],
                }
            },
            is_owner=False,
        )
        assert (
            has_capability(
                membership, "catalogues", "edit", scope="raw_materials"
            )
            is True
        )
        assert (
            has_capability(membership, "catalogues", "edit", scope="packaging")
            is False
        )

    def test_undeclared_capability_in_grant_is_ignored(self) -> None:
        # Someone inserts a typoed capability into the JSON. The check
        # must refuse it outright — typos cannot silently succeed.
        membership = MembershipFactory(
            permissions={"members": ["viewwww"]},
            is_owner=False,
        )
        assert has_capability(membership, "members", "viewwww") is False
        assert has_capability(membership, "members", "view") is False


class TestGrantedCapabilities:
    def test_owner_sees_every_declared_capability(self) -> None:
        user = UserFactory()
        org = create_organization(user=user, name="Owner Corp")
        membership = get_membership(user, org)
        caps = granted_capabilities(membership, "members")
        assert "view" in caps
        assert "invite" in caps
        assert "edit_permissions" in caps
        assert "remove" in caps

    def test_non_owner_returns_only_granted(self) -> None:
        membership = MembershipFactory(
            permissions={"members": ["view"]},
            is_owner=False,
        )
        caps = granted_capabilities(membership, "members")
        assert caps == frozenset({"view"})

    def test_row_scoped_returns_slug_specific_list(self) -> None:
        membership = MembershipFactory(
            permissions={
                "catalogues": {"raw_materials": ["view", "edit"]}
            },
            is_owner=False,
        )
        assert granted_capabilities(
            membership, "catalogues", scope="raw_materials"
        ) == frozenset({"view", "edit"})
        assert (
            granted_capabilities(membership, "catalogues", scope="packaging")
            == frozenset()
        )
