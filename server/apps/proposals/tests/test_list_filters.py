"""Tests for the org-wide proposals list filter surface.

The org-wide list bar (`/proposals`) lets sales narrow the list by
search text, status (multi-select), sales person, and valid-until
date range. The director's approval inbox (single ``status=``) and
the per-project panel (``formulation_id=``) keep their legacy
single-value contract — these new filters layer on top.
"""

from __future__ import annotations

from datetime import date

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import ProposalStatus
from apps.proposals.services import list_proposals
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


class TestListProposalsFilters:
    def test_search_matches_code(self) -> None:
        org = OrganizationFactory()
        match = ProposalFactory(organization=org, code="P-700-burner")
        ProposalFactory(organization=org, code="P-800-energy")

        results = list(list_proposals(organization=org, search="burner"))
        assert {p.id for p in results} == {match.id}

    def test_search_matches_customer_name_and_company(self) -> None:
        org = OrganizationFactory()
        by_name = ProposalFactory(
            organization=org, customer_name="Jane Acme", customer_company=""
        )
        by_company = ProposalFactory(
            organization=org, customer_name="", customer_company="Acme Foods"
        )
        ProposalFactory(
            organization=org, customer_name="Bob", customer_company="Other"
        )

        results = list(list_proposals(organization=org, search="acme"))
        assert {p.id for p in results} == {by_name.id, by_company.id}

    def test_statuses_filter_multi_select(self) -> None:
        # Multi-select returns the union — sales asking for "draft OR
        # in_review" gets both buckets.
        org = OrganizationFactory()
        draft = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        review = ProposalFactory(
            organization=org, status=ProposalStatus.IN_REVIEW.value
        )
        ProposalFactory(organization=org, status=ProposalStatus.SENT.value)

        results = list(
            list_proposals(
                organization=org,
                statuses=[
                    ProposalStatus.DRAFT.value,
                    ProposalStatus.IN_REVIEW.value,
                ],
            )
        )
        assert {p.id for p in results} == {draft.id, review.id}

    def test_empty_statuses_list_is_ignored(self) -> None:
        # A stale URL with ``?statuses=`` would otherwise produce an
        # empty IN clause and hide everything. The list filter is
        # forgiving so the URL state can round-trip without surprises.
        org = OrganizationFactory()
        ProposalFactory(organization=org)
        ProposalFactory(organization=org)

        assert len(list(list_proposals(organization=org, statuses=[]))) == 2

    def test_sales_person_filter(self) -> None:
        org = OrganizationFactory()
        alice = UserFactory(email="alice-prop@vita.test")
        match = ProposalFactory(organization=org, sales_person=alice)
        ProposalFactory(organization=org, sales_person=None)

        results = list(
            list_proposals(organization=org, sales_person_id=alice.id)
        )
        assert {p.id for p in results} == {match.id}

    def test_sales_person_unassigned_bucket(self) -> None:
        # The frontend dropdown exposes an "Unassigned" option mapped
        # to this magic string. Resolves to ``sales_person IS NULL``
        # so the bucket is discoverable without a null sentinel in
        # the URL.
        org = OrganizationFactory()
        alice = UserFactory(email="alice-unassigned@vita.test")
        ProposalFactory(organization=org, sales_person=alice)
        match = ProposalFactory(organization=org, sales_person=None)

        results = list(
            list_proposals(organization=org, sales_person_id="unassigned")
        )
        assert {p.id for p in results} == {match.id}

    def test_valid_until_range(self) -> None:
        # Inclusive bounds — both endpoints are part of the result
        # set. Sales filters for "expiring this week" with a tight
        # range that includes the boundary days.
        org = OrganizationFactory()
        early = ProposalFactory(
            organization=org, valid_until=date(2026, 5, 10)
        )
        mid = ProposalFactory(
            organization=org, valid_until=date(2026, 5, 15)
        )
        late = ProposalFactory(
            organization=org, valid_until=date(2026, 5, 25)
        )

        results = list(
            list_proposals(
                organization=org,
                valid_until_from=date(2026, 5, 10),
                valid_until_to=date(2026, 5, 20),
            )
        )
        assert {p.id for p in results} == {early.id, mid.id}
        assert late.id not in {p.id for p in results}

    def test_filters_compose(self) -> None:
        # Layered narrowing — search AND status AND sales person AND
        # valid-until must all match. Confirms no filter silently
        # short-circuits when others are active.
        org = OrganizationFactory()
        alice = UserFactory(email="combo-prop@vita.test")
        match = ProposalFactory(
            organization=org,
            code="P-burner-700",
            customer_name="Acme",
            status=ProposalStatus.SENT.value,
            sales_person=alice,
            valid_until=date(2026, 5, 14),
        )
        # Wrong status:
        ProposalFactory(
            organization=org,
            code="P-burner-701",
            customer_name="Acme",
            status=ProposalStatus.DRAFT.value,
            sales_person=alice,
            valid_until=date(2026, 5, 14),
        )
        # Wrong sales person:
        ProposalFactory(
            organization=org,
            code="P-burner-702",
            customer_name="Acme",
            status=ProposalStatus.SENT.value,
            sales_person=None,
            valid_until=date(2026, 5, 14),
        )
        # Out of date range:
        ProposalFactory(
            organization=org,
            code="P-burner-703",
            customer_name="Acme",
            status=ProposalStatus.SENT.value,
            sales_person=alice,
            valid_until=date(2026, 6, 1),
        )

        results = list(
            list_proposals(
                organization=org,
                search="burner",
                statuses=[ProposalStatus.SENT.value],
                sales_person_id=alice.id,
                valid_until_from=date(2026, 5, 1),
                valid_until_to=date(2026, 5, 31),
            )
        )
        assert {p.id for p in results} == {match.id}
