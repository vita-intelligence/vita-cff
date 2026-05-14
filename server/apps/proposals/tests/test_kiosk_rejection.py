"""Tests for the customer-side proposal rejection flow.

The kiosk's "Decline this proposal" button:

1. Flips the proposal from ``sent`` → ``rejected``.
2. Stamps ``customer_rejected_at`` + optional ``customer_rejection_reason``.
3. Emails the sales person (best-effort, on commit).

Each invariant is pinned below so a future refactor can't quietly
break the rejection contract.
"""

from __future__ import annotations

import pytest

from apps.proposals.models import ProposalStatus, ProposalStatusTransition
from apps.proposals.services import (
    InvalidProposalTransition,
    capture_customer_rejection_on_proposal,
)
from apps.proposals.tests.factories import ProposalFactory

#: ``transaction=True`` because the rejection service dispatches the
#: notification email via :func:`transaction.on_commit`. The default
#: ``django_db`` mark wraps the test in a savepoint that never commits,
#: so the on-commit callback would never fire and the mailbox stays
#: empty even on a successful rejection.
pytestmark = pytest.mark.django_db(transaction=True)


class TestCaptureCustomerRejection:
    def test_flips_status_and_stamps_reason(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        # Wire a sales person so the rejection notification has
        # somewhere to land. Reuses the org creator to keep the
        # fixture light.
        proposal.sales_person = proposal.organization.created_by
        proposal.save(update_fields=["sales_person"])

        updated = capture_customer_rejection_on_proposal(
            proposal=proposal,
            reason="Pricing came in higher than expected; resending next quarter.",
        )

        assert updated.status == ProposalStatus.REJECTED.value
        assert updated.customer_rejected_at is not None
        assert "higher than expected" in updated.customer_rejection_reason
        # Status-transition row written so the timeline reflects the
        # rejection.
        assert ProposalStatusTransition.objects.filter(
            proposal=updated,
            from_status=ProposalStatus.SENT.value,
            to_status=ProposalStatus.REJECTED.value,
        ).exists()
        # Sales person notified after commit (locmem backend captures
        # ``transaction.on_commit`` callbacks once the test's atomic
        # block exits via the pytest-django wrapper).
        assert len(mailoutbox) == 1
        sent = mailoutbox[0]
        assert "declined" in sent.subject.lower()
        assert proposal.organization.created_by.email in sent.to

    def test_empty_reason_allowed(self, settings, mailoutbox) -> None:
        # Customers don't have to explain why they declined — an empty
        # reason still produces a clean rejection + email notification.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        proposal.sales_person = proposal.organization.created_by
        proposal.save(update_fields=["sales_person"])

        updated = capture_customer_rejection_on_proposal(
            proposal=proposal,
            reason="",
        )

        assert updated.status == ProposalStatus.REJECTED.value
        assert updated.customer_rejection_reason == ""
        assert len(mailoutbox) == 1

    def test_cannot_reject_a_non_sent_proposal(self) -> None:
        # The state machine only permits ``sent → rejected``. A draft
        # proposal can't be customer-declined — the customer hasn't
        # even seen it yet.
        proposal = ProposalFactory(status=ProposalStatus.DRAFT.value)
        with pytest.raises(InvalidProposalTransition):
            capture_customer_rejection_on_proposal(
                proposal=proposal, reason="too soon"
            )
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.DRAFT.value

    def test_cannot_reject_an_already_accepted_proposal(self) -> None:
        # Accepted = deal closed. Trying to reject it after the fact
        # would corrupt the audit trail.
        proposal = ProposalFactory(status=ProposalStatus.ACCEPTED.value)
        with pytest.raises(InvalidProposalTransition):
            capture_customer_rejection_on_proposal(
                proposal=proposal, reason=""
            )
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.ACCEPTED.value

    def test_no_email_when_sales_person_missing(
        self, settings, mailoutbox
    ) -> None:
        # If neither the proposal nor its parent project has a sales
        # person wired, the rejection still commits — the email is
        # best-effort. The audit trail stays the source of truth.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        # ``ProposalFactory`` doesn't seed ``sales_person`` by
        # default, and the parent formulation's ``sales_person`` is
        # also empty on the factory chain.
        assert proposal.sales_person is None

        updated = capture_customer_rejection_on_proposal(
            proposal=proposal, reason="no sales rep configured"
        )
        assert updated.status == ProposalStatus.REJECTED.value
        assert mailoutbox == []
