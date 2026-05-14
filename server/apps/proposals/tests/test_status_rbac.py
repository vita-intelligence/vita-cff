"""RBAC tests for the per-status capability gate on
``POST /proposals/<id>/status/``.

The endpoint hosts four very different transitions behind one URL:

* ``draft → in_review``         — anyone with ``proposals.edit``
* ``in_review → draft`` (back)  — anyone with ``proposals.edit``
* ``in_review → approved``      — director-only (``proposals.approve``)
* ``approved → sent``           — sales (``proposals.edit``)
* ``sent → accepted / rejected`` — commercial close
  (``proposals.manual_close``)

These tests pin each gate so a future refactor that collapses the
view back to a single ``required_capability = EDIT`` immediately
fails CI — that loose gate is what the cap split was introduced to
prevent.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.proposals.models import ProposalStatus
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
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


def _status_url(org_id: str, proposal_id: str) -> str:
    return reverse(
        "proposals:proposal-status",
        kwargs={"org_id": org_id, "proposal_id": proposal_id},
    )


def _approved_proposal_with_lines(org, owner):
    """Build a proposal at ``in_review`` populated enough that the
    ``in_review → approved`` gate passes its required-fields check."""
    proposal = ProposalFactory(
        organization=org,
        created_by=owner,
        updated_by=owner,
        status=ProposalStatus.IN_REVIEW.value,
        customer_name="Alex Buyer",
        customer_email="alex@buyer.test",
        customer_company="Buyer Ltd",
        customer_phone="+44 0000",
        invoice_address="1 Buyer Street",
        delivery_address="1 Buyer Street",
        dear_name="Alex",
        reference="REF-001",
        currency="GBP",
        quantity=1,
    )
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


class TestApproveCapability:
    def test_editor_without_approve_cannot_approve(
        self, api_client: APIClient
    ) -> None:
        # A sales rep with ``proposals.edit`` should NOT be able to
        # flip a proposal to ``approved`` — that's director-only.
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Edit-Only Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"proposals": ["view", "edit"]},
        )
        proposal = _approved_proposal_with_lines(org, owner)
        _login(api_client, editor)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {
                "status": ProposalStatus.APPROVED.value,
                "signature_image": _TINY_PNG,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.IN_REVIEW.value

    def test_approver_can_approve(self, api_client: APIClient) -> None:
        owner = UserFactory()
        director = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Director Co")
        MembershipFactory(
            user=director,
            organization=org,
            permissions={"proposals": ["view", "edit", "approve"]},
        )
        proposal = _approved_proposal_with_lines(org, owner)
        _login(api_client, director)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {
                "status": ProposalStatus.APPROVED.value,
                "signature_image": _TINY_PNG,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.APPROVED.value

    def test_editor_can_still_send_for_review(
        self, api_client: APIClient
    ) -> None:
        # ``edit`` is enough for the non-approval edges so a sales rep
        # can drive the proposal up to the director's inbox without
        # being granted the director cap.
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Editor Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"proposals": ["view", "edit"]},
        )
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.DRAFT.value,
            customer_name="Alex",
            customer_email="alex@buyer.test",
        )
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
        _login(api_client, editor)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {
                "status": ProposalStatus.IN_REVIEW.value,
                "signature_image": _TINY_PNG,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.IN_REVIEW.value


class TestManualCloseCapability:
    def test_editor_without_manual_close_cannot_close(
        self, api_client: APIClient
    ) -> None:
        # An editor must not be able to declare a deal won or lost
        # from the staff UI — that override requires
        # ``proposals.manual_close`` (typically a commercial lead).
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Edit-Only Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"proposals": ["view", "edit", "approve"]},
        )
        # Skip directly to ``sent`` to exercise the manual-close gate.
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.SENT.value,
        )
        _login(api_client, editor)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {"status": ProposalStatus.ACCEPTED.value},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_closer_can_close(self, api_client: APIClient) -> None:
        owner = UserFactory()
        closer = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Closer Co")
        MembershipFactory(
            user=closer,
            organization=org,
            permissions={
                "proposals": ["view", "edit", "manual_close"]
            },
        )
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.SENT.value,
        )
        _login(api_client, closer)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {"status": ProposalStatus.REJECTED.value},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.REJECTED.value
