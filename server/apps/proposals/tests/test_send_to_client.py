"""Tests for the atomic "email + flip-to-sent" service.

The whole point of the new endpoint is the atomicity: either the
customer email goes out AND the proposal moves to ``sent``, or
neither happens. Each of these tests pins one half of that
invariant so a future refactor can't quietly break it.
"""

from __future__ import annotations

import uuid
from unittest import mock

import pytest
from django.core import mail

from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    InvalidProposalTransition,
    ProposalEmailRecipientRequired,
    ProposalEmailSendFailed,
    send_proposal_to_client,
)
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


def _approved_proposal(**kwargs):
    """Build a proposal at ``approved`` with the minimum data the
    ``approved → sent`` transition's required-fields gate needs.

    Adds one priced line + a sales-person assignment because both
    are required for the transition to validate. Without them the
    transition raises ``MissingRequiredFields`` before the email
    layer even runs.
    """

    defaults: dict = {
        "status": ProposalStatus.APPROVED.value,
        "customer_name": "Alex Buyer",
        "customer_email": "alex@buyer.test",
        "customer_company": "Buyer Ltd",
        "customer_phone": "+44 0000",
        "invoice_address": "1 Buyer Street",
        "delivery_address": "1 Buyer Street",
        "dear_name": "Alex",
        "reference": "REF-001",
        "currency": "GBP",
        "quantity": 1,
    }
    defaults.update(kwargs)
    proposal = ProposalFactory(**defaults)
    # Sales person + a priced line so the approved→sent gate passes.
    proposal.sales_person = proposal.organization.created_by
    # The real flow mints ``public_token`` when the proposal hits
    # ``approved`` (auto-rotation inside ``transition_status``); the
    # factory bypasses that path so we mint one here. Without it the
    # email template skips the "Open proposal" button entirely.
    proposal.public_token = uuid.uuid4()
    proposal.save(update_fields=["sales_person", "public_token"])
    proposal.lines.create(
        formulation_version=proposal.formulation_version,
        product_code="LINE-001",
        description="Test line",
        quantity=1,
        unit_price="10.00",
        display_order=0,
    )
    return proposal


class TestSendProposalToClient:
    def test_success_sends_email_and_flips_status(
        self, settings, mailoutbox
    ) -> None:
        # Use the locmem backend the Django test runner ships so
        # ``mailoutbox`` captures the message without touching SMTP.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        updated = send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="Your proposal",
            body_text="Hi Alex,\n\nPlease review.",
        )

        # Email went out — locmem backend captures it in mailoutbox.
        assert len(mailoutbox) == 1
        sent = mailoutbox[0]
        assert sent.to == ["alex@buyer.test"]
        assert sent.subject == "Your proposal"
        assert "Hi Alex" in sent.body  # plain-text body
        # HTML alternative attached with the branded wrapper.
        assert any(
            alt[1] == "text/html" and "Open proposal" in alt[0]
            for alt in sent.alternatives
        )
        # Status flipped atomically.
        assert updated.status == ProposalStatus.SENT.value

    def test_smtp_failure_keeps_proposal_at_approved(
        self, settings, mailoutbox
    ) -> None:
        # Force the email layer to raise; the service must roll back
        # so the proposal sits at ``approved`` and a retry from the
        # modal lands on a fresh attempt.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        with mock.patch(
            "django.core.mail.EmailMultiAlternatives.send",
            side_effect=ConnectionError("smtp boom"),
        ):
            with pytest.raises(ProposalEmailSendFailed):
                send_proposal_to_client(
                    proposal=proposal,
                    actor=proposal.organization.created_by,
                    recipient="alex@buyer.test",
                    subject="Hi",
                    body_text="body",
                )

        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.APPROVED.value
        # Nothing in mailoutbox because the mocked ``send`` raised
        # before the locmem backend recorded anything.
        assert mailoutbox == []

    def test_empty_recipient_rejected(self) -> None:
        proposal = _approved_proposal(customer_email="")

        with pytest.raises(ProposalEmailRecipientRequired):
            send_proposal_to_client(
                proposal=proposal,
                actor=proposal.organization.created_by,
                recipient="   ",  # whitespace-only — still empty
                subject="Hi",
                body_text="body",
            )

        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.APPROVED.value

    def test_non_approved_proposal_is_rejected(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        # A draft proposal must not be sendable — the state machine
        # only allows ``approved → sent``.
        proposal = _approved_proposal(status=ProposalStatus.DRAFT.value)

        with pytest.raises(InvalidProposalTransition):
            send_proposal_to_client(
                proposal=proposal,
                actor=proposal.organization.created_by,
                recipient="alex@buyer.test",
                subject="Hi",
                body_text="body",
            )
        assert mailoutbox == []

    def test_auto_bccs_sales_person(
        self, settings, mailoutbox
    ) -> None:
        # The assigned sales person is auto-added to BCC so they
        # always have a record of customer-facing sends. BCC (not
        # CC) so the customer doesn't see internal addresses; the
        # Reply-To header still routes any reply back to them.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="x",
            body_text="y",
        )
        sales_email = proposal.organization.created_by.email
        sent = mailoutbox[0]
        assert sales_email in sent.bcc
        # The customer-facing ``To`` line stays clean — only the
        # actual recipient appears, no internal addresses leaked.
        assert sent.to == ["alex@buyer.test"]

    def test_auto_bcc_skipped_when_sales_person_is_recipient(
        self, settings, mailoutbox
    ) -> None:
        # Edge case: the operator is sending the email to themselves
        # (e.g. they're both the assigned sales person AND the test
        # recipient). The auto-BCC should drop in that case so the
        # mailbox doesn't double-deliver.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()
        sales_email = proposal.organization.created_by.email

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient=sales_email,
            subject="x",
            body_text="y",
        )
        sent = mailoutbox[0]
        assert sent.bcc == []

    def test_reply_to_points_at_sales_person(
        self, settings, mailoutbox
    ) -> None:
        # Reply-To carries the sales person's address so the customer
        # reaches a human if they hit Reply, even though the From
        # header has to stay on the DMARC-aligned domain. Corporate
        # spam filters score a missing Reply-To as low-trust, so we
        # always populate it.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="x",
            body_text="y",
        )
        assert len(mailoutbox) == 1
        sent = mailoutbox[0]
        sales_email = proposal.organization.created_by.email
        # ``reply_to`` may be ``"Name <addr>"`` formatted; assert
        # the bare address appears.
        assert sent.reply_to, "Reply-To should be set"
        assert any(sales_email in addr for addr in sent.reply_to)

    def test_plain_text_body_includes_kiosk_url(
        self, settings, mailoutbox
    ) -> None:
        # Plain-text fallback must carry the kiosk URL on its own
        # line so corporate gateways that strip HTML (and Outlook
        # policies that render plain-text only) still leak a usable
        # link to the customer.
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="x",
            body_text="Hi Alex,\n\nPlease review.",
        )
        plain = mailoutbox[0].body
        assert "Hi Alex" in plain  # typed body preserved
        assert f"/p/proposal/{proposal.public_token}" in plain
        assert proposal.code in plain

    def test_default_subject_used_when_blank(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="   ",  # whitespace-only → fall back
            body_text="body",
        )

        assert len(mailoutbox) == 1
        assert mailoutbox[0].subject == f"Your proposal from Vita NPD — {proposal.code}"


class TestSendProposalTestEmail:
    def test_sends_preview_without_changing_status(
        self, settings, mailoutbox
    ) -> None:
        # The test endpoint runs the same render path but must NOT
        # advance the proposal — the whole point is that sales can
        # eyeball the layout in their own inbox without committing.
        from apps.proposals.services import send_proposal_test_email

        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()
        original_status = proposal.status

        subject = send_proposal_test_email(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="me@vita.test",
            subject="Custom test subject",
            body_text="Preview body",
        )

        assert len(mailoutbox) == 1
        assert mailoutbox[0].to == ["me@vita.test"]
        assert mailoutbox[0].subject == "Custom test subject"
        assert subject == "Custom test subject"
        # HTML alternative attached — same template as the real send.
        assert any(
            alt[1] == "text/html" and "Open proposal" in alt[0]
            for alt in mailoutbox[0].alternatives
        )

        proposal.refresh_from_db()
        assert proposal.status == original_status

    def test_works_on_draft_proposals_too(
        self, settings, mailoutbox
    ) -> None:
        # No status gate on the test path — sales can preview while
        # the proposal is still being drafted.
        from apps.proposals.services import send_proposal_test_email

        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal(status=ProposalStatus.DRAFT.value)

        send_proposal_test_email(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="me@vita.test",
            subject="x",
            body_text="y",
        )
        assert len(mailoutbox) == 1
        proposal.refresh_from_db()
        assert proposal.status == ProposalStatus.DRAFT.value

    def test_empty_recipient_rejected(self) -> None:
        from apps.proposals.services import send_proposal_test_email

        proposal = _approved_proposal()
        with pytest.raises(ProposalEmailRecipientRequired):
            send_proposal_test_email(
                proposal=proposal,
                actor=proposal.organization.created_by,
                recipient="  ",
                subject="x",
                body_text="y",
            )
