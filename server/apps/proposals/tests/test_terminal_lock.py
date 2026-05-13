"""Tests that lock the terminal-state freeze on accepted/rejected
proposals.

Once a proposal reaches ``accepted`` it is the contract the client
signed; once it reaches ``rejected`` it is the closed-loss audit row.
Either way, no further mutation may touch the document — the row
must keep matching what the customer saw at signing, and the audit
trail must stay intact. These tests pin the guard at the service
layer so a future view-level refactor cannot silently re-open the
edit surface.
"""

from __future__ import annotations

import pytest

from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    ProposalNotMutable,
    add_proposal_line,
    delete_proposal,
    delete_proposal_line,
    update_proposal,
    update_proposal_line,
)
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


@pytest.fixture(params=[ProposalStatus.ACCEPTED.value, ProposalStatus.REJECTED.value])
def terminal_proposal(request):
    """One fixture, two parametrised states — both lock identically."""
    return ProposalFactory(status=request.param)


class TestTerminalLock:
    def test_update_proposal_rejected(self, terminal_proposal) -> None:
        with pytest.raises(ProposalNotMutable):
            update_proposal(
                proposal=terminal_proposal,
                actor=terminal_proposal.organization.created_by,
                customer_name="Tampered Customer",
            )

    def test_delete_proposal_rejected(self, terminal_proposal) -> None:
        with pytest.raises(ProposalNotMutable):
            delete_proposal(
                proposal=terminal_proposal,
                actor=terminal_proposal.organization.created_by,
            )

    def test_add_line_rejected(self, terminal_proposal) -> None:
        with pytest.raises(ProposalNotMutable):
            add_proposal_line(
                proposal=terminal_proposal,
                actor=terminal_proposal.organization.created_by,
                product_code="EXTRA-001",
                description="Tampered line",
                quantity=1,
            )

    def test_update_line_rejected(self, terminal_proposal) -> None:
        # Seed a line under a draft snapshot then flip status — mirrors
        # the real lifecycle (lines are added pre-signing, then the
        # proposal advances through approvals to accepted/rejected).
        terminal_proposal.status = ProposalStatus.DRAFT.value
        terminal_proposal.save(update_fields=["status"])
        line = add_proposal_line(
            proposal=terminal_proposal,
            actor=terminal_proposal.organization.created_by,
            product_code="SEED-001",
            description="Pre-lock line",
            quantity=1,
        )
        # Re-flip to terminal — same status the fixture originally had.
        target_status = (
            ProposalStatus.ACCEPTED.value
            if terminal_proposal.pk
            else ProposalStatus.REJECTED.value
        )
        terminal_proposal.status = target_status
        terminal_proposal.save(update_fields=["status"])

        with pytest.raises(ProposalNotMutable):
            update_proposal_line(
                proposal=terminal_proposal,
                line_id=line.id,
                actor=terminal_proposal.organization.created_by,
                quantity=99,
            )

        with pytest.raises(ProposalNotMutable):
            delete_proposal_line(
                proposal=terminal_proposal,
                line_id=line.id,
                actor=terminal_proposal.organization.created_by,
            )
