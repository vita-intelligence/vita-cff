"""Tests for the membership ``groups`` classifier.

Groups are a directory tag used to scope picker dropdowns (sales
filter bar, future scientist picker) without restricting what a
member can actually do. They're independent of the permission grid:

* Service ``update_membership_groups`` validates against the
  ``MEMBERSHIP_GROUPS`` frozenset; unknown values fall through.
* ``list_memberships(group="sales")`` narrows the roster to
  members tagged with that role, plus the org owner (admins always
  appear in every directory dropdown).
"""

from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.models import MEMBERSHIP_GROUPS, Membership
from apps.organizations.services import (
    InvalidMembershipPayload,
    create_organization,
    list_memberships,
    update_membership_groups,
)
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


def _login(client: APIClient, user) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


class TestUpdateMembershipGroups:
    def test_known_groups_persist(self) -> None:
        org = OrganizationFactory()
        member = UserFactory(email="alice@vita.test")
        membership = MembershipFactory(user=member, organization=org)

        updated = update_membership_groups(
            membership=membership, groups=["scientist", "sales"]
        )
        assert sorted(updated.groups) == ["sales", "scientist"]

    def test_unknown_groups_silently_dropped(self) -> None:
        # A stale client sending a renamed group should not 400 the
        # whole save. The service drops the bad value so the rest of
        # the payload still applies — same defensive policy used by
        # the permissions validator.
        org = OrganizationFactory()
        member = UserFactory(email="bob@vita.test")
        membership = MembershipFactory(user=member, organization=org)

        updated = update_membership_groups(
            membership=membership,
            groups=["sales", "marketing", "scientist", ""],
        )
        assert sorted(updated.groups) == ["sales", "scientist"]

    def test_duplicates_collapse(self) -> None:
        # ``groups`` is a tag list, not a multiset — repeated entries
        # collapse so the stored column stays clean.
        org = OrganizationFactory()
        member = UserFactory(email="dup@vita.test")
        membership = MembershipFactory(user=member, organization=org)

        updated = update_membership_groups(
            membership=membership, groups=["sales", "sales", "scientist"]
        )
        assert sorted(updated.groups) == ["sales", "scientist"]

    def test_empty_list_clears(self) -> None:
        org = OrganizationFactory()
        member = UserFactory(email="clear@vita.test")
        membership = MembershipFactory(
            user=member, organization=org, groups=["sales"]
        )

        updated = update_membership_groups(membership=membership, groups=[])
        assert updated.groups == []

    def test_non_list_payload_raises(self) -> None:
        org = OrganizationFactory()
        member = UserFactory(email="bad@vita.test")
        membership = MembershipFactory(user=member, organization=org)

        with pytest.raises(InvalidMembershipPayload):
            update_membership_groups(
                membership=membership, groups={"sales": True}
            )


class TestListMembershipsGroupFilter:
    def test_no_group_returns_all(self) -> None:
        org = OrganizationFactory()
        MembershipFactory(organization=org)
        MembershipFactory(organization=org)
        # ``OrganizationFactory`` creates an owner membership too.

        # Total = 2 explicit + 1 owner from the factory.
        result = list(list_memberships(organization=org))
        assert len(result) == 3

    def test_sales_filter_narrows_to_tagged_only(self) -> None:
        # Tag-driven uniform filter — owners are no longer force-
        # included. Earlier the service auto-added owners on every
        # group-scoped query and admins couldn't take them out of
        # the sales picker without revoking ownership. Now if the
        # owner needs to appear, the admin tags them; if they
        # shouldn't appear, they stay untagged.
        org = OrganizationFactory()
        sales_user = UserFactory(email="sales1@vita.test")
        sci_user = UserFactory(email="sci1@vita.test")
        other = UserFactory(email="ops@vita.test")
        MembershipFactory(
            user=sales_user, organization=org, groups=["sales"]
        )
        MembershipFactory(
            user=sci_user, organization=org, groups=["scientist"]
        )
        MembershipFactory(user=other, organization=org, groups=[])

        results = list(list_memberships(organization=org, group="sales"))
        emails = {m.user.email for m in results}
        assert emails == {sales_user.email}
        # Owner is NOT auto-included when not tagged — must be
        # explicitly opted in via :func:`update_membership_groups`.
        assert org.created_by.email not in emails

    def test_owner_appears_in_filter_only_when_tagged(self) -> None:
        # Inverse of the previous test: when the admin tags the
        # owner with ``sales``, they DO surface in the sales picker.
        # Confirms there's no special hidden filtering for owners.
        from apps.organizations.models import Membership

        org = OrganizationFactory()
        owner_membership = Membership.objects.get(
            user=org.created_by, organization=org
        )
        owner_membership.groups = ["sales"]
        owner_membership.save(update_fields=["groups"])
        MembershipFactory(
            user=UserFactory(email="rep@vita.test"),
            organization=org,
            groups=["sales"],
        )

        results = list(list_memberships(organization=org, group="sales"))
        emails = {m.user.email for m in results}
        assert org.created_by.email in emails
        assert "rep@vita.test" in emails

    def test_unknown_group_filter_falls_through(self) -> None:
        # A stale URL with an unrecognised group value should return
        # the full list rather than a confusing empty page.
        org = OrganizationFactory()
        MembershipFactory(organization=org)

        result = list(
            list_memberships(organization=org, group="marketing")
        )
        # 1 explicit + 1 owner.
        assert len(result) == 2

    def test_member_in_both_groups_appears_in_either_filter(self) -> None:
        # Multi-tag is supported — a hybrid sales/scientist shows up
        # in both directories.
        org = OrganizationFactory()
        hybrid_user = UserFactory(email="hybrid@vita.test")
        MembershipFactory(
            user=hybrid_user,
            organization=org,
            groups=["sales", "scientist"],
        )

        sales = list(list_memberships(organization=org, group="sales"))
        sci = list(list_memberships(organization=org, group="scientist"))
        assert hybrid_user.email in {m.user.email for m in sales}
        assert hybrid_user.email in {m.user.email for m in sci}


class TestMembershipGroupsEndpoint:
    def test_admin_can_set_groups(self) -> None:
        admin = UserFactory(email="admin@vita.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=admin, name="Vita")
        teammate = UserFactory(email="member@vita.test")
        target = MembershipFactory(user=teammate, organization=org)

        client = _login(APIClient(), admin)
        url = reverse(
            "organizations:membership-groups",
            kwargs={"org_id": str(org.id), "membership_id": str(target.id)},
        )
        response = client.patch(
            url, {"groups": ["sales"]}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK
        target.refresh_from_db()
        assert target.groups == ["sales"]

    def test_non_admin_is_rejected(self) -> None:
        admin = UserFactory(email="owner-rbac@vita.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=admin, name="Vita RBAC")
        teammate = UserFactory(email="staff@vita.test", password=DEFAULT_TEST_PASSWORD)
        # Plain non-admin membership — no members.edit_permissions cap.
        target = MembershipFactory(
            user=teammate,
            organization=org,
            permissions={"members": ["view"]},
        )

        client = _login(APIClient(), teammate)
        url = reverse(
            "organizations:membership-groups",
            kwargs={"org_id": str(org.id), "membership_id": str(target.id)},
        )
        response = client.patch(
            url, {"groups": ["sales"]}, format="json"
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_owner_can_be_tagged(self) -> None:
        # The org owner is a member too — admins should be able to
        # tag them so they appear in the sales picker when they
        # handle commercial work directly.
        admin = UserFactory(email="owner-tag@vita.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=admin, name="Vita Tag Owner")
        owner_membership = Membership.objects.get(user=admin, organization=org)

        client = _login(APIClient(), admin)
        url = reverse(
            "organizations:membership-groups",
            kwargs={"org_id": str(org.id), "membership_id": str(owner_membership.id)},
        )
        response = client.patch(
            url, {"groups": ["sales"]}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK
        owner_membership.refresh_from_db()
        assert owner_membership.groups == ["sales"]


def test_groups_constant_is_fixed_for_now() -> None:
    # Pin the supported group set so a code change introducing a
    # third group doesn't slip in without a deliberate test update.
    assert MEMBERSHIP_GROUPS == frozenset({"scientist", "sales"})
