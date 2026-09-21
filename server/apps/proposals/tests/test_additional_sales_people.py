"""Regression cover for :func:`set_additional_sales_people`.

The M2M is purely additive — every other render, integration, and
PSP payload keeps reading the singular ``sales_person`` FK — so the
tests here focus on the two invariants that keep the split honest:

* Every id must resolve to a live :class:`Membership` on the
  proposal's organization. Cross-tenant ids are refused.
* The primary ``sales_person`` can never appear in
  ``additional_sales_people``. That mutual exclusion is what lets
  the FE render "owner" vs "also worked on this" without a
  disambiguation step.

Bypasses :class:`ProposalFactory` because that helper funnels
through :func:`apps.formulations.services.save_version` which
currently fails an unrelated completeness gate on freshly-factoried
formulations; state is built manually at model level here.
"""

from __future__ import annotations

from uuid import uuid4

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.formulations.models import FormulationVersion
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.proposals.models import Proposal, ProposalStatus
from apps.proposals.services import (
    AdditionalSalesPersonIsPrimary,
    AdditionalSalesPersonNotMember,
    set_additional_sales_people,
)

pytestmark = pytest.mark.django_db


def _seed_proposal(org, owner, *, primary_sales_person=None):
    """Manually build the minimum state we need: a formulation, a
    version pinned as approved, and a draft proposal."""

    formulation = FormulationFactory(organization=org)
    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=1,
        created_by=owner,
    )
    return Proposal.objects.create(
        organization=org,
        formulation_version=version,
        code=f"PROP-{uuid4().hex[:6]}",
        status=ProposalStatus.DRAFT.value,
        currency="GBP",
        quantity=1,
        sales_person=primary_sales_person,
        created_by=owner,
        updated_by=owner,
    )


def _member_of(org, *, email_prefix="teammate"):
    """Create a user + a live Membership on ``org`` and return them."""

    user = UserFactory(
        email=f"{email_prefix}-{uuid4().hex[:6]}@example.test"
    )
    MembershipFactory(user=user, organization=org)
    return user


class TestSetAdditionalSalesPeople:
    def test_replaces_the_list_with_the_given_members(self):
        owner = UserFactory()
        org = create_organization(user=owner, name="Multi-Sales Co")
        proposal = _seed_proposal(org, owner)
        alice = _member_of(org, email_prefix="alice")
        bob = _member_of(org, email_prefix="bob")

        updated = set_additional_sales_people(
            proposal=proposal,
            actor=owner,
            user_ids=[str(alice.id), str(bob.id)],
        )
        assert set(updated.additional_sales_people.values_list("id", flat=True)) == {
            alice.id,
            bob.id,
        }

        # Second call with only one id replaces the list — not appends.
        set_additional_sales_people(
            proposal=proposal,
            actor=owner,
            user_ids=[str(alice.id)],
        )
        proposal.refresh_from_db()
        assert list(
            proposal.additional_sales_people.values_list("id", flat=True)
        ) == [alice.id]

    def test_empty_list_clears_the_m2m(self):
        owner = UserFactory()
        org = create_organization(user=owner, name="Clear Co")
        proposal = _seed_proposal(org, owner)
        alice = _member_of(org, email_prefix="alice")
        proposal.additional_sales_people.add(alice)

        set_additional_sales_people(
            proposal=proposal,
            actor=owner,
            user_ids=[],
        )
        assert proposal.additional_sales_people.count() == 0

    def test_primary_sales_person_refused(self):
        owner = UserFactory()
        org = create_organization(user=owner, name="Exclusive Co")
        primary = _member_of(org, email_prefix="primary")
        proposal = _seed_proposal(org, owner, primary_sales_person=primary)

        with pytest.raises(AdditionalSalesPersonIsPrimary):
            set_additional_sales_people(
                proposal=proposal,
                actor=owner,
                user_ids=[str(primary.id)],
            )

        proposal.refresh_from_db()
        assert proposal.additional_sales_people.count() == 0
        # Primary FK untouched.
        assert proposal.sales_person_id == primary.id

    def test_non_member_refused(self):
        owner = UserFactory()
        org_a = create_organization(user=owner, name="Org A")
        org_b = create_organization(user=UserFactory(), name="Org B")
        proposal = _seed_proposal(org_a, owner)
        stranger = _member_of(org_b, email_prefix="stranger")

        with pytest.raises(AdditionalSalesPersonNotMember):
            set_additional_sales_people(
                proposal=proposal,
                actor=owner,
                user_ids=[str(stranger.id)],
            )

        proposal.refresh_from_db()
        assert proposal.additional_sales_people.count() == 0

    def test_duplicate_ids_collapsed_silently(self):
        owner = UserFactory()
        org = create_organization(user=owner, name="Dedup Co")
        proposal = _seed_proposal(org, owner)
        alice = _member_of(org, email_prefix="alice")

        set_additional_sales_people(
            proposal=proposal,
            actor=owner,
            user_ids=[str(alice.id), str(alice.id), str(alice.id)],
        )
        proposal.refresh_from_db()
        assert list(
            proposal.additional_sales_people.values_list("id", flat=True)
        ) == [alice.id]
