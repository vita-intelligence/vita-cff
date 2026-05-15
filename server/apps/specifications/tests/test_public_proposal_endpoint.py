"""Tests for the public-kiosk proposal iframe endpoint and the
``has_proposal`` flag that gates it on the spec kiosk page.

The bug these tests pin: a spec attached to a proposal via
``ProposalLine.specification_sheet`` (rather than the legacy
``Proposal.specification_sheet`` OneToOne) used to be invisible to
``has_proposal`` and the ``/api/public/specifications/<token>/proposal/``
endpoint. On multi-spec proposals every spec after the first one
goes through ``ProposalLine`` — so the kiosk reported "no proposal"
and the iframe 404'd the customer instead of rendering the price
breakdown.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import ProposalLine
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.services import (
    render_context,
    resolve_linked_proposal,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _publish(sheet):
    """Set a public token on the sheet so the kiosk URL resolves.

    The factory leaves ``public_token`` null because most spec
    workflows are private until a kiosk link is generated; these
    tests need it set so the kiosk endpoint can find the sheet.
    """

    sheet.public_token = uuid.uuid4()
    sheet.save(update_fields=["public_token"])
    return sheet


# ---------------------------------------------------------------------------
# resolve_linked_proposal — pure service
# ---------------------------------------------------------------------------


class TestResolveLinkedProposal:
    def test_one_to_one_fk_returns_proposal(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        proposal = ProposalFactory(organization=org, specification_sheet=sheet)

        sheet.refresh_from_db()
        assert resolve_linked_proposal(sheet) == proposal

    def test_proposal_line_attachment_returns_proposal(self) -> None:
        # The bug case — the proposal is attached only through a
        # line, not the legacy OneToOne. Prior code returned None.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        proposal = ProposalFactory(organization=org)
        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=proposal.formulation_version,
            specification_sheet=sheet,
        )
        sheet.refresh_from_db()
        # Sanity: the legacy OneToOne side really is empty so the
        # test exercises the fallback, not the legacy branch.
        assert getattr(sheet, "proposal", None) is None

        assert resolve_linked_proposal(sheet) == proposal

    def test_returns_none_when_truly_unlinked(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        assert resolve_linked_proposal(sheet) is None


# ---------------------------------------------------------------------------
# render_context — has_proposal flag
# ---------------------------------------------------------------------------


class TestHasProposalFlag:
    def test_has_proposal_true_for_one_to_one(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        ProposalFactory(organization=org, specification_sheet=sheet)
        sheet.refresh_from_db()

        context = render_context(sheet)
        assert context["sheet"]["has_proposal"] is True

    def test_has_proposal_true_for_proposal_line_attachment(self) -> None:
        # The bug: kiosk reported has_proposal=False even though
        # the spec is part of a multi-spec proposal via a line.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        proposal = ProposalFactory(organization=org)
        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=proposal.formulation_version,
            specification_sheet=sheet,
        )
        sheet.refresh_from_db()

        context = render_context(sheet)
        assert context["sheet"]["has_proposal"] is True

    def test_has_proposal_false_when_unlinked(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)

        context = render_context(sheet)
        assert context["sheet"]["has_proposal"] is False


# ---------------------------------------------------------------------------
# Public iframe endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _proposal_url(token: Any) -> str:
    return reverse(
        "specifications:public-specification-proposal",
        kwargs={"token": token},
    )


class TestPublicProposalRenderView:
    def test_returns_html_when_one_to_one_attached(
        self, api_client: APIClient
    ) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        ProposalFactory(organization=org, specification_sheet=sheet)
        _publish(sheet)

        response = api_client.get(_proposal_url(sheet.public_token))
        assert response.status_code == http_status.HTTP_200_OK
        assert response["Content-Type"].startswith("text/html")
        assert b"<" in response.content  # really HTML, not a JSON 404

    def test_returns_html_when_attached_via_proposal_line(
        self, api_client: APIClient
    ) -> None:
        # THE FIX: every spec after the first in a multi-spec
        # proposal attaches via ``ProposalLine`` rather than the
        # OneToOne FK. Without resolve_linked_proposal here, the
        # iframe 404'd and the customer saw an error in place of
        # the proposal preview.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        proposal = ProposalFactory(organization=org)
        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=proposal.formulation_version,
            specification_sheet=sheet,
        )
        _publish(sheet)

        response = api_client.get(_proposal_url(sheet.public_token))
        assert response.status_code == http_status.HTTP_200_OK
        assert response["Content-Type"].startswith("text/html")

    def test_returns_404_when_truly_unlinked(
        self, api_client: APIClient
    ) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        _publish(sheet)

        response = api_client.get(_proposal_url(sheet.public_token))
        assert response.status_code == http_status.HTTP_404_NOT_FOUND

    def test_returns_404_when_token_is_unknown(
        self, api_client: APIClient
    ) -> None:
        bogus = uuid.uuid4()
        response = api_client.get(_proposal_url(bogus))
        assert response.status_code == http_status.HTTP_404_NOT_FOUND
