"""Tests for the CRM-style pipeline board.

Covers four load-bearing behaviours:

* Ownership rule — a sales rep with ``proposals.view`` (but
  without ``view_all``) only sees proposals where
  ``sales_person=request.user``; other reps' proposals are
  invisible.
* Capability gate — ``scope=all`` without ``view_all`` returns 403.
* Bundled board shape — every status from
  :class:`ProposalStatus` appears as a column, ordered by funnel
  position, each capped at the column limit.
* Cursor pagination — when a column has more than ``column_limit``
  rows the bundled board returns a ``next_cursor`` and the
  per-column endpoint advances it strictly older without
  duplicates.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.tests.factories import MembershipFactory
from apps.organizations.modules import (
    PROPOSALS_MODULE,
    ProposalsCapability,
)
from apps.proposals.models import ProposalStatus
from apps.proposals.tests.factories import ProposalFactory


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _board_url(org_id: str) -> str:
    return reverse(
        "proposals:proposal-pipeline-board",
        kwargs={"org_id": org_id},
    )


def _column_url(org_id: str, column_status: str) -> str:
    return reverse(
        "proposals:proposal-pipeline-column",
        kwargs={"org_id": org_id, "column_status": column_status},
    )


def _grant(membership, *caps: str) -> None:
    """Append capabilities to an existing membership's flat
    ``proposals`` grant. Convenience over rebuilding the dict in
    each test."""

    permissions = dict(membership.permissions or {})
    existing = set(permissions.get(PROPOSALS_MODULE) or [])
    existing.update(caps)
    permissions[PROPOSALS_MODULE] = sorted(existing)
    membership.permissions = permissions
    membership.save(update_fields=["permissions"])


# ---------------------------------------------------------------------------
# Ownership rule (scope=mine)
# ---------------------------------------------------------------------------


class TestOwnershipFilter:
    def test_rep_only_sees_own_proposals(self, api_client: APIClient) -> None:
        owner_user = UserFactory()
        rep_a = UserFactory()
        rep_b = UserFactory()

        # Build the org via the owner so the membership grid
        # mirrors what create_organization produces in production.
        owner_membership = MembershipFactory(
            user=owner_user, is_owner=True,
        )
        org = owner_membership.organization

        rep_a_membership = MembershipFactory(
            user=rep_a, organization=org,
        )
        _grant(rep_a_membership, ProposalsCapability.VIEW)
        MembershipFactory(user=rep_b, organization=org)

        # Rep A owns one DRAFT, Rep B owns one DRAFT.
        ProposalFactory(
            organization=org,
            sales_person=rep_a,
            status=ProposalStatus.DRAFT.value,
        )
        ProposalFactory(
            organization=org,
            sales_person=rep_b,
            status=ProposalStatus.DRAFT.value,
        )

        _login(api_client, rep_a)
        resp = api_client.get(_board_url(org.id))
        assert resp.status_code == http_status.HTTP_200_OK
        body = resp.json()
        # Each rep sees exactly their own DRAFT; Rep B's is hidden.
        draft_col = next(c for c in body["columns"] if c["status"] == "draft")
        assert draft_col["total"] == 1
        assert len(draft_col["cards"]) == 1
        assert draft_col["cards"][0]["sales_person_id"] == str(rep_a.id)

    def test_unassigned_proposal_hidden_from_rep(
        self, api_client: APIClient,
    ) -> None:
        rep = UserFactory()
        membership = MembershipFactory(user=rep, is_owner=False)
        _grant(membership, ProposalsCapability.VIEW)
        org = membership.organization

        # Sales-person is NULL — would appear in the "All" view,
        # MUST NOT appear in the "Mine" view.
        ProposalFactory(
            organization=org,
            sales_person=None,
            status=ProposalStatus.DRAFT.value,
        )

        _login(api_client, rep)
        resp = api_client.get(_board_url(org.id))
        assert resp.status_code == http_status.HTTP_200_OK
        body = resp.json()
        draft_col = next(c for c in body["columns"] if c["status"] == "draft")
        assert draft_col["total"] == 0
        assert draft_col["cards"] == []


# ---------------------------------------------------------------------------
# Capability gate (scope=all)
# ---------------------------------------------------------------------------


class TestScopeAllCapability:
    def test_scope_all_without_view_all_returns_403(
        self, api_client: APIClient,
    ) -> None:
        rep = UserFactory()
        membership = MembershipFactory(user=rep)
        _grant(membership, ProposalsCapability.VIEW)
        org = membership.organization

        _login(api_client, rep)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_403_FORBIDDEN

    def test_scope_all_with_view_all_sees_everyone(
        self, api_client: APIClient,
    ) -> None:
        lead = UserFactory()
        rep_a = UserFactory()
        rep_b = UserFactory()
        membership = MembershipFactory(user=lead)
        _grant(membership, ProposalsCapability.VIEW, ProposalsCapability.VIEW_ALL)
        org = membership.organization

        ProposalFactory(
            organization=org,
            sales_person=rep_a,
            status=ProposalStatus.DRAFT.value,
        )
        ProposalFactory(
            organization=org,
            sales_person=rep_b,
            status=ProposalStatus.DRAFT.value,
        )

        _login(api_client, lead)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_200_OK
        draft_col = next(
            c for c in resp.json()["columns"] if c["status"] == "draft"
        )
        assert draft_col["total"] == 2

    def test_can_view_all_flag_reflects_membership(
        self, api_client: APIClient,
    ) -> None:
        owner_user = UserFactory()
        owner_membership = MembershipFactory(
            user=owner_user, is_owner=True,
        )
        org = owner_membership.organization

        rep = UserFactory()
        rep_membership = MembershipFactory(user=rep, organization=org)
        _grant(rep_membership, ProposalsCapability.VIEW)

        # Rep: scope_capabilities.can_view_all is False.
        _login(api_client, rep)
        resp = api_client.get(_board_url(org.id))
        assert resp.status_code == http_status.HTTP_200_OK
        assert resp.json()["scope_capabilities"]["can_view_all"] is False

        api_client.logout()

        # Owner bypasses capability checks → True.
        _login(api_client, owner_user)
        resp = api_client.get(_board_url(org.id))
        assert resp.status_code == http_status.HTTP_200_OK
        assert resp.json()["scope_capabilities"]["can_view_all"] is True


# ---------------------------------------------------------------------------
# Bundled board shape
# ---------------------------------------------------------------------------


class TestBoardShape:
    def test_every_status_emits_a_column_in_funnel_order(
        self, api_client: APIClient,
    ) -> None:
        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_200_OK
        body = resp.json()
        statuses = [c["status"] for c in body["columns"]]
        # Funnel order must match the enum declaration so the FE can
        # render left-to-right without re-sorting.
        assert statuses == list(ProposalStatus.values)
        # Every column has the FE-renderable shape even when empty.
        for column in body["columns"]:
            assert "label" in column
            assert column["total"] == 0
            assert column["cards"] == []
            assert column["next_cursor"] is None


# ---------------------------------------------------------------------------
# Cursor pagination
# ---------------------------------------------------------------------------


class TestCursorPagination:
    def test_load_more_advances_cursor_without_duplicates(
        self, api_client: APIClient,
    ) -> None:
        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        # Build 30 DRAFT proposals — more than the default 25-row
        # column limit so the bundled board emits a cursor.
        created = [
            ProposalFactory(
                organization=org,
                sales_person=user,
                status=ProposalStatus.DRAFT.value,
            )
            for _ in range(30)
        ]
        all_ids = {str(p.id) for p in created}

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_200_OK
        body = resp.json()
        draft_col = next(c for c in body["columns"] if c["status"] == "draft")
        assert draft_col["total"] == 30
        assert len(draft_col["cards"]) == 25
        assert draft_col["next_cursor"] is not None

        page1_ids = {c["id"] for c in draft_col["cards"]}

        resp2 = api_client.get(
            _column_url(org.id, "draft"),
            {"scope": "all", "cursor": draft_col["next_cursor"]},
        )
        assert resp2.status_code == http_status.HTTP_200_OK
        page2 = resp2.json()
        assert page2["total"] == 30
        assert len(page2["cards"]) == 5
        # No overlap between page 1 and page 2.
        page2_ids = {c["id"] for c in page2["cards"]}
        assert not (page1_ids & page2_ids)
        # Together they recover the full set.
        assert (page1_ids | page2_ids) == all_ids
        # Final page exhausts the cursor.
        assert page2["next_cursor"] is None

    def test_invalid_status_in_column_url_returns_400(
        self, api_client: APIClient,
    ) -> None:
        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization
        _login(api_client, user)
        resp = api_client.get(_column_url(org.id, "bogus"))
        assert resp.status_code == http_status.HTTP_400_BAD_REQUEST


# ---------------------------------------------------------------------------
# Column totals (sum of deal values)
# ---------------------------------------------------------------------------


class TestColumnTotals:
    def test_total_value_sums_unit_price_quantity_freight(
        self, api_client: APIClient,
    ) -> None:
        from decimal import Decimal

        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        # Two DRAFT proposals: 10 × £25.50 + £5 freight = £260
        # and 4 × £100 + (no freight) = £400. Total = £660.
        ProposalFactory(
            organization=org,
            sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=10,
            unit_price=Decimal("25.50"),
            freight_amount=Decimal("5.00"),
        )
        ProposalFactory(
            organization=org,
            sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=4,
            unit_price=Decimal("100.00"),
            freight_amount=None,
        )
        # One unpriced proposal — contributes 0 to the sum, but
        # still counts toward ``total``.
        ProposalFactory(
            organization=org,
            sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=2,
            unit_price=None,
            freight_amount=None,
        )

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_200_OK
        draft_col = next(
            c for c in resp.json()["columns"] if c["status"] == "draft"
        )
        assert draft_col["total"] == 3
        # Decimal arrives as a string — keep it that way on the wire
        # so JSON precision is preserved.
        assert Decimal(draft_col["total_value"]) == Decimal("660.00")
        assert draft_col["currency"] == "GBP"
        assert draft_col["mixed_currency"] is False

    def test_mixed_currency_flag(self, api_client: APIClient) -> None:
        from decimal import Decimal

        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        ProposalFactory(
            organization=org, sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="GBP", quantity=1, unit_price=Decimal("100"),
        )
        ProposalFactory(
            organization=org, sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="USD", quantity=1, unit_price=Decimal("50"),
        )

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        draft_col = next(
            c for c in resp.json()["columns"] if c["status"] == "draft"
        )
        assert draft_col["mixed_currency"] is True
        # Dominant currency falls back to alphabetical tiebreak when
        # counts are tied, but the value is one of the column's
        # actual currencies.
        assert draft_col["currency"] in {"GBP", "USD"}

    def test_line_based_proposal_uses_lines_not_header_unit_price(
        self, api_client: APIClient,
    ) -> None:
        """Regression: a line-based proposal (multi-product envelope)
        stores its real total in the ``lines`` rows, not the header-
        level ``unit_price`` / ``quantity``. The first pipeline build
        ignored lines and reported £0 for a £559k deal.
        """
        from decimal import Decimal

        from apps.proposals.models import ProposalLine

        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        # Header-level unit_price is None — the proposal carries its
        # value via lines, the normal shape for multi-product quotes.
        proposal = ProposalFactory(
            organization=org,
            sales_person=user,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=1,
            unit_price=None,
            freight_amount=Decimal("100.00"),
        )
        ProposalLine.objects.create(
            proposal=proposal,
            quantity=8000,
            unit_price=Decimal("69.95"),
            display_order=1,
        )
        ProposalLine.objects.create(
            proposal=proposal,
            quantity=10,
            unit_price=Decimal("15.00"),
            display_order=2,
        )
        # Expected total: 8000 × 69.95 + 10 × 15.00 + 100 freight
        # = 559600 + 150 + 100 = 559850.
        expected_total = Decimal("559850.00")

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        assert resp.status_code == http_status.HTTP_200_OK
        draft_col = next(
            c for c in resp.json()["columns"] if c["status"] == "draft"
        )
        assert draft_col["total"] == 1
        assert Decimal(draft_col["total_value"]) == expected_total
        assert len(draft_col["cards"]) == 1
        card = draft_col["cards"][0]
        assert Decimal(card["deal_total"]) == expected_total

    def test_empty_column_emits_null_total_value(
        self, api_client: APIClient,
    ) -> None:
        user = UserFactory()
        membership = MembershipFactory(user=user, is_owner=True)
        org = membership.organization

        _login(api_client, user)
        resp = api_client.get(_board_url(org.id), {"scope": "all"})
        draft_col = next(
            c for c in resp.json()["columns"] if c["status"] == "draft"
        )
        assert draft_col["total"] == 0
        assert draft_col["total_value"] is None
        assert draft_col["currency"] == ""
        assert draft_col["mixed_currency"] is False
