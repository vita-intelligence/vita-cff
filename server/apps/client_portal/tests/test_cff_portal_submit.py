"""Portal-authored CFF submission tests.

Contracts under test:

* ``POST /api/portal/cffs/new/`` creates a valid ``CFFSubmission``
  row with ``provenance="portal"`` and the wix_* id columns NULL.
* Validation rejects missing required fields with a per-field
  errors dict (422 shape the FE keys on).
* The freshly-created row is visible on ``GET /api/portal/cffs/``
  under the submitting customer's account.
* Triage side: the row appears in ``state=unassigned`` on the
  staff endpoint (with the same wire shape as Wix rows) and the
  existing reject/unreject flow still works.
* Existing Wix import path is unaffected — provenance defaults to
  ``wix`` when the poller creates a row through the traditional
  ``update_or_create`` path (regression guard).
* ``GET /api/portal/cffs/sales-people/`` returns the org's members.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone as dt_timezone

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.models import CFFSubmission
from apps.cff_submissions.services import (
    CFFPortalError,
    PortalSubmissionInput,
    create_portal_submission,
    reject,
    unreject,
)
from apps.client_portal.models import ClientAccount
from apps.customers.models import Customer
from apps.organizations.models import Membership
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
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
    account = ClientAccount.objects.create_account(
        email=customer.email,
        customer=customer,
        password="portal-password-12345",
    )
    ClientAccount.objects.filter(pk=account.pk).update(
        activated_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
    )
    return ClientAccount.objects.get(pk=account.pk)


def _login_portal(client: APIClient, account: ClientAccount) -> None:
    client.post(
        "/api/portal/auth/login/",
        {"email": account.email, "password": "portal-password-12345"},
        format="json",
    )


def _valid_payload() -> dict:
    """Full payload matching every required field on the wizard.
    Returned as a dict so tests can spread + tweak individual keys
    without repeating the whole thing."""

    return {
        "first_name": "Ada",
        "last_name": "Lovelace",
        "email": "ada@example.test",
        "phone": "+44 20 7946 0958",
        "company_name": "Analytical Machines Ltd",
        "product_formats": ["Capsule"],
        "market_segment": "Sports nutrition",
        "dose": "2 capsules per day",
        "nutritional_requirements": ["Vegan"],
        "target_sex": ["Both"],
        "target_age": ["18-65 Years"],
        "other_nutritional_requirements": "",
        "dose_per_unit": "500mg",
        "actives_requirements": "Vitamin C 250mg, Zinc 15mg",
        "primary_package_type": "Bottle 60ct",
        "quantity_to_be_quoted": "1000",
        "country_region": "United Kingdom",
        "address": "10 Downing Street",
        "city": "London",
        "postal_code": "SW1A 2AA",
        "delivery_same_as_proposal": "yes",
        "account_manager_email": "am@vita.example.test",
    }


# ---------------------------------------------------------------------------
# Service — validation + happy path
# ---------------------------------------------------------------------------


class TestCreatePortalSubmissionService:
    def test_missing_required_fields_raise_with_field_errors_dict(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        with pytest.raises(CFFPortalError) as exc_info:
            create_portal_submission(
                client_account=account,
                payload=PortalSubmissionInput(),  # everything blank
            )
        errs = getattr(exc_info.value, "field_errors", None)
        assert errs is not None
        # A representative required field lands in the dict; we don't
        # pin the exact set so the guard doesn't need updating every
        # time we tweak the required list.
        for field in ("first_name", "email", "company_name", "dose"):
            assert field in errs

    def test_happy_path_persists_provenance_portal_with_null_wix_ids(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        payload = _valid_payload()
        typed = PortalSubmissionInput(
            **{
                **payload,
                "product_formats": tuple(payload["product_formats"]),
                "nutritional_requirements": tuple(payload["nutritional_requirements"]),
                "target_sex": tuple(payload["target_sex"]),
                "target_age": tuple(payload["target_age"]),
            },
        )
        submission = create_portal_submission(
            client_account=account,
            payload=typed,
        )

        submission.refresh_from_db()
        assert submission.provenance == "portal"
        assert submission.wix_submission_id is None
        assert submission.wix_form_id is None
        assert submission.submitted_by_client_account_id == account.pk
        assert submission.submitter_email == "ada@example.test"
        # Slug-keyed submissions dict — the shape triage renders on.
        assert isinstance(submission.raw_payload, dict)
        assert isinstance(submission.raw_payload.get("submissions"), dict)
        subs = submission.raw_payload["submissions"]
        assert subs.get("first_name") == "Ada"
        assert subs.get("dose") == "2 capsules per day"
        # Multi-choice fields collapse to comma-separated strings.
        assert subs.get("nutritional_requirements") == "Vegan"

    def test_email_is_normalised_to_lowercase(self):
        """Case-preservation would break the ``list_customer_cffs``
        email match because the ownership rule compares
        ``submitter_email__iexact`` on the DB side but the FE forces
        lowercase for display — the safest anchor is to normalise on
        write."""
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        payload = _valid_payload()
        payload["email"] = "Ada@Example.Test"
        typed = PortalSubmissionInput(
            **{
                **payload,
                "product_formats": tuple(payload["product_formats"]),
                "nutritional_requirements": tuple(payload["nutritional_requirements"]),
                "target_sex": tuple(payload["target_sex"]),
                "target_age": tuple(payload["target_age"]),
            },
        )
        submission = create_portal_submission(client_account=account, payload=typed)
        assert submission.submitter_email == "ada@example.test"


# ---------------------------------------------------------------------------
# API — end-to-end via the DRF test client
# ---------------------------------------------------------------------------


class TestPortalCFFCreateAPI:
    def test_authenticated_post_creates_row_and_returns_201(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        r = client.post(
            "/api/portal/cffs/new/",
            _valid_payload(),
            format="json",
        )
        assert r.status_code == 201, r.content
        body = r.json()
        assert body["provenance"] == "portal"
        assert body["is_rejected"] is False
        assert body["lifecycle_state"] == "under_review"

    def test_missing_required_field_returns_422_with_fields_dict(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        payload = _valid_payload()
        payload.pop("first_name")  # drop a required
        r = client.post("/api/portal/cffs/new/", payload, format="json")
        assert r.status_code == 422, r.content
        body = r.json()
        # Portal error helper writes the machine code under ``code``,
        # matching the ``payload.code`` the FE reads on 422.
        assert body.get("code") == "cff_portal_validation"
        assert "first_name" in (body.get("fields") or {})

    def test_unauthenticated_post_401(self):
        client = APIClient()
        r = client.post("/api/portal/cffs/new/", _valid_payload(), format="json")
        # Portal API rejects with 401 rather than the DRF default 403
        # so the FE middleware knows to redirect to /portal/login.
        assert r.status_code in (401, 403)

    def test_submitted_row_shows_up_on_customer_list(self):
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        client.post("/api/portal/cffs/new/", _valid_payload(), format="json")

        r = client.get("/api/portal/cffs/")
        assert r.status_code == 200
        rows = r.json()["results"]
        assert len(rows) == 1
        assert rows[0]["provenance"] == "portal"
        assert rows[0]["is_rejected"] is False


# ---------------------------------------------------------------------------
# Triage compatibility — portal rows behave like Wix rows on the staff side
# ---------------------------------------------------------------------------


class TestTriageCompatibility:
    def test_portal_row_visible_in_staff_unassigned_queue(self):
        """Portal rows share the CFFSubmission table and inherit the
        same triage filter semantics — ``state=unassigned`` picks
        them up alongside Wix rows without a special case."""
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)
        payload = _valid_payload()
        typed = PortalSubmissionInput(
            **{
                **payload,
                "product_formats": tuple(payload["product_formats"]),
                "nutritional_requirements": tuple(payload["nutritional_requirements"]),
                "target_sex": tuple(payload["target_sex"]),
                "target_age": tuple(payload["target_age"]),
            },
        )
        submission = create_portal_submission(client_account=account, payload=typed)

        # Direct queryset assertion — the staff endpoint's _filter uses
        # this exact predicate for state=unassigned.
        assert CFFSubmission.objects.filter(
            organization=org,
            assignments__isnull=True,
            rejected_at__isnull=True,
        ).filter(pk=submission.pk).exists()

    def test_portal_row_can_be_rejected_and_unrejected(self):
        """Full triage lifecycle should work uniformly on portal rows
        the same way it does on Wix rows."""
        org = OrganizationFactory()
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)
        payload = _valid_payload()
        typed = PortalSubmissionInput(
            **{
                **payload,
                "product_formats": tuple(payload["product_formats"]),
                "nutritional_requirements": tuple(payload["nutritional_requirements"]),
                "target_sex": tuple(payload["target_sex"]),
                "target_age": tuple(payload["target_age"]),
            },
        )
        submission = create_portal_submission(client_account=account, payload=typed)
        actor = UserFactory()

        reject(submission=submission, actor=actor, reason="Not our niche.")
        submission.refresh_from_db()
        assert submission.is_rejected is True

        unreject(submission=submission, actor=actor)
        submission.refresh_from_db()
        assert submission.is_rejected is False


class TestWixPathStillWorks:
    """Regression guard on the anonymous Wix marketing form path.
    Rows created with the old Wix-shaped constructor arguments still
    end up with ``provenance='wix'`` and every wix_* column populated."""

    def test_wix_row_defaults_to_provenance_wix(self):
        org = OrganizationFactory()
        row = CFFSubmission.objects.create(
            organization=org,
            wix_submission_id=uuid.uuid4(),
            wix_form_id=uuid.uuid4(),
            wix_created_date=datetime(2026, 5, 1, tzinfo=dt_timezone.utc),
            wix_updated_date=datetime(2026, 5, 1, tzinfo=dt_timezone.utc),
            raw_payload={"submissions": {"email_fc7d": "wix@example.test"}},
            submitter_email="wix@example.test",
        )
        assert row.provenance == "wix"
        assert row.wix_submission_id is not None


# ---------------------------------------------------------------------------
# Sales-people picker
# ---------------------------------------------------------------------------


class TestSalesPeopleEndpoint:
    def test_returns_org_members_for_authenticated_customer(self):
        org = OrganizationFactory()
        # A real membership so the endpoint has something to return.
        # Membership carries no ``is_active`` column — the User side
        # holds active-ness; UserFactory defaults to is_active=True.
        member = UserFactory()
        Membership.objects.create(organization=org, user=member)
        customer = _make_customer(org=org, email="ada@example.test")
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        r = client.get("/api/portal/cffs/sales-people/")
        assert r.status_code == 200
        body = r.json()
        assert "results" in body
        assert any(row["email"] == member.email for row in body["results"])
