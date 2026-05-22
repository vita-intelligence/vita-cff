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


# ---------------------------------------------------------------------------
# Spec status revert on rejection
# ---------------------------------------------------------------------------


class TestSpecRevertOnRejection:
    """When a proposal is rejected, attached specs that were promoted
    to ``SENT`` must drop back to ``APPROVED`` so the team can spawn a
    fresh proposal. Without this revert the project gets stuck — the
    proposal builder gates new proposals on ``APPROVED`` specs only.
    """

    @staticmethod
    def _proposal_with_sent_spec():
        from apps.proposals.models import Proposal
        from apps.proposals.services import (
            _promote_attached_specs_to_sent,
        )
        from apps.specifications.models import (
            SpecificationSheet, SpecificationStatus,
        )

        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        # Build an APPROVED spec on the same project, attach via the
        # legacy single-spec FK, then run the promotion helper so the
        # spec lands at ``SENT`` exactly the way send_proposal_to_client
        # would have done.
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )
        sheet = SpecificationSheetFactory(
            organization=proposal.organization,
            formulation_version=proposal.formulation_version,
            status=SpecificationStatus.APPROVED,
        )
        proposal.specification_sheet = sheet
        proposal.save(update_fields=["specification_sheet"])
        _promote_attached_specs_to_sent(
            proposal=proposal, actor=proposal.organization.created_by,
        )
        sheet.refresh_from_db()
        assert sheet.status == SpecificationStatus.SENT
        return proposal, sheet

    def test_kiosk_reject_reverts_sent_spec_to_approved(
        self, settings, mailoutbox,
    ) -> None:
        from apps.specifications.models import SpecificationStatus

        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal, sheet = self._proposal_with_sent_spec()
        proposal.sales_person = proposal.organization.created_by
        proposal.save(update_fields=["sales_person"])

        capture_customer_rejection_on_proposal(
            proposal=proposal, reason="not for us this quarter",
        )

        sheet.refresh_from_db()
        assert sheet.status == SpecificationStatus.APPROVED

    def test_staff_manual_reject_reverts_sent_spec_to_approved(
        self,
    ) -> None:
        from apps.proposals.services import transition_status
        from apps.specifications.models import SpecificationStatus

        proposal, sheet = self._proposal_with_sent_spec()

        transition_status(
            proposal=proposal,
            actor=proposal.organization.created_by,
            to_status=ProposalStatus.REJECTED.value,
            notes="customer told us by phone",
        )

        sheet.refresh_from_db()
        assert sheet.status == SpecificationStatus.APPROVED

    def test_accepted_spec_not_touched_by_rejection(
        self, settings, mailoutbox,
    ) -> None:
        # A signed spec is legally binding — even if the proposal it
        # rides on later gets rejected (weird but theoretically
        # possible), the spec status stays at ACCEPTED.
        from apps.specifications.models import SpecificationStatus

        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal, sheet = self._proposal_with_sent_spec()
        proposal.sales_person = proposal.organization.created_by
        proposal.save(update_fields=["sales_person"])
        sheet.status = SpecificationStatus.ACCEPTED
        sheet.save(update_fields=["status"])

        capture_customer_rejection_on_proposal(
            proposal=proposal, reason="x",
        )

        sheet.refresh_from_db()
        assert sheet.status == SpecificationStatus.ACCEPTED

    def test_spec_in_flight_on_another_proposal_stays_sent(
        self,
    ) -> None:
        # The conservative branch: the spec rides BOTH the rejected
        # proposal AND a parallel still-live proposal. Reverting it
        # would yank the rug from the sibling deal. Leave it at SENT.
        #
        # ``Proposal.specification_sheet`` is a OneToOne so the
        # sibling proposal attaches the same spec via ``ProposalLine``
        # — the modern multi-spec path the canonical helper prefers.
        from apps.proposals.services import transition_status
        from apps.proposals.models import ProposalLine
        from apps.specifications.models import SpecificationStatus

        proposal_a, sheet = self._proposal_with_sent_spec()
        proposal_b = ProposalFactory(
            organization=proposal_a.organization,
            formulation_version=proposal_a.formulation_version,
            status=ProposalStatus.SENT.value,
        )
        ProposalLine.objects.create(
            proposal=proposal_b,
            formulation_version=proposal_b.formulation_version,
            specification_sheet=sheet,
            product_code="L-1",
            description="sibling line",
            quantity=1,
            unit_price="10.00",
            display_order=0,
        )

        transition_status(
            proposal=proposal_a,
            actor=proposal_a.organization.created_by,
            to_status=ProposalStatus.REJECTED.value,
            notes="dead",
        )

        sheet.refresh_from_db()
        # Sibling deal protected.
        assert sheet.status == SpecificationStatus.SENT


# ---------------------------------------------------------------------------
# Customer back-fill on proposal create
# ---------------------------------------------------------------------------


class TestCustomerBackfillOnCreate:
    """When a proposal is created with values the linked customer
    record was missing, the customer's empty fields get patched
    from the proposal. Address-book is the source of truth ONCE set,
    so non-empty fields never get overwritten.
    """

    def test_creates_backfill_empty_customer_fields(self) -> None:
        # Build a customer with everything blank, then create a
        # proposal that carries values for all four contact fields.
        # After create, the customer should be patched with whatever
        # the proposal carried.
        from apps.customers.models import Customer
        from apps.formulations.tests.factories import FormulationFactory
        from apps.formulations.services import save_version
        from apps.organizations.tests.factories import OrganizationFactory
        from apps.proposals.services import create_proposal

        org = OrganizationFactory()
        actor = org.created_by
        customer = Customer.objects.create(
            organization=org,
            name="Backfill Buyer",
            company="Backfill Co",
            email="",
            phone="",
            invoice_address="",
            delivery_address="",
            created_by=actor,
            updated_by=actor,
        )
        formulation = FormulationFactory(organization=org)
        version = save_version(formulation=formulation, actor=actor)
        # Required by ``create_proposal`` — the version pointer must
        # match the formulation's approved version (i.e. a director
        # has signed off on this snapshot via a spec sheet).
        formulation.approved_version_number = version.version_number
        formulation.save(update_fields=["approved_version_number"])

        create_proposal(
            organization=org,
            actor=actor,
            formulation_version_id=version.id,
            customer_id=customer.id,
            customer_email="alex@buyer.test",
            customer_phone="+44 0000",
            invoice_address="1 Invoice Lane",
            delivery_address="1 Delivery Lane",
            currency="GBP",
        )

        customer.refresh_from_db()
        assert customer.email == "alex@buyer.test"
        assert customer.phone == "+44 0000"
        assert customer.invoice_address == "1 Invoice Lane"
        assert customer.delivery_address == "1 Delivery Lane"

    def test_create_does_not_overwrite_existing_customer_fields(
        self,
    ) -> None:
        # If the customer already has a value, the proposal's
        # different value MUST NOT overwrite it — the address book
        # stays authoritative.
        from apps.customers.models import Customer
        from apps.formulations.tests.factories import FormulationFactory
        from apps.formulations.services import save_version
        from apps.organizations.tests.factories import OrganizationFactory
        from apps.proposals.services import create_proposal

        org = OrganizationFactory()
        actor = org.created_by
        customer = Customer.objects.create(
            organization=org,
            name="Canonical Buyer",
            company="Canonical Co",
            email="canonical@buyer.test",
            phone="+44 9999",
            invoice_address="Canonical HQ",
            delivery_address="Canonical Warehouse",
            created_by=actor,
            updated_by=actor,
        )
        formulation = FormulationFactory(organization=org)
        version = save_version(formulation=formulation, actor=actor)
        formulation.approved_version_number = version.version_number
        formulation.save(update_fields=["approved_version_number"])

        # The create call's customer_* args silently fall back to the
        # customer's existing values inside the service (because
        # `customer_email or customer.email` resolves to the existing
        # one when the arg is blank), so providing different values
        # here would actually land on the proposal. We verify the
        # opposite direction: the address book stays untouched.
        create_proposal(
            organization=org,
            actor=actor,
            formulation_version_id=version.id,
            customer_id=customer.id,
            customer_email="alt@buyer.test",
            customer_phone="+44 1111",
            invoice_address="Alt HQ",
            delivery_address="Alt Warehouse",
            currency="GBP",
        )

        customer.refresh_from_db()
        assert customer.email == "canonical@buyer.test"
        assert customer.phone == "+44 9999"
        assert customer.invoice_address == "Canonical HQ"
        assert customer.delivery_address == "Canonical Warehouse"
