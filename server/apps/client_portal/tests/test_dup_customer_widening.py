"""Tests for the email-keyed customer widening + auto-merge.

Three layers under test:

1. :func:`apps.client_portal.queries.customer_ids_for_account` —
   the read-widening helper that unions the FK target with every
   sibling Customer row sharing the account's email in the same
   org. Org-scoping is the load-bearing invariant: a generic email
   shared across distinct tenants must NEVER produce a cross-org
   match.
2. The portal proposal-list endpoint — proof that a proposal
   attached to a sibling Customer row surfaces for the login on the
   canonical row.
3. :func:`apps.customers.services.merge_customers` +
   :func:`auto_merge_email_duplicates` — the merge service and its
   auto-invoke wrapper. Verifies proposals + portal logins + aliases
   all repoint, the duplicate row is deleted, and an audit row is
   written.
"""

from __future__ import annotations

import uuid

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.audit.models import AuditLog
from apps.client_portal.models import ClientAccount
from apps.client_portal.queries import customer_ids_for_account
from apps.customers.models import Customer, CustomerEmailAlias
from apps.customers.services import (
    CustomerMergeError,
    auto_merge_email_duplicates,
    merge_customers,
    pick_merge_canonical,
)
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.tests.factories import ProposalFactory


# ---------------------------------------------------------------------------
# customer_ids_for_account
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCustomerIdsForAccount:
    """The widening helper that every portal read leans on."""

    def _account_with_email(self, email: str, customer: Customer) -> ClientAccount:
        return ClientAccount.objects.create_account(
            email=email,
            customer=customer,
            password="ssss-12345-tttt",
        )

    def test_returns_only_the_fk_target_when_no_siblings(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        customer = Customer.objects.create(
            organization=org,
            email="solo@example.com",
            created_by=actor,
            updated_by=actor,
        )
        account = self._account_with_email("solo@example.com", customer)

        ids = customer_ids_for_account(account)
        assert ids == [customer.id]

    def test_returns_canonical_plus_sibling_when_email_matches(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="dupe@example.com",
            company="Portal Active",
            created_by=actor,
            updated_by=actor,
        )
        sibling = Customer.objects.create(
            organization=org,
            email="dupe@example.com",
            company="Old Row With Proposals",
            created_by=actor,
            updated_by=actor,
        )
        account = self._account_with_email("dupe@example.com", canonical)

        ids = customer_ids_for_account(account)
        assert canonical.id in ids
        assert sibling.id in ids
        # Canonical is always first — readers may rely on the order
        # when picking a "single id when only one matches" fallback.
        assert ids[0] == canonical.id

    def test_does_not_cross_orgs_even_if_email_matches(self, db):
        """The load-bearing isolation invariant — generic shared
        inboxes (info@…) MUST never leak Customer ids from a
        sibling tenant into a portal session."""

        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org_a,
            email="info@shared.example.com",
            created_by=actor,
            updated_by=actor,
        )
        Customer.objects.create(
            organization=org_b,
            email="info@shared.example.com",
            created_by=actor,
            updated_by=actor,
        )
        account = self._account_with_email(
            "info@shared.example.com", canonical,
        )

        ids = customer_ids_for_account(account)
        assert ids == [canonical.id]

    def test_case_insensitive_email_match(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="MixedCase@Example.com",
            created_by=actor,
            updated_by=actor,
        )
        sibling = Customer.objects.create(
            organization=org,
            email="mixedcase@example.com",
            created_by=actor,
            updated_by=actor,
        )
        account = self._account_with_email("mixedcase@example.com", canonical)

        ids = set(customer_ids_for_account(account))
        assert sibling.id in ids

    def test_blank_account_email_returns_canonical_only(self, db):
        """Account without an email (defensive guard) shouldn't try
        the sibling lookup at all."""

        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="any@example.com",
            created_by=actor,
            updated_by=actor,
        )
        # Bypass the create_account guard — manually mint an account
        # then strip the email so the helper sees the blank case.
        account = self._account_with_email("any@example.com", canonical)
        ClientAccount.objects.filter(pk=account.pk).update(email="")
        account.refresh_from_db()

        ids = customer_ids_for_account(account)
        assert ids == [canonical.id]


# ---------------------------------------------------------------------------
# Portal endpoint surface
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestPortalListSeesSiblingRowProposals:
    """Regression for the Barry Clyde case: portal-active customer
    row carries the ClientAccount; older sibling row carries the
    proposal. The list endpoint must surface the proposal."""

    def test_proposal_on_sibling_row_appears_in_list(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="barry@example.com",
            company="TakeAWhey (portal)",
            created_by=actor,
            updated_by=actor,
        )
        sibling = Customer.objects.create(
            organization=org,
            email="barry@example.com",
            company="TakeAWhey (old)",
            created_by=actor,
            updated_by=actor,
        )
        # Proposal attaches to the OLDER sibling row.
        proposal = ProposalFactory(
            organization=org,
            customer=sibling,
        )
        # ClientAccount points at the canonical row.
        ClientAccount.objects.create_account(
            email="barry@example.com",
            customer=canonical,
            password="ssss-12345-tttt",
        )
        ClientAccount.objects.filter(email="barry@example.com").update(
            activated_at="2026-01-01T00:00:00Z",
        )

        client = APIClient()
        r = client.post(
            "/api/portal/auth/login/",
            {"email": "barry@example.com", "password": "ssss-12345-tttt"},
            format="json",
        )
        assert r.status_code == 200, r.content

        r = client.get("/api/portal/proposals/")
        assert r.status_code == 200, r.content
        ids = {row["id"] for row in r.json()["results"]}
        assert str(proposal.id) in ids

    def test_proposal_in_other_org_does_not_leak(self, db):
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org_a,
            email="shared@example.com",
            created_by=actor,
            updated_by=actor,
        )
        other_org_customer = Customer.objects.create(
            organization=org_b,
            email="shared@example.com",
            created_by=actor,
            updated_by=actor,
        )
        proposal_other = ProposalFactory(
            organization=org_b,
            customer=other_org_customer,
        )
        ClientAccount.objects.create_account(
            email="shared@example.com",
            customer=canonical,
            password="ssss-12345-tttt",
        )
        ClientAccount.objects.filter(email="shared@example.com").update(
            activated_at="2026-01-01T00:00:00Z",
        )

        client = APIClient()
        r = client.post(
            "/api/portal/auth/login/",
            {"email": "shared@example.com", "password": "ssss-12345-tttt"},
            format="json",
        )
        assert r.status_code == 200, r.content

        r = client.get("/api/portal/proposals/")
        assert r.status_code == 200, r.content
        ids = {row["id"] for row in r.json()["results"]}
        assert str(proposal_other.id) not in ids


# ---------------------------------------------------------------------------
# merge_customers + pick_merge_canonical + auto_merge_email_duplicates
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestMergeCustomers:
    def test_merge_moves_proposals_and_writes_audit(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="m@example.com",
            company="Canonical",
            created_by=actor,
            updated_by=actor,
        )
        dup = Customer.objects.create(
            organization=org,
            email="m@example.com",
            company="Old Duplicate",
            created_by=actor,
            updated_by=actor,
        )
        proposal = ProposalFactory(organization=org, customer=dup)

        merge_customers(
            canonical=canonical, duplicate=dup, actor=actor, reason="test",
        )

        proposal.refresh_from_db()
        assert proposal.customer_id == canonical.id
        assert not Customer.objects.filter(pk=dup.pk).exists()
        assert AuditLog.objects.filter(action="customer.merged").exists()

    def test_merge_refuses_cross_org(self, db):
        actor = UserFactory()
        a = Customer.objects.create(
            organization=OrganizationFactory(),
            email="x@example.com",
            created_by=actor,
            updated_by=actor,
        )
        b = Customer.objects.create(
            organization=OrganizationFactory(),
            email="x@example.com",
            created_by=actor,
            updated_by=actor,
        )
        with pytest.raises(CustomerMergeError):
            merge_customers(
                canonical=a, duplicate=b, actor=actor, reason="bad",
            )

    def test_merge_refuses_same_row(self, db):
        actor = UserFactory()
        c = Customer.objects.create(
            organization=OrganizationFactory(),
            email="x@example.com",
            created_by=actor,
            updated_by=actor,
        )
        with pytest.raises(CustomerMergeError):
            merge_customers(
                canonical=c, duplicate=c, actor=actor, reason="bad",
            )

    def test_merge_absorbs_dynamics_anchor_only_on_duplicate(self, db):
        """Regression for the prod constraint clash: canonical row
        has no Dataverse anchor, duplicate carries one. The merger
        must move the anchor to the canonical WITHOUT both rows
        briefly sharing the value (would trip
        ``customers_unique_dynamics_account_per_org``).
        """

        import uuid

        org = OrganizationFactory()
        actor = UserFactory()
        anchor = uuid.uuid4()

        canonical = Customer.objects.create(
            organization=org,
            email="anchor@example.com",
            company="Portal active, no anchor",
            created_by=actor,
            updated_by=actor,
        )
        dup = Customer.objects.create(
            organization=org,
            email="anchor@example.com",
            company="Has Dataverse anchor",
            dynamics_account_id=anchor,
            created_by=actor,
            updated_by=actor,
        )

        merge_customers(
            canonical=canonical, duplicate=dup, actor=actor, reason="t",
        )

        canonical.refresh_from_db()
        assert canonical.dynamics_account_id == anchor
        assert not Customer.objects.filter(pk=dup.pk).exists()

    def test_merge_archives_duplicate_email_as_alias(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        canonical = Customer.objects.create(
            organization=org,
            email="canon@example.com",
            created_by=actor,
            updated_by=actor,
        )
        dup = Customer.objects.create(
            organization=org,
            email="DupOnly@example.com",
            created_by=actor,
            updated_by=actor,
        )
        merge_customers(
            canonical=canonical, duplicate=dup, actor=actor, reason="t",
        )
        aliases = CustomerEmailAlias.objects.filter(
            customer=canonical
        ).values_list("email", flat=True)
        assert "duponly@example.com" in {a.lower() for a in aliases}


@pytest.mark.django_db
class TestPickMergeCanonical:
    def test_activated_portal_row_wins(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        portal_row = Customer.objects.create(
            organization=org, email="x@example.com",
            created_by=actor, updated_by=actor,
        )
        older = Customer.objects.create(
            organization=org, email="x@example.com",
            created_by=actor, updated_by=actor,
        )
        ClientAccount.objects.create_account(
            email="x@example.com", customer=portal_row,
            password="ssss-12345-tttt",
        )
        ClientAccount.objects.filter(email="x@example.com").update(
            activated_at="2026-01-01T00:00:00Z",
        )
        canonical, dupes = pick_merge_canonical([older, portal_row])
        assert canonical.pk == portal_row.pk
        assert [d.pk for d in dupes] == [older.pk]


@pytest.mark.django_db
class TestAutoMergeEmailDuplicates:
    def test_collapses_two_rows_into_one(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        a = Customer.objects.create(
            organization=org,
            email="auto@example.com",
            company="A",
            created_by=actor,
            updated_by=actor,
        )
        b = Customer.objects.create(
            organization=org,
            email="auto@example.com",
            company="B",
            created_by=actor,
            updated_by=actor,
        )
        ProposalFactory(organization=org, customer=b)

        summary = auto_merge_email_duplicates(
            organization=org,
            email="auto@example.com",
            actor=actor,
            reason="t",
        )
        assert summary is not None
        assert summary["merged_count"] == 1
        # Exactly one row survives.
        survivors = Customer.objects.filter(
            organization=org, email__iexact="auto@example.com",
        )
        assert survivors.count() == 1

    def test_returns_none_when_only_one_row(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        Customer.objects.create(
            organization=org,
            email="solo@example.com",
            created_by=actor,
            updated_by=actor,
        )
        assert auto_merge_email_duplicates(
            organization=org,
            email="solo@example.com",
            actor=actor,
            reason="t",
        ) is None

    def test_blank_email_returns_none(self, db):
        org = OrganizationFactory()
        actor = UserFactory()
        assert auto_merge_email_duplicates(
            organization=org, email="", actor=actor, reason="t",
        ) is None
