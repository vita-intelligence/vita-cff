"""Factory Boy factories for the organizations app."""

from __future__ import annotations

from typing import Any

import factory

from apps.accounts.tests.factories import UserFactory
from apps.organizations.models import Invitation, Membership, Organization


class OrganizationFactory(factory.django.DjangoModelFactory):
    """Build an :class:`Organization` with a fresh owner if none is given."""

    class Meta:
        model = Organization
        skip_postgeneration_save = True

    name = factory.Sequence(lambda n: f"Org {n}")
    created_by = factory.SubFactory(UserFactory)

    @factory.post_generation
    def owner_membership(
        self,
        create: bool,
        extracted: Any,
        **kwargs: Any,
    ) -> None:
        if not create:
            return
        # Mirror the service layer: every organization has its creator as
        # an owner membership. Bypassing the service here keeps tests fast
        # but still guarantees the same invariant.
        Membership.objects.get_or_create(
            user=self.created_by,
            organization=self,
            defaults={"is_owner": True, "permissions": {}},
        )


class MembershipFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Membership
        django_get_or_create = ("user", "organization")
        skip_postgeneration_save = True

    user = factory.SubFactory(UserFactory)
    organization = factory.SubFactory(OrganizationFactory)
    is_owner = False
    permissions: dict[str, str] = factory.LazyFunction(dict)


class InvitationFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Invitation
        skip_postgeneration_save = True

    organization = factory.SubFactory(OrganizationFactory)
    invited_by = factory.SelfAttribute("organization.created_by")
    email = factory.Sequence(lambda n: f"invitee{n}@vita.test")
    permissions: dict[str, str] = factory.LazyFunction(dict)
