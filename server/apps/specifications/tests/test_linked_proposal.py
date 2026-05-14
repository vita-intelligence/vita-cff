"""Tests for the ``linked_proposal`` resolver on the spec serializer.

A proposal can attach a spec sheet two ways:

1. ``Proposal.specification_sheet`` — the legacy OneToOne FK. Only
   the first spec picked when the proposal is created lands here.
2. ``ProposalLine.specification_sheet`` — every additional spec
   bundled into the proposal as a line.

The Signed tab's "+ Create proposal" button reads
``linked_proposal`` from the spec serializer to decide whether the
spec is already in use. The original implementation only checked
the OneToOne, so specs attached as lines were reported as
"unlinked" and the button would silently produce a duplicate
proposal against an already-quoted spec.
"""

from __future__ import annotations

import pytest

from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import Proposal, ProposalLine
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.api.serializers import (
    SpecificationSheetReadSerializer,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _serialize(sheet):
    """Re-fetch + serialize via the same path the list endpoint uses,
    so the resolver sees the prefetched ``proposal_lines`` when
    applicable."""

    from apps.specifications.services import list_sheets

    fresh = list_sheets(organization=sheet.organization).get(pk=sheet.pk)
    return SpecificationSheetReadSerializer(fresh).data


class TestLinkedProposal:
    def test_one_to_one_link_surfaces(self) -> None:
        # The legacy ``Proposal.specification_sheet`` OneToOne FK is
        # populated when the spec was the FIRST one picked at
        # proposal-create time. ``linked_proposal`` should return
        # the proposal's identity.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        proposal = ProposalFactory(organization=org, specification_sheet=sheet)

        data = _serialize(sheet)
        assert data["linked_proposal"] is not None
        assert data["linked_proposal"]["id"] == str(proposal.id)
        assert data["linked_proposal"]["code"] == proposal.code

    def test_line_only_link_surfaces(self) -> None:
        # THE BUG: spec attached only via a ProposalLine (not the
        # OneToOne FK on the proposal) was reported as unlinked.
        # Now the resolver also walks ``proposal_lines`` and surfaces
        # the line's proposal.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        # Create a proposal NOT attached via the OneToOne, then
        # attach the spec to a line on that proposal.
        proposal = ProposalFactory(organization=org)
        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=proposal.formulation_version,
            specification_sheet=sheet,
        )
        # Confirm the OneToOne side is empty so the test exercises
        # the new fallback path, not the legacy branch.
        assert getattr(sheet, "proposal", None) is None

        data = _serialize(sheet)
        assert data["linked_proposal"] is not None
        assert data["linked_proposal"]["id"] == str(proposal.id)

    def test_freshest_proposal_wins_when_spec_is_on_many_lines(self) -> None:
        # Edge case — same spec attached as a line on two different
        # proposals (rare but technically possible). The resolver
        # picks the most-recently-updated proposal as the
        # representative link; the kiosk creator only needs one to
        # decide whether the spec is "in use".
        from django.utils import timezone
        from datetime import timedelta

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        older = ProposalFactory(organization=org)
        newer = ProposalFactory(organization=org)
        # Force ordering: older is older than newer.
        Proposal.objects.filter(pk=older.pk).update(
            updated_at=timezone.now() - timedelta(days=1)
        )
        ProposalLine.objects.create(
            proposal=older,
            formulation_version=older.formulation_version,
            specification_sheet=sheet,
        )
        ProposalLine.objects.create(
            proposal=newer,
            formulation_version=newer.formulation_version,
            specification_sheet=sheet,
        )

        data = _serialize(sheet)
        assert data["linked_proposal"] is not None
        assert data["linked_proposal"]["id"] == str(newer.id)

    def test_completely_unlinked_spec_returns_none(self) -> None:
        # Inverse of the bug — an actually-unlinked spec must keep
        # returning ``None`` so the Signed tab can surface the
        # "+ Create proposal" button.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        data = _serialize(sheet)
        assert data["linked_proposal"] is None
