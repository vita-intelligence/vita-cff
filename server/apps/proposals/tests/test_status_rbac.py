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
        # Seed every required field — this test pins the *RBAC*
        # outcome (editor with the right cap CAN move to in_review);
        # the required-fields gate is exercised separately in
        # ``test_complete_required_fields.py`` and would otherwise
        # mask the capability check with a 400 for missing data.
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.DRAFT.value,
            customer_name="Alex",
            customer_email="alex@buyer.test",
            reference="REF-001",
            invoice_address="1 Buyer Street",
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


class TestRevertFromApproved:
    """The ``approved → draft`` revert wipes signature evidence + the
    public kiosk token, so it's gated on the ``approve`` capability
    (whoever grants approval should also be the one who revokes it)
    and it's not available once the proposal reaches ``sent`` (the
    customer may already be reading it — that path is manual reject).

    Bypasses the shared ``_approved_proposal_with_lines`` helper /
    ``ProposalFactory`` because both funnel through
    :func:`apps.formulations.services.save_version` which currently
    fails a completeness gate on freshly-factoried formulations.
    These tests build state manually at model level to sidestep that
    unrelated brittleness.
    """

    def _fully_approved(self, org, owner):
        """Build a proposal in ``approved`` with real signature evidence
        + a live kiosk token that the revert should wipe."""

        from uuid import uuid4

        from apps.formulations.models import FormulationVersion
        from apps.formulations.tests.factories import FormulationFactory
        from apps.proposals.models import Proposal
        from django.utils import timezone

        formulation = FormulationFactory(organization=org)
        version = FormulationVersion.objects.create(
            formulation=formulation, version_number=1, created_by=owner,
        )
        now = timezone.now()
        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            status=ProposalStatus.APPROVED.value,
            customer_name="Alex Buyer",
            customer_email="alex@buyer.test",
            reference="REF-001",
            invoice_address="1 Buyer Street",
            currency="GBP",
            quantity=1,
            sales_person=owner,
            prepared_by_user=owner,
            prepared_by_signed_at=now,
            prepared_by_signature_image=_TINY_PNG,
            director_user=owner,
            director_signed_at=now,
            director_signature_image=_TINY_PNG,
            public_token=uuid4(),
            created_by=owner,
            updated_by=owner,
        )
        proposal.lines.create(
            formulation_version=version,
            product_code="LINE-001",
            description="Test line",
            quantity=1,
            unit_price="10.00",
            display_order=0,
        )
        return proposal

    def test_editor_without_approve_cannot_revert(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Revert Edit-Only Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"proposals": ["view", "edit"]},
        )
        proposal = self._fully_approved(org, owner)
        _login(api_client, editor)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {"status": ProposalStatus.DRAFT.value},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.APPROVED.value
        # Signature evidence + kiosk token untouched.
        assert proposal.director_signature_image
        assert proposal.public_token is not None

    def test_approver_can_revert_and_evidence_is_wiped(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory()
        director = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Revert Director Co")
        MembershipFactory(
            user=director,
            organization=org,
            permissions={"proposals": ["view", "edit", "approve"]},
        )
        proposal = self._fully_approved(org, owner)
        _login(api_client, director)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {"status": ProposalStatus.DRAFT.value},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK

        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.DRAFT.value
        # Whole signature chain wiped — a fresh in_review + approve
        # is required before the kiosk link comes back to life.
        assert proposal.director_signature_image == ""
        assert proposal.director_signed_at is None
        assert proposal.director_user_id is None
        assert proposal.prepared_by_signature_image == ""
        assert proposal.prepared_by_signed_at is None
        assert proposal.prepared_by_user_id is None
        assert proposal.public_token is None

    def test_revert_from_sent_is_rejected(
        self, api_client: APIClient
    ) -> None:
        # No revert edge from ``sent`` — the customer may already be
        # reading the kiosk link, so the only exit is a manual reject.
        from uuid import uuid4

        from apps.formulations.models import FormulationVersion
        from apps.formulations.tests.factories import FormulationFactory
        from apps.proposals.models import Proposal

        owner = UserFactory()
        director = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Sent Revert Co")
        MembershipFactory(
            user=director,
            organization=org,
            permissions={"proposals": ["view", "edit", "approve"]},
        )
        formulation = FormulationFactory(organization=org)
        version = FormulationVersion.objects.create(
            formulation=formulation, version_number=1, created_by=owner,
        )
        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            status=ProposalStatus.SENT.value,
            currency="GBP",
            quantity=1,
            created_by=owner,
            updated_by=owner,
        )
        _login(api_client, director)

        response = api_client.post(
            _status_url(str(org.id), str(proposal.id)),
            {"status": ProposalStatus.DRAFT.value},
            format="json",
        )
        # 400 with ``invalid_proposal_transition`` — the state machine
        # rejects the edge, not the permission layer.
        assert response.status_code == status.HTTP_400_BAD_REQUEST


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
        # Manual reject must populate the same audit columns the
        # kiosk path writes — without them the rejection panel on
        # the staff proposal page wouldn't render and the
        # sales-person email wouldn't carry a reason.
        assert proposal.customer_rejected_at is not None
        assert proposal.customer_rejection_reason == ""

    @pytest.mark.django_db(transaction=True)
    def test_closer_manual_reject_stores_reason_and_queues_email(
        self, api_client: APIClient,
    ) -> None:
        """The ``notes`` body field is the closer's free-text reason
        — it must round-trip onto ``customer_rejection_reason`` (so
        the rejection panel surfaces it) and the rejection-email
        task must be queued on commit (so the sales person is told
        the deal closed).
        """

        from unittest.mock import patch

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

        with patch(
            "apps.proposals.tasks.send_proposal_rejection_notification_task.delay"
        ) as mock_task:
            response = api_client.post(
                _status_url(str(org.id), str(proposal.id)),
                {
                    "status": ProposalStatus.REJECTED.value,
                    "notes": "Customer told us by phone — pivoting away from this SKU.",
                },
                format="json",
            )
        assert response.status_code == status.HTTP_200_OK
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.REJECTED.value
        assert (
            proposal.customer_rejection_reason
            == "Customer told us by phone — pivoting away from this SKU."
        )
        # The notification queue must have been hit exactly once —
        # the on_commit hook fires when the test's atomic block
        # commits (APIClient transactions commit at the response).
        mock_task.assert_called_once_with(str(proposal.id))
