"""Unit tests for the organizations models."""

from __future__ import annotations

import pytest
from django.db import IntegrityError

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import Membership, Organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


class TestOrganizationModel:
    def test_str_returns_name(self) -> None:
        org = OrganizationFactory(name="Acme Labs")
        assert str(org) == "Acme Labs"

    def test_created_by_is_required(self) -> None:
        with pytest.raises(IntegrityError):
            Organization.objects.create(name="Orphan", created_by=None)


class TestMembershipModel:
    def test_defaults_are_non_owner_with_empty_permissions(self) -> None:
        user = UserFactory()
        org = OrganizationFactory()
        membership = Membership.objects.create(user=user, organization=org)
        assert membership.is_owner is False
        assert membership.permissions == {}

    def test_unique_user_per_organization(self) -> None:
        user = UserFactory()
        org = OrganizationFactory()
        Membership.objects.create(user=user, organization=org)
        with pytest.raises(IntegrityError):
            Membership.objects.create(user=user, organization=org)

    def test_same_user_can_belong_to_many_organizations(self) -> None:
        user = UserFactory()
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        MembershipFactory(user=user, organization=org_a)
        MembershipFactory(user=user, organization=org_b)
        assert Membership.objects.filter(user=user).count() == 2
