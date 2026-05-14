"""Tests for the post-approval ``complete_required_fields`` escape
hatch and the tightened ``in_review → approved`` gate.

Two related behaviours are pinned here:

* The gate at ``in_review → approved`` now requires the same set the
  ``approved → sent`` gate checked — the director cannot sign off on
  a proposal whose ``reference`` / ``invoice_address`` is blank. This
  closes the gap that previously let approvals through to the
  read-only ``approved`` state with no path to fix the blanks.
* :func:`complete_required_fields` is the narrow escape hatch for
  proposals that *were* approved under the old loose gate. It only
  accepts a whitelist of free-text required-for-sent fields, and only
  for fields currently flagged missing — so it cannot be used to
  silently rewrite content the director did approve.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.audit.models import AuditLog
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    MissingRequiredFields,
    ProposalNotMissingRequiredField,
    ProposalNotMutable,
    complete_required_fields,
    transition_status,
)
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _seed_in_review(org, owner, **overrides) -> Any:
    """Build an ``in_review`` proposal populated enough that *most* of
    the required-for-approved gate passes — caller spreads
    ``overrides`` to selectively blank a field under test."""

    defaults = dict(
        organization=org,
        created_by=owner,
        updated_by=owner,
        status=ProposalStatus.IN_REVIEW.value,
        customer_name="Alex Buyer",
        customer_email="alex@buyer.test",
        customer_company="Buyer Ltd",
        invoice_address="1 Buyer Street",
        reference="REF-001",
        currency="GBP",
        quantity=1,
    )
    defaults.update(overrides)
    proposal = ProposalFactory(**defaults)
    proposal.sales_person = owner
    proposal.save(update_fields=["sales_person"])
    proposal.lines.create(
        formulation_version=proposal.formulation_version,
        product_code="LINE-001",
        description="Test line",
        quantity=1,
        unit_price="10.00",
        display_order=0,
    )
    return proposal


def _seed_approved_with_blank(org, owner, blank_field: str) -> Any:
    """Build a proposal already at ``approved`` with one
    required-for-sent field forced blank.

    The factory bypasses the status machine, so we can park a
    proposal at ``approved`` with a blank field even though the
    tightened gate now prevents reaching that state through the real
    flow — exactly the scenario the escape hatch exists for.
    """

    overrides = {blank_field: ""}
    defaults = dict(
        organization=org,
        created_by=owner,
        updated_by=owner,
        status=ProposalStatus.APPROVED.value,
        customer_name="Alex Buyer",
        customer_email="alex@buyer.test",
        customer_company="Buyer Ltd",
        invoice_address="1 Buyer Street",
        reference="REF-001",
        currency="GBP",
        quantity=1,
    )
    defaults.update(overrides)
    proposal = ProposalFactory(**defaults)
    proposal.sales_person = owner
    proposal.save(update_fields=["sales_person"])
    proposal.lines.create(
        formulation_version=proposal.formulation_version,
        product_code="LINE-001",
        description="Test line",
        quantity=1,
        unit_price="10.00",
        display_order=0,
    )
    return proposal


# ---------------------------------------------------------------------------
# Tightened approval gate
# ---------------------------------------------------------------------------


class TestApprovalGateRequiresFullSet:
    """``in_review → approved`` now rejects the same blanks that
    ``approved → sent`` did — catching them at approval time means a
    director never signs an incomplete proposal."""

    def test_blank_reference_blocks_approval(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Approve Test Co")
        proposal = _seed_in_review(org, owner, reference="")

        with pytest.raises(MissingRequiredFields) as exc:
            transition_status(
                proposal=proposal,
                actor=owner,
                to_status=ProposalStatus.APPROVED.value,
                signature_image=_TINY_PNG,
            )
        assert "reference" in exc.value.missing

    def test_blank_invoice_address_blocks_approval(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Approve Test Co")
        proposal = _seed_in_review(org, owner, invoice_address="")

        with pytest.raises(MissingRequiredFields) as exc:
            transition_status(
                proposal=proposal,
                actor=owner,
                to_status=ProposalStatus.APPROVED.value,
                signature_image=_TINY_PNG,
            )
        assert "invoice_address" in exc.value.missing

    def test_complete_proposal_approves(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Approve Test Co")
        proposal = _seed_in_review(org, owner)

        updated = transition_status(
            proposal=proposal,
            actor=owner,
            to_status=ProposalStatus.APPROVED.value,
            signature_image=_TINY_PNG,
        )
        assert updated.status == ProposalStatus.APPROVED.value


# ---------------------------------------------------------------------------
# complete_required_fields service
# ---------------------------------------------------------------------------


class TestCompleteRequiredFieldsService:
    def test_fills_missing_invoice_address(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Escape Hatch Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")

        updated = complete_required_fields(
            proposal=proposal,
            actor=owner,
            patch={"invoice_address": "12 Fixed Street, London"},
        )
        assert updated.invoice_address == "12 Fixed Street, London"
        # Status stays at ``approved`` — director signature is untouched.
        assert updated.status == ProposalStatus.APPROVED.value
        # Audit row recorded.
        assert AuditLog.objects.filter(
            organization=org,
            action="proposal.complete_required_fields",
        ).exists()

    def test_rejects_non_whitelisted_key(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Escape Hatch Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")

        with pytest.raises(ProposalNotMissingRequiredField):
            complete_required_fields(
                proposal=proposal,
                actor=owner,
                patch={
                    "invoice_address": "12 Fixed Street",
                    # ``delivery_address`` is optional, not on the
                    # required-for-sent list, so it isn't fillable
                    # through this narrow path.
                    "delivery_address": "Tampered Delivery",
                },
            )

    def test_rejects_key_not_currently_missing(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Escape Hatch Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")

        # ``customer_name`` is filled on this proposal — the escape
        # hatch must refuse to overwrite content the director did
        # approve.
        with pytest.raises(ProposalNotMissingRequiredField):
            complete_required_fields(
                proposal=proposal,
                actor=owner,
                patch={"customer_name": "Different Name"},
            )

    def test_rejects_blank_value(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Escape Hatch Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")

        with pytest.raises(ProposalNotMissingRequiredField):
            complete_required_fields(
                proposal=proposal,
                actor=owner,
                patch={"invoice_address": "   "},
            )

    def test_rejects_when_not_approved(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Escape Hatch Co")
        # Draft proposal — the lock guard short-circuits before any
        # missing-fields evaluation.
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.DRAFT.value,
            invoice_address="",
        )
        with pytest.raises(ProposalNotMutable):
            complete_required_fields(
                proposal=proposal,
                actor=owner,
                patch={"invoice_address": "12 Fixed Street"},
            )


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------


def _endpoint(org_id: str, proposal_id: str) -> str:
    return reverse(
        "proposals:proposal-complete-required-fields",
        kwargs={"org_id": org_id, "proposal_id": proposal_id},
    )


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


class TestCompleteRequiredFieldsEndpoint:
    def test_success_returns_updated_proposal(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Endpoint Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")
        _login(api_client, owner)

        response = api_client.post(
            _endpoint(str(org.id), str(proposal.id)),
            {"patch": {"invoice_address": "12 Fixed Street, London"}},
            format="json",
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["invoice_address"] == "12 Fixed Street, London"

    def test_rejects_without_edit_cap(self, api_client: APIClient) -> None:
        owner = UserFactory()
        viewer = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Endpoint Co")
        MembershipFactory(
            user=viewer,
            organization=org,
            permissions={"proposals": ["view"]},
        )
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")
        _login(api_client, viewer)

        response = api_client.post(
            _endpoint(str(org.id), str(proposal.id)),
            {"patch": {"invoice_address": "12 Fixed Street"}},
            format="json",
        )
        assert response.status_code == http_status.HTTP_403_FORBIDDEN

    def test_rejects_non_whitelisted_key(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Endpoint Co")
        proposal = _seed_approved_with_blank(org, owner, "invoice_address")
        _login(api_client, owner)

        response = api_client.post(
            _endpoint(str(org.id), str(proposal.id)),
            {
                "patch": {
                    "invoice_address": "12 Fixed Street",
                    "delivery_address": "Tampered",
                }
            },
            format="json",
        )
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST
        assert response.data["code"] == "proposal_not_missing_required_field"

    def test_rejects_on_draft(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Endpoint Co")
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.DRAFT.value,
            invoice_address="",
        )
        _login(api_client, owner)

        response = api_client.post(
            _endpoint(str(org.id), str(proposal.id)),
            {"patch": {"invoice_address": "12 Fixed Street"}},
            format="json",
        )
        assert response.status_code == http_status.HTTP_409_CONFLICT
