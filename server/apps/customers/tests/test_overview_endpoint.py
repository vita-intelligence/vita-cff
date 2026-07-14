"""Tests for the customer-overview aggregator endpoint.

Pins the "one round-trip, everything the staff detail page renders"
contract: customer row + portal accounts + proposal history + CFF
submissions + pre-computed rollup totals. Two auxiliary contracts
also under test:

* Scope: proposals/CFFs from *other* customers in the same org do
  NOT leak into this customer's overview.
* RBAC: ``formulations.view`` is required; a member without it 403s.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.cff_submissions.models import (
    CFFSubmission,
    CFFSubmissionKind,
    CFFProvenance,
)
from apps.client_portal.models import ClientAccount
from apps.customers.models import Customer
from apps.formulations.models import ProjectType
from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from apps.proposals.models import Proposal, ProposalStatus


pytestmark = pytest.mark.django_db


def _login(client: APIClient, user) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _url(org_id, customer_id) -> str:
    return reverse(
        "customers:customer-overview",
        kwargs={"org_id": str(org_id), "customer_id": str(customer_id)},
    )


def _customer(*, org, actor, name="Alpha", company="Alpha Co") -> Customer:
    return Customer.objects.create(
        organization=org,
        name=name,
        company=company,
        email=f"{name.lower()}@buyer.test",
        created_by=actor,
        updated_by=actor,
    )


def _proposal(
    *,
    org,
    actor,
    customer,
    status_value=ProposalStatus.DRAFT.value,
    quantity=100,
    unit_price=Decimal("7.00"),
    project_type=ProjectType.CUSTOM,
) -> Proposal:
    formulation = FormulationFactory(
        organization=org, project_type=project_type
    )
    version = save_version(formulation=formulation, actor=actor)
    return Proposal.objects.create(
        organization=org,
        formulation_version=version,
        customer=customer,
        code=f"PROP-{customer.id.hex[:4]}-{status_value}",
        template_type=(
            "ready_to_go"
            if project_type == ProjectType.READY_TO_GO
            else "custom"
        ),
        status=status_value,
        currency="GBP",
        quantity=quantity,
        unit_price=unit_price,
        created_by=actor,
        updated_by=actor,
    )


def _cff(*, org, customer, kind=CFFSubmissionKind.CUSTOM) -> CFFSubmission:
    account = ClientAccount.objects.create(
        customer=customer,
        email=f"portal-{customer.id.hex[:6]}@buyer.test",
    )
    return CFFSubmission.objects.create(
        organization=org,
        provenance=CFFProvenance.PORTAL,
        submitted_by_client_account=account,
        submission_kind=kind,
        raw_payload={"submissions": {"email": account.email}},
    )


class TestCustomerOverviewEndpoint:
    def test_returns_customer_and_totals(self):
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Overview Co")
        customer = _customer(org=org, actor=user)
        _proposal(
            org=org,
            actor=user,
            customer=customer,
            status_value=ProposalStatus.ACCEPTED.value,
            quantity=100,
            unit_price=Decimal("10.00"),
        )
        _proposal(
            org=org,
            actor=user,
            customer=customer,
            status_value=ProposalStatus.DRAFT.value,
            quantity=50,
            unit_price=Decimal("5.00"),
        )

        client = _login(APIClient(), user)
        r = client.get(_url(org.id, customer.id))
        assert r.status_code == status.HTTP_200_OK
        body = r.json()

        assert body["customer"]["id"] == str(customer.id)
        assert body["totals"]["proposals_count"] == 2
        assert body["totals"]["accepted_proposals_count"] == 1
        # Accepted revenue = 100 * 10.00 = 1000.00
        assert Decimal(body["totals"]["accepted_revenue"]) == Decimal(
            "1000.00"
        )
        # Two proposals returned, newest first.
        assert len(body["proposals"]) == 2

    def test_only_this_customer_data_returned(self):
        """A sibling customer in the same org must not leak into
        this customer's overview. Regression guard against dropping
        the ``customer=customer`` filter on the queryset."""

        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Scoped Co")
        customer_a = _customer(org=org, actor=user, name="A", company="A Co")
        customer_b = _customer(org=org, actor=user, name="B", company="B Co")
        _proposal(
            org=org,
            actor=user,
            customer=customer_a,
            status_value=ProposalStatus.DRAFT.value,
        )
        _proposal(
            org=org,
            actor=user,
            customer=customer_b,
            status_value=ProposalStatus.DRAFT.value,
        )
        _cff(org=org, customer=customer_a)
        _cff(org=org, customer=customer_b)

        client = _login(APIClient(), user)
        r = client.get(_url(org.id, customer_a.id))
        assert r.status_code == status.HTTP_200_OK
        body = r.json()
        # Only customer_a's own rows come back.
        assert body["totals"]["proposals_count"] == 1
        assert body["totals"]["cff_submissions_count"] == 1
        # And the returned proposal points at customer_a's ID.
        assert (
            body["proposals"][0]["formulation"]["name"]
            == FormulationFactory._meta.model.objects.filter(
                organization=org
            )
            .order_by("created_at")
            .first()
            .name
        )

    def test_cross_org_customer_is_404(self):
        """Even with a valid session in one org, hitting the overview
        for a customer that lives in a *different* org must not leak
        existence — the endpoint 404s (same rule as the detail
        endpoint the page fetches alongside)."""

        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        _my_org = create_organization(user=user, name="Mine")
        other_org = OrganizationFactory()
        other_customer = _customer(
            org=other_org, actor=other_org.created_by, name="Stranger"
        )

        client = _login(APIClient(), user)
        r = client.get(_url(_my_org.id, other_customer.id))
        # 404, not 403 — a "wrong org" lookup must never signal
        # existence.
        assert r.status_code == status.HTTP_404_NOT_FOUND

    def test_missing_view_capability_is_forbidden(self):
        """A member without ``formulations.view`` (the module the
        customers surface piggy-backs on) must be blocked. Portal-
        only users, finance-only users, etc., don't see this page."""

        owner = UserFactory(email="owner@perm.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Perm Co")
        customer = _customer(org=org, actor=owner)

        no_perm = UserFactory(
            email="noperm@perm.test", password=DEFAULT_TEST_PASSWORD
        )
        MembershipFactory(
            user=no_perm, organization=org, permissions={},
        )

        client = _login(APIClient(), no_perm)
        r = client.get(_url(org.id, customer.id))
        assert r.status_code == status.HTTP_403_FORBIDDEN

    def test_portal_accounts_included(self):
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="Portal Co")
        customer = _customer(org=org, actor=user)
        ClientAccount.objects.create(
            customer=customer, email="portal@buyer.test"
        )

        client = _login(APIClient(), user)
        r = client.get(_url(org.id, customer.id))
        assert r.status_code == status.HTTP_200_OK
        body = r.json()
        assert body["totals"]["portal_accounts_count"] == 1
        assert body["portal_accounts"][0]["email"] == "portal@buyer.test"

    def test_cff_submissions_included(self):
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="CFF Co")
        customer = _customer(org=org, actor=user)
        _cff(org=org, customer=customer, kind=CFFSubmissionKind.READY_TO_GO)

        client = _login(APIClient(), user)
        r = client.get(_url(org.id, customer.id))
        assert r.status_code == status.HTTP_200_OK
        body = r.json()
        assert body["totals"]["cff_submissions_count"] == 1
        assert body["cff_submissions"][0]["submission_kind"] == "ready_to_go"
