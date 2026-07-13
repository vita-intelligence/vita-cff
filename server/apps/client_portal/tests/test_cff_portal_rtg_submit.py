"""Portal Ready-to-Go submission tests.

Contracts under test:

* ``publish_to_rtg_catalog`` enforces the ``project_type='ready_to_go'``
  constraint and the marketing-payload guard (description, base price,
  MOQ >= 1, at least one packaging option).
* ``create_portal_rtg_submission`` writes a ``CFFSubmission`` +
  a draft ``Proposal`` in one atomic step, linked via the new
  ``drafted_proposal`` FK. Failure modes surface as
  ``CFFRTGSubmissionError`` with the machine ``code`` the FE keys on.
* ``GET /api/portal/rtg-catalog/`` returns only ``is_rtg_published=True``
  rows scoped to the authenticated customer's org.
* ``POST /api/portal/cffs/new-rtg/`` returns 201 with the standard
  ``PortalCFFDetail`` shape; auth is required.
* Portal dashboard's product list surfaces the pending RTG card with
  ``stage_key='cff_awaiting_proposal'``.
"""

from __future__ import annotations

from datetime import datetime, timezone as dt_timezone
from decimal import Decimal

import pytest
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.models import CFFSubmission, CFFSubmissionKind
from apps.cff_submissions.services import (
    CFFRTGSubmissionError,
    PortalRTGSubmissionInput,
    create_portal_rtg_submission,
)
from apps.client_portal.models import ClientAccount
from apps.customers.models import Customer
from apps.formulations.models import Formulation, ProjectType
from apps.formulations.services import (
    FormulationRTGError,
    publish_to_rtg_catalog,
    save_version,
    unpublish_from_rtg_catalog,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.models import Membership
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import Proposal, ProposalStatus


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_customer(*, org, email="ada@example.test"):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="Customer Contact",
        company="Analytical Machines Ltd",
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


def _make_rtg_sku(
    *,
    org,
    name="Vitamin C 500mg Capsule",
    base_price=Decimal("6.50"),
    moq=100,
    packaging_options=None,
) -> Formulation:
    """A fully-published RTG SKU with an approved version so the
    submission service has something concrete to quote against."""

    if packaging_options is None:
        packaging_options = ["60ct bottle", "120ct bottle"]
    # Membership so the RTG service can pick a proposal_actor.
    Membership.objects.get_or_create(
        organization=org, user=org.created_by,
    )
    formulation: Formulation = FormulationFactory(
        organization=org,
        project_type=ProjectType.READY_TO_GO,
        name=name,
    )
    # Approved version so the drafted proposal can pin against it.
    version = save_version(formulation=formulation, actor=org.created_by)
    formulation.approved_version_number = version.version_number
    formulation.save(update_fields=["approved_version_number", "updated_at"])
    publish_to_rtg_catalog(
        formulation,
        actor=org.created_by,
        marketing_fields={
            "rtg_short_description": "Simple, clean Vit C.",
            "rtg_base_price": base_price,
            "rtg_moq": moq,
            "rtg_packaging_options": packaging_options,
            "rtg_currency_code": "GBP",
        },
    )
    formulation.refresh_from_db()
    return formulation


# ---------------------------------------------------------------------------
# publish_to_rtg_catalog
# ---------------------------------------------------------------------------


class TestPublishToRTGCatalog:
    def test_publish_service_rejects_custom_formulation(self):
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.CUSTOM,
        )
        with pytest.raises(FormulationRTGError) as exc_info:
            publish_to_rtg_catalog(
                formulation,
                actor=org.created_by,
                marketing_fields={
                    "rtg_short_description": "Great",
                    "rtg_base_price": Decimal("5"),
                    "rtg_moq": 10,
                    "rtg_packaging_options": ["A"],
                },
            )
        assert getattr(exc_info.value, "code", "") == "not_ready_to_go"

    def test_publish_service_requires_marketing_fields(self):
        """Every marketing field must be present + valid before
        ``is_rtg_published`` may flip true."""

        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.READY_TO_GO,
        )
        with pytest.raises(FormulationRTGError) as exc_info:
            publish_to_rtg_catalog(
                formulation,
                actor=org.created_by,
                marketing_fields={
                    # Everything missing.
                },
            )
        errors = getattr(exc_info.value, "field_errors", {}) or {}
        for field in (
            "rtg_short_description",
            "rtg_base_price",
            "rtg_moq",
            "rtg_packaging_options",
        ):
            assert field in errors, errors

    def test_publish_service_happy_path(self):
        org = OrganizationFactory()
        Membership.objects.get_or_create(
            organization=org, user=org.created_by,
        )
        formulation: Formulation = FormulationFactory(
            organization=org, project_type=ProjectType.READY_TO_GO,
        )
        publish_to_rtg_catalog(
            formulation,
            actor=org.created_by,
            marketing_fields={
                "rtg_short_description": "Great product",
                "rtg_base_price": Decimal("6.50"),
                "rtg_moq": 100,
                "rtg_packaging_options": ["Bottle 60ct"],
            },
        )
        formulation.refresh_from_db()
        assert formulation.is_rtg_published is True
        assert formulation.rtg_moq == 100
        assert formulation.rtg_packaging_options == ["Bottle 60ct"]

    def test_unpublish_leaves_marketing_intact(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org)
        unpublish_from_rtg_catalog(formulation, actor=org.created_by)
        formulation.refresh_from_db()
        assert formulation.is_rtg_published is False
        # Marketing fields survive so a republish doesn't need
        # re-typing.
        assert formulation.rtg_short_description == "Simple, clean Vit C."
        assert formulation.rtg_moq == 100


# ---------------------------------------------------------------------------
# create_portal_rtg_submission
# ---------------------------------------------------------------------------


class TestCreatePortalRTGSubmission:
    def test_happy_path_creates_proposal_and_cff_row(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        payload = PortalRTGSubmissionInput(
            rtg_formulation_id=str(formulation.id),
            quantity=150,
            packaging="60ct bottle",
            delivery_address="10 Downing Street, London",
        )
        submission = create_portal_rtg_submission(
            client_account=account, payload=payload,
        )

        submission.refresh_from_db()
        assert submission.submission_kind == CFFSubmissionKind.READY_TO_GO
        assert submission.provenance == "portal"
        assert submission.drafted_proposal_id is not None

        proposal = Proposal.objects.get(pk=submission.drafted_proposal_id)
        assert proposal.status == ProposalStatus.DRAFT
        assert proposal.quantity == 150
        assert proposal.unit_price == Decimal("6.50")
        # Line pre-filled with the SKU's name + chosen packaging so
        # the rendered PDF reads sensibly on the first render.
        line = proposal.lines.first()
        assert line is not None
        assert "60ct bottle" in line.description
        assert line.unit_price == Decimal("6.50")

    def test_below_moq_rejected(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org, moq=100)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        with pytest.raises(CFFRTGSubmissionError) as exc_info:
            create_portal_rtg_submission(
                client_account=account,
                payload=PortalRTGSubmissionInput(
                    rtg_formulation_id=str(formulation.id),
                    quantity=50,
                    packaging="60ct bottle",
                    delivery_address="10 Downing Street",
                ),
            )
        assert getattr(exc_info.value, "code", "") == "below_moq"
        assert "quantity" in getattr(exc_info.value, "field_errors", {})

    def test_invalid_packaging_rejected(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        with pytest.raises(CFFRTGSubmissionError) as exc_info:
            create_portal_rtg_submission(
                client_account=account,
                payload=PortalRTGSubmissionInput(
                    rtg_formulation_id=str(formulation.id),
                    quantity=100,
                    packaging="Jumbo drum",  # not offered
                    delivery_address="10 Downing Street",
                ),
            )
        assert getattr(exc_info.value, "code", "") == "invalid_packaging"

    def test_unpublished_sku_returns_not_found(self):
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org,
            project_type=ProjectType.READY_TO_GO,
        )  # not published
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        with pytest.raises(CFFRTGSubmissionError) as exc_info:
            create_portal_rtg_submission(
                client_account=account,
                payload=PortalRTGSubmissionInput(
                    rtg_formulation_id=str(formulation.id),
                    quantity=100,
                    packaging="Any",
                    delivery_address="10 Downing Street",
                ),
            )
        assert getattr(exc_info.value, "code", "") == "rtg_sku_not_found"

    def test_wrong_org_sku_returns_not_found(self):
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        # Published SKU lives in org B; customer belongs to org A.
        formulation = _make_rtg_sku(org=org_b)
        customer = _make_customer(org=org_a)
        account = _make_client_account(customer=customer)

        with pytest.raises(CFFRTGSubmissionError) as exc_info:
            create_portal_rtg_submission(
                client_account=account,
                payload=PortalRTGSubmissionInput(
                    rtg_formulation_id=str(formulation.id),
                    quantity=100,
                    packaging="60ct bottle",
                    delivery_address="10 Downing Street",
                ),
            )
        assert getattr(exc_info.value, "code", "") == "rtg_sku_not_found"


# ---------------------------------------------------------------------------
# Catalog + submission endpoints
# ---------------------------------------------------------------------------


class TestRTGCatalogEndpoint:
    def test_lists_only_published_and_own_org(self):
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        published_a = _make_rtg_sku(org=org_a, name="Vit C")
        # Unpublished draft in org A — must be hidden.
        FormulationFactory(
            organization=org_a,
            project_type=ProjectType.READY_TO_GO,
            name="Draft SKU",
        )
        # Published SKU in a sibling org — must be hidden too.
        _make_rtg_sku(org=org_b, name="Not visible")

        customer = _make_customer(org=org_a)
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        r = client.get("/api/portal/rtg-catalog/")
        assert r.status_code == 200
        results = r.json()["results"]
        assert len(results) == 1
        assert results[0]["id"] == str(published_a.id)
        # Marketing fields flow through untouched.
        assert results[0]["moq"] == 100
        assert "60ct bottle" in results[0]["packaging_options"]


class TestRTGCreateAPI:
    def test_api_201_returns_full_detail(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        r = client.post(
            "/api/portal/cffs/new-rtg/",
            {
                "rtg_formulation_id": str(formulation.id),
                "quantity": 150,
                "packaging": "60ct bottle",
                "delivery_address": "10 Downing Street",
            },
            format="json",
        )
        assert r.status_code == 201, r.content
        body = r.json()
        assert body["submission_kind"] == "ready_to_go"
        assert body["provenance"] == "portal"
        assert body["is_rejected"] is False

    def test_api_401_without_cookie(self):
        client = APIClient()
        r = client.post(
            "/api/portal/cffs/new-rtg/",
            {
                "rtg_formulation_id": "00000000-0000-0000-0000-000000000000",
                "quantity": 100,
                "packaging": "A",
                "delivery_address": "B",
            },
            format="json",
        )
        assert r.status_code in (401, 403)

    def test_below_moq_returns_422(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org, moq=200)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        client = APIClient()
        _login_portal(client, account)
        r = client.post(
            "/api/portal/cffs/new-rtg/",
            {
                "rtg_formulation_id": str(formulation.id),
                "quantity": 50,
                "packaging": "60ct bottle",
                "delivery_address": "10 Downing Street",
            },
            format="json",
        )
        assert r.status_code == 422, r.content
        body = r.json()
        assert body["code"] == "below_moq"
        assert "quantity" in (body.get("fields") or {})


class TestRTGProductsListSurface:
    def test_rtg_appears_on_products_list_with_awaiting_proposal_stage(self):
        org = OrganizationFactory()
        formulation = _make_rtg_sku(org=org)
        customer = _make_customer(org=org)
        account = _make_client_account(customer=customer)

        create_portal_rtg_submission(
            client_account=account,
            payload=PortalRTGSubmissionInput(
                rtg_formulation_id=str(formulation.id),
                quantity=150,
                packaging="60ct bottle",
                delivery_address="10 Downing Street",
            ),
        )

        client = APIClient()
        _login_portal(client, account)
        r = client.get("/api/portal/dashboard/")
        assert r.status_code == 200
        products = r.json()["products"]
        rtg_cards = [p for p in products if p.get("kind") == "cff"]
        assert len(rtg_cards) == 1
        card = rtg_cards[0]
        assert card["stage_key"] == "cff_awaiting_proposal"
        assert card.get("submission_kind") == "ready_to_go"
