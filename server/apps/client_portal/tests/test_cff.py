"""Customer-portal CFF surface tests.

Three contracts under test:

1. **Ownership union** — :func:`list_customer_cffs` returns the
   right set under each leg of the rule (email match, project
   link, both, neither).
2. **REST endpoints** — list / detail / messages return the
   customer's CFFs only and 404 on a foreign CFF.
3. **Comment visibility flip** — new CFF comments default to
   ``SHARED`` so the customer sees staff replies without staff
   having to flip a per-comment toggle.

The tests build their own ``CFFSubmission`` rows inline so they
don't have to import the Wix-side factories from
:mod:`apps.cff_submissions.tests`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone as dt_timezone

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.models import (
    CFFSubmission,
    CFFSubmissionStatus,
)
from apps.cff_submissions.services import (
    extract_submitter_email,
    get_customer_cff,
    list_customer_cffs,
)
from apps.client_portal.models import ClientAccount
from apps.comments.models import Comment
from apps.comments.services import create_comment
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.tests.factories import ProposalFactory


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


def _make_customer(*, org, email: str, company: str = "Acme Foods Ltd"):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="Customer Contact",
        company=company,
        email=email,
        created_by=actor,
        updated_by=actor,
    )


def _make_client_account(*, customer) -> ClientAccount:
    """Pre-activated portal account bound to ``customer``. The
    activated_at timestamp short-circuits the activation gate so
    the login endpoint accepts the password we set inline."""

    account = ClientAccount.objects.create_account(
        email=customer.email,
        customer=customer,
        password="portal-password-12345",
    )
    ClientAccount.objects.filter(pk=account.pk).update(
        activated_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
    )
    return ClientAccount.objects.get(pk=account.pk)


def _make_cff(
    *,
    org,
    submitter_email: str = "",
    project=None,
    raw_payload=None,
):
    return CFFSubmission.objects.create(
        organization=org,
        wix_submission_id=uuid.uuid4(),
        wix_form_id=uuid.uuid4(),
        wix_namespace="wix.form_app.form",
        wix_status=CFFSubmissionStatus.CONFIRMED,
        wix_created_date=datetime(2026, 5, 1, tzinfo=dt_timezone.utc),
        wix_updated_date=datetime(2026, 5, 1, tzinfo=dt_timezone.utc),
        raw_payload=raw_payload or {
            "submissions": {"email_fc7d": submitter_email or "x@example.com"},
        },
        submitter_email=submitter_email,
        project=project,
    )


def _login_portal(client: APIClient, account: ClientAccount) -> None:
    client.post(
        "/api/portal/auth/login/",
        {"email": account.email, "password": "portal-password-12345"},
        format="json",
    )


# ---------------------------------------------------------------------------
# Email extractor
# ---------------------------------------------------------------------------


class TestExtractSubmitterEmail:
    def test_picks_first_email_slug(self):
        payload = {
            "submissions": {
                "first_name_x": "Jane",
                "email_fc7d": "jane@example.com",
            },
        }
        assert extract_submitter_email(payload) == "jane@example.com"

    def test_skips_account_manager_email_slugs(self):
        # The account-manager slug carries the Vita employee's
        # email, NOT the customer's. The extractor must walk past
        # it to find the customer email.
        payload = {
            "submissions": {
                "vita_manufacture_account_manager_email_a1": "rep@vita.test",
                "email_fc7d": "jane@example.com",
            },
        }
        assert extract_submitter_email(payload) == "jane@example.com"

    def test_missing_returns_empty(self):
        assert extract_submitter_email({"submissions": {}}) == ""
        assert extract_submitter_email({}) == ""
        assert extract_submitter_email(None) == ""  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Ownership union
# ---------------------------------------------------------------------------


class TestOwnershipRule:
    def test_email_match_finds_unassigned_cff(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@acme.example.com")
        account = _make_client_account(customer=customer)
        # Email matches → owned, even though there's no project
        # link.
        owned = _make_cff(org=org, submitter_email="jane@acme.example.com")
        # Someone else's CFF in the same org — not owned.
        _make_cff(org=org, submitter_email="someone@else.example.com")

        rows = list(list_customer_cffs(client_account=account))
        assert [r.id for r in rows] == [owned.id]

    def test_email_match_is_case_insensitive(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="JANE@acme.example.com")
        account = _make_client_account(customer=customer)
        owned = _make_cff(org=org, submitter_email="jane@ACME.example.com")

        rows = list(list_customer_cffs(client_account=account))
        assert [r.id for r in rows] == [owned.id]

    def test_project_link_finds_cff_with_different_email(self):
        # Customer has a proposal on a project. A CFF was assigned
        # to that project but the submitter typed a different email
        # originally (typo / work vs personal). The project-link
        # leg of the union must still surface the CFF.
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@acme.example.com")
        account = _make_client_account(customer=customer)
        proposal = ProposalFactory(organization=org, customer=customer)
        # ``proposal.formulation_version.formulation`` is the
        # "project" the CFF can be assigned to.
        project = proposal.formulation_version.formulation
        owned = _make_cff(
            org=org,
            submitter_email="janed@work.example.com",
            project=project,
        )

        rows = list(list_customer_cffs(client_account=account))
        assert [r.id for r in rows] == [owned.id]

    def test_neither_match_returns_empty(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@acme.example.com")
        account = _make_client_account(customer=customer)
        # Different email + unassigned → neither path matches.
        _make_cff(org=org, submitter_email="someone@else.example.com")

        rows = list(list_customer_cffs(client_account=account))
        assert rows == []

    def test_other_customers_cff_is_invisible(self):
        # Two customers in the same org. Each gets their own
        # CFF. Neither should see the other's row.
        org = OrganizationFactory()
        customer_a = _make_customer(
            org=org, email="alice@example.com", company="Alice Co",
        )
        customer_b = _make_customer(
            org=org, email="bob@example.com", company="Bob Co",
        )
        account_a = _make_client_account(customer=customer_a)
        account_b = _make_client_account(customer=customer_b)
        cff_a = _make_cff(org=org, submitter_email="alice@example.com")
        cff_b = _make_cff(org=org, submitter_email="bob@example.com")

        a_rows = list(list_customer_cffs(client_account=account_a))
        b_rows = list(list_customer_cffs(client_account=account_b))
        assert [r.id for r in a_rows] == [cff_a.id]
        assert [r.id for r in b_rows] == [cff_b.id]

    def test_get_customer_cff_404_path(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        owned = _make_cff(org=org, submitter_email="jane@example.com")
        foreign = _make_cff(org=org, submitter_email="other@example.com")

        assert get_customer_cff(
            client_account=account, submission_id=owned.id,
        ) is not None
        # Foreign CFF — same org, different customer → ownership
        # union returns nothing → helper returns ``None`` so the
        # view can map to a single 404.
        assert get_customer_cff(
            client_account=account, submission_id=foreign.id,
        ) is None


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


class TestCFFListEndpoint:
    def test_returns_only_customers_cffs(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        owned = _make_cff(org=org, submitter_email="jane@example.com")
        _make_cff(org=org, submitter_email="other@example.com")

        client = APIClient()
        _login_portal(client, account)
        r = client.get("/api/portal/cffs/")
        assert r.status_code == 200, r.content
        ids = [row["id"] for row in r.json()["results"]]
        assert ids == [str(owned.id)]


class TestCFFDetailEndpoint:
    def test_owned_returns_200_with_raw_payload(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        cff = _make_cff(
            org=org,
            submitter_email="jane@example.com",
            raw_payload={
                "submissions": {
                    "email_fc7d": "jane@example.com",
                    "market_segment_x1": "Sports performance",
                },
            },
        )

        client = APIClient()
        _login_portal(client, account)
        r = client.get(f"/api/portal/cffs/{cff.id}/")
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == str(cff.id)
        # Full raw_payload exposed so the customer can re-read
        # their own submission.
        assert "raw_payload" in body
        assert body["raw_payload"]["submissions"]["market_segment_x1"] == (
            "Sports performance"
        )

    def test_foreign_returns_404(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        foreign = _make_cff(org=org, submitter_email="other@example.com")

        client = APIClient()
        _login_portal(client, account)
        r = client.get(f"/api/portal/cffs/{foreign.id}/")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Comment visibility flip
# ---------------------------------------------------------------------------


class TestCFFCommentVisibility:
    def test_staff_comment_defaults_to_shared(self):
        # The flip moved ``cff_submission`` into the
        # ``CLIENT_VISIBLE_BY_DEFAULT`` set, so a staff comment
        # created on a CFF without an explicit visibility argument
        # should land as ``shared`` — visible to the customer
        # without anyone having to flip a per-comment toggle.
        org = OrganizationFactory()
        actor = org.created_by
        cff = _make_cff(org=org, submitter_email="anyone@example.com")

        comment = create_comment(
            organization=org,
            actor=actor,
            target=cff,
            body="Thanks for the submission — assigning to a project now.",
        )
        assert comment.visibility == Comment.Visibility.SHARED


class TestPortalCFFMessages:
    def test_customer_can_post_comment(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        cff = _make_cff(org=org, submitter_email="jane@example.com")

        client = APIClient()
        _login_portal(client, account)
        r = client.post(
            f"/api/portal/cffs/{cff.id}/messages/",
            {"body": "Hi team, any update on this?"},
            format="json",
        )
        assert r.status_code == 201, r.content
        # The new comment is visible on the customer's GET.
        list_resp = client.get(f"/api/portal/cffs/{cff.id}/messages/")
        bodies = [m["body"] for m in list_resp.json()["results"]]
        assert "Hi team, any update on this?" in bodies

    def test_customer_sees_staff_shared_comments(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=customer)
        cff = _make_cff(org=org, submitter_email="jane@example.com")

        staff = UserFactory()
        create_comment(
            organization=org,
            actor=staff,
            target=cff,
            body="Replying as Vita team.",
        )

        client = APIClient()
        _login_portal(client, account)
        r = client.get(f"/api/portal/cffs/{cff.id}/messages/")
        assert r.status_code == 200
        bodies = [m["body"] for m in r.json()["results"]]
        assert "Replying as Vita team." in bodies

    def test_customer_cannot_post_to_foreign_cff(self):
        # Cross-customer attempt should return 404 (not 403) so
        # nothing about the existence of the foreign row leaks.
        org = OrganizationFactory()
        _own_customer = _make_customer(org=org, email="jane@example.com")
        account = _make_client_account(customer=_own_customer)
        foreign = _make_cff(org=org, submitter_email="other@example.com")

        client = APIClient()
        _login_portal(client, account)
        r = client.post(
            f"/api/portal/cffs/{foreign.id}/messages/",
            {"body": "should not land"},
            format="json",
        )
        assert r.status_code == 404
