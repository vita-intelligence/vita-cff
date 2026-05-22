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
        # Kiosk URL points at the portal activation page now —
        # see ``send_proposal_to_client`` where the URL is built
        # against ``/portal/activate/<token>`` so first-time
        # customers land on the password setup flow.
        assert f"/portal/activate/{proposal.public_token}" in plain
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
        assert mailoutbox[0].subject == (
            f"Your proposal from Vita Manufacture — {proposal.code}"
        )


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

    def test_does_not_auto_bcc_sales_person(
        self, settings, mailoutbox
    ) -> None:
        # Regression: an earlier version of the shared render helper
        # auto-BCC'd the sales person on every send — including test
        # previews. That caused the assigned sales rep to receive a
        # copy of every iteration their teammate did in the compose
        # modal. Test sends must land in the typed recipient's inbox
        # and nowhere else.
        from apps.proposals.services import send_proposal_test_email

        settings.EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
        proposal = _approved_proposal()

        send_proposal_test_email(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="me@vita.test",
            subject="x",
            body_text="y",
        )

        assert len(mailoutbox) == 1
        assert mailoutbox[0].to == ["me@vita.test"]
        # The whole point of the regression: zero CC and zero BCC on
        # the test path, no matter who the proposal's sales person is.
        assert not mailoutbox[0].cc
        assert not mailoutbox[0].bcc


# ---------------------------------------------------------------------------
# Customer email back-fill on send
# ---------------------------------------------------------------------------


class TestCustomerEmailBackfill:
    """Pin the back-fill rule: a successful send populates the
    linked Customer's empty ``email`` field with the recipient.

    The previous behaviour was that customers without an email on
    the address-book row could still receive a proposal (the
    proposal carried its own ``customer_email``), but downstream
    flows (portal invite, password reset, email-change confirmation)
    all read the address book and broke — customers complained
    they weren't "registered" even though they'd had email
    delivered to them. The back-fill closes that gap on the first
    successful send.
    """

    def test_backfills_empty_customer_email(
        self, settings, mailoutbox
    ) -> None:
        from apps.customers.models import Customer

        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _approved_proposal()
        actor = proposal.organization.created_by
        customer = Customer.objects.create(
            organization=proposal.organization,
            name="Backfill Buyer",
            company="Backfill Co",
            email="",  # the gap we're closing
            created_by=actor,
            updated_by=actor,
        )
        proposal.customer = customer
        proposal.save(update_fields=["customer"])

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="x",
            body_text="y",
        )

        customer.refresh_from_db()
        assert customer.email == "alex@buyer.test"

    def test_does_not_overwrite_existing_customer_email(
        self, settings, mailoutbox
    ) -> None:
        # When the customer already carries an email the address
        # book stays authoritative — sending to a different CC must
        # NOT silently rotate the record.
        from apps.customers.models import Customer

        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _approved_proposal()
        actor = proposal.organization.created_by
        customer = Customer.objects.create(
            organization=proposal.organization,
            name="Canonical Buyer",
            company="Canonical Co",
            email="canonical@buyer.test",
            created_by=actor,
            updated_by=actor,
        )
        proposal.customer = customer
        proposal.save(update_fields=["customer"])

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="different@buyer.test",
            subject="x",
            body_text="y",
        )

        customer.refresh_from_db()
        assert customer.email == "canonical@buyer.test"


# ---------------------------------------------------------------------------
# Proposal email no longer carries the activation code
# ---------------------------------------------------------------------------


class TestProposalEmailCodeRemoved:
    """The proposal-send email is now link-only.

    Activation codes are delivered just-in-time by a separate OTP
    email when the customer reaches the activation page (see
    :func:`apps.client_portal.services.request_activation_code`).
    A proposal send must:
      * NOT include a code in either HTML or plain-text bodies.
      * Reset any stale code on the proposal row so a resend
        forces the customer to request a fresh code.
    """

    def test_proposal_email_contains_no_code(
        self, settings, mailoutbox
    ) -> None:
        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _approved_proposal()

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="new@buyer.test",
            subject="x",
            body_text="y",
        )

        proposal.refresh_from_db()
        # No code persisted, no timestamp.
        assert proposal.activation_code == ""
        assert proposal.activation_code_sent_at is None
        # No code language anywhere in the email body.
        sent = mailoutbox[0]
        assert "6-digit" not in sent.body
        assert "activation code" not in sent.body
        html = next(
            alt[0] for alt in sent.alternatives if alt[1] == "text/html"
        )
        assert "activation code" not in html.lower()

    def test_resend_clears_prior_code(
        self, settings, mailoutbox
    ) -> None:
        # If a proposal has a stale code on the row (e.g. minted by
        # an earlier request-code call), resending the proposal
        # email must clear it so the customer starts fresh.
        from django.utils import timezone

        settings.EMAIL_BACKEND = (
            "django.core.mail.backends.locmem.EmailBackend"
        )
        proposal = _approved_proposal()
        proposal.activation_code = "999999"
        proposal.activation_code_sent_at = timezone.now()
        proposal.save(
            update_fields=[
                "activation_code", "activation_code_sent_at",
            ],
        )

        send_proposal_to_client(
            proposal=proposal,
            actor=proposal.organization.created_by,
            recipient="alex@buyer.test",
            subject="x",
            body_text="y",
        )

        proposal.refresh_from_db()
        assert proposal.activation_code == ""
        assert proposal.activation_code_sent_at is None
