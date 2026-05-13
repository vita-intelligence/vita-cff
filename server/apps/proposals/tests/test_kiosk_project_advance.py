"""Tests that the proposal-centric kiosk finalize advances the
formulation's project-roadmap chip.

Background: the spec-only kiosk (``/p/<token>``) already wires
:func:`_maybe_advance_project_status` into ``accept_as_customer`` so a
customer-signed draft spec flips the project's roadmap chip from
``in_development`` → ``pilot``. The proposal-centric kiosk bundles the
same spec plus a commercial proposal and finalises them together —
**the bundled flow must move the chip too**, otherwise the customer
just signed the deal but the project workspace still shows the old
status, confusing the scientist and breaking the dashboard filters.

Forward-only logic is reused as-is: a project already at ``approved``
won't slip back to ``pilot`` because someone re-signed a draft via the
bundled path.
"""

from __future__ import annotations

import pytest

from apps.formulations.models import ProjectStatus
from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    capture_customer_signature_on_attached_spec,
    capture_customer_signature_on_proposal,
    finalize_proposal_kiosk,
)
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationStatus,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _bundle(document_kind: SpecificationDocumentKind):
    """Build a sent proposal with one attached spec of the requested
    document kind, pinned to the same formulation snapshot so the
    project-status link is well-defined."""
    proposal = ProposalFactory(status=ProposalStatus.SENT.value)
    formulation = proposal.formulation_version.formulation
    formulation.project_status = ProjectStatus.IN_DEVELOPMENT.value
    formulation.save(update_fields=["project_status"])

    sheet = SpecificationSheetFactory(
        organization=proposal.organization,
        formulation_version=proposal.formulation_version,
        status=SpecificationStatus.SENT,
        document_kind=document_kind,
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
    return proposal, sheet, formulation


def _sign_both(proposal, sheet):
    capture_customer_signature_on_proposal(
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
    capture_customer_signature_on_attached_spec(
        proposal=proposal,
        sheet_id=sheet.id,
        signer_name="Alex",
        signer_email="alex@buyer.test",
        signer_company="Buyer",
        signature_image=_TINY_PNG,
    )


class TestKioskFinalizeAdvancesProjectStatus:
    def test_draft_spec_bundles_advance_project_to_pilot(self) -> None:
        proposal, sheet, formulation = _bundle(
            SpecificationDocumentKind.DRAFT
        )
        _sign_both(proposal, sheet)

        finalize_proposal_kiosk(proposal=proposal)
        formulation.refresh_from_db()

        assert formulation.project_status == ProjectStatus.PILOT.value

    def test_final_spec_bundles_advance_project_to_approved(self) -> None:
        proposal, sheet, formulation = _bundle(
            SpecificationDocumentKind.FINAL
        )
        _sign_both(proposal, sheet)

        finalize_proposal_kiosk(proposal=proposal)
        formulation.refresh_from_db()

        assert formulation.project_status == ProjectStatus.APPROVED.value

    def test_forward_only_does_not_demote_approved_project(self) -> None:
        # Project already at approved (e.g., scientist manually set it
        # ahead of time). Re-signing a draft via a bundled proposal
        # must NOT slip it back to pilot — the forward-only guard
        # inside ``_maybe_advance_project_status`` covers that.
        proposal, sheet, formulation = _bundle(
            SpecificationDocumentKind.DRAFT
        )
        formulation.project_status = ProjectStatus.APPROVED.value
        formulation.save(update_fields=["project_status"])
        _sign_both(proposal, sheet)

        finalize_proposal_kiosk(proposal=proposal)
        formulation.refresh_from_db()

        assert formulation.project_status == ProjectStatus.APPROVED.value
