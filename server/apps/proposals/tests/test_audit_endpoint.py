"""Tests for the staff-side proposal audit endpoint.

``GET /api/organizations/<org>/proposals/<id>/audit/`` is the surface
sales / ops staff hit when they need to defend the contract: it shows
who signed, from where, with what client, and whether the document
hash still matches what was signed. These tests pin the shape and the
hash drift detection — the latter is the load-bearing piece for a
legal argument.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.services import create_organization
from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    capture_customer_signature_on_attached_spec,
    capture_customer_signature_on_proposal,
)
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import SpecificationStatus
from apps.specifications.tests.factories import SpecificationSheetFactory

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


def _audit_url(org_id: str, proposal_id: str) -> str:
    return reverse(
        "proposals:proposal-audit",
        kwargs={"org_id": org_id, "proposal_id": proposal_id},
    )


def _signed_bundle(org, owner):
    """Build a sent + customer-signed proposal with one attached
    spec that's also customer-signed."""
    proposal = ProposalFactory(
        organization=org,
        created_by=owner,
        updated_by=owner,
        status=ProposalStatus.SENT.value,
    )
    sheet = SpecificationSheetFactory(
        organization=org,
        formulation_version=proposal.formulation_version,
        status=SpecificationStatus.SENT,
        created_by=owner,
        updated_by=owner,
    )
    line = proposal.lines.first()
    if line is None:
        line = proposal.lines.create(
            formulation_version=proposal.formulation_version,
            specification_sheet=sheet,
            quantity=1,
        )
    else:
        line.specification_sheet = sheet
        line.save(update_fields=["specification_sheet"])

    capture_customer_signature_on_proposal(
        proposal=proposal,
        signer_name="Alex Buyer",
        signer_email="alex@buyer.test",
        signer_company="Buyer Ltd",
        signature_image=_TINY_PNG,
        ack_spec_signing=True,
        ack_lead_times=True,
        ack_terms=True,
        ack_rd_terms=True,
        sign_ip="203.0.113.42",
        sign_user_agent="Mozilla/5.0 TestBrowser",
        sign_document_hash="a" * 64,
    )
    capture_customer_signature_on_attached_spec(
        proposal=proposal,
        sheet_id=sheet.id,
        signer_name="Alex Buyer",
        signer_email="alex@buyer.test",
        signer_company="Buyer Ltd",
        signature_image=_TINY_PNG,
        sign_ip="203.0.113.42",
        sign_user_agent="Mozilla/5.0 TestBrowser",
        sign_document_hash="b" * 64,
    )
    return proposal, sheet


class TestProposalAuditEndpoint:
    def test_returns_audit_shape_for_signed_proposal(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Audit Co")
        proposal, sheet = _signed_bundle(org, owner)
        _login(api_client, owner)

        response = api_client.get(_audit_url(str(org.id), str(proposal.id)))

        assert response.status_code == status.HTTP_200_OK
        body = response.data
        assert set(body.keys()) == {"proposal", "specs"}

        prop = body["proposal"]
        assert prop["signer_name"] == "Alex Buyer"
        assert prop["signer_email"] == "alex@buyer.test"
        assert prop["signer_company"] == "Buyer Ltd"
        assert prop["ip"] == "203.0.113.42"
        assert prop["user_agent"] == "Mozilla/5.0 TestBrowser"
        # Stored hash came from the fixture; current hash is a real
        # SHA-256 hex digest of the live render — they differ, so
        # ``hash_matches`` is ``False``. Length pinned at 64.
        assert prop["stored_hash"] == "a" * 64
        assert len(prop["current_hash"]) == 64
        assert prop["hash_matches"] is False

        assert len(body["specs"]) == 1
        spec = body["specs"][0]
        assert spec["id"] == str(sheet.id)
        assert spec["signer_name"] == "Alex Buyer"
        assert spec["stored_hash"] == "b" * 64
        assert len(spec["current_hash"]) == 64
        assert spec["hash_matches"] is False

    def test_hash_matches_when_stored_equals_post_sign_render(
        self, api_client: APIClient
    ) -> None:
        # Signing baked-in: stamp the post-sign hash the same way the
        # public sign endpoint does (sign → re-render → hash → save).
        # Reading the audit endpoint right after should report a
        # match because the document hasn't drifted.
        from apps.proposals.api.views import (
            _document_hash,
            _render_proposal_html,
        )

        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Match Co")
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.SENT.value,
        )

        # Step 1: sign (this mutates the proposal — adds signature
        # image + signed_at, which become part of the rendered HTML).
        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
            ack_spec_signing=True,
            ack_lead_times=True,
            ack_terms=True,
            ack_rd_terms=True,
            sign_ip="203.0.113.42",
            sign_user_agent="UA",
        )
        # Step 2: hash the post-sign render and persist — mirrors
        # what ``PublicProposalSignProposalView`` does after the
        # service returns.
        updated.customer_sign_document_hash = _document_hash(
            _render_proposal_html(updated)
        )
        updated.save(update_fields=["customer_sign_document_hash"])

        _login(api_client, owner)
        response = api_client.get(_audit_url(str(org.id), str(proposal.id)))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["proposal"]["hash_matches"] is True
        assert len(response.data["proposal"]["stored_hash"]) == 64
        assert (
            response.data["proposal"]["stored_hash"]
            == response.data["proposal"]["current_hash"]
        )

    def test_hash_drifts_when_proposal_edited_after_signing(
        self, api_client: APIClient
    ) -> None:
        # The point of the audit trail: edit a signed proposal and
        # the audit endpoint immediately flips ``hash_matches`` to
        # ``False`` so staff can spot post-sign drift.
        from apps.proposals.api.views import (
            _document_hash,
            _render_proposal_html,
        )

        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Drift Co")
        proposal = ProposalFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            status=ProposalStatus.SENT.value,
        )
        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
            ack_spec_signing=True,
            ack_lead_times=True,
            ack_terms=True,
            ack_rd_terms=True,
        )
        updated.customer_sign_document_hash = _document_hash(
            _render_proposal_html(updated)
        )
        updated.save(update_fields=["customer_sign_document_hash"])

        # Mutate the proposal *after* the hash was captured. Saving
        # ``customer_name`` directly bypasses the terminal-state guard
        # so the test stays focused on hash-drift detection.
        from apps.proposals.models import Proposal

        Proposal.objects.filter(id=proposal.id).update(
            customer_name="Tampered Customer"
        )

        _login(api_client, owner)
        response = api_client.get(_audit_url(str(org.id), str(proposal.id)))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["proposal"]["hash_matches"] is False

    def test_anonymous_caller_blocked(self, api_client: APIClient) -> None:
        # The endpoint requires ``proposals:view_signed``; anonymous
        # callers must never enumerate or read it. 401/403 either
        # would do (DRF picks 401 here because no auth provided),
        # the test just pins the negative.
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Locked Co")
        proposal = ProposalFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        response = api_client.get(_audit_url(str(org.id), str(proposal.id)))
        assert response.status_code in (
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
        )
