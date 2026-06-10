"""Email senders for the client portal.

Every sender here is a thin adapter that gathers the dynamic fields
(recipient, code, link, customer company) and hands them off to
:func:`config.email_layout.render_email`. Doing it that way keeps the
bulletproof markup — Outlook-safe tables, MSO conditionals, inline
styles + attribute fallbacks — in one place; the per-flow copy is what
lives here. Mailpit's ``html-check`` scores stay high (≥95% Supported
across the caniemail dataset) for the same reason.

All flows use Django's ``send`` via ``EmailMultiAlternatives`` so the
backend choice (SMTP in prod, console / mailpit in dev) remains the
single toggle that decides where mail actually goes.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives

from config.email_layout import EmailCTA, EmailCode, render_email

logger = logging.getLogger(__name__)


def _app_base_url() -> str:
    """Return the configured frontend URL (no trailing slash)."""

    base = getattr(settings, "APP_BASE_URL", "") or ""
    return base.rstrip("/")


def _send(*, to_email: str, subject: str, html: str, text: str) -> None:
    """Single chokepoint for the actual SMTP dispatch.

    Centralising the construction here means a future change to the
    ``From`` envelope, headers, or reply-to address lands in one
    file rather than six.
    """

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)


def _greeting(customer_company: str) -> str:
    """Personalised opener used at the top of every customer email."""

    if customer_company:
        return f"Hi {customer_company},"
    return "Hi,"


def send_portal_activation_email(
    *,
    to_email: str,
    customer_company: str,
    proposal_code: str,
    public_token: str,
) -> None:
    """Send the kiosk-email replacement — "Open the portal to review
    your proposal".

    The CTA points at ``<APP_BASE_URL>/portal/activate/<public_token>``.
    Whether the customer is a first-time visitor or a returner is
    decided server-side by the activation page, so the copy stays the
    same across both paths.
    """

    if not to_email:
        logger.warning(
            "portal.activation_email: skipped — no recipient address.",
        )
        return

    base = _app_base_url() or "https://npd.vitaintelligent.com"
    activation_url = f"{base}/portal/activate/{public_token}"
    subject = f"Vita NPD — review proposal {proposal_code}".strip()

    intro_html = (
        f"<p style=\"margin-top:0;margin-bottom:0;\">{_greeting(customer_company)}</p>"
        f"<p style=\"margin-top:12px;margin-bottom:0;\">Your proposal "
        f"<b>{proposal_code}</b> from Vita is ready to review.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader=(
            f"Open the portal to read, sign, or comment on proposal "
            f"{proposal_code}."
        ),
        heading="Your proposal is ready",
        intro_html=intro_html,
        cta=EmailCTA(label="Open your account", url=activation_url),
        outro=(
            "First time? You will be asked to set a password. "
            "Returning? You will be taken straight to the sign-in page."
        ),
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)


def send_email_change_code(
    *,
    to_email: str,
    code: str,
) -> None:
    """Send the 6-digit code that confirms an email-change request.

    The code is mailed to the **new** address — proving the customer
    actually controls it before we flip their login over.
    """

    if not to_email:
        return

    subject = "Vita NPD — confirm your new email"
    intro_html = (
        "<p style=\"margin-top:0;margin-bottom:0;\">Your code to confirm "
        "this new email on your Vita portal account is below.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader="Enter the code on the settings page to confirm the change.",
        heading="Confirm your new email",
        intro_html=intro_html,
        code=EmailCode(code),
        outro=(
            "Enter it on the settings page within the next 30 minutes. "
            "If you didn't request this, ignore the email — your account "
            "stays on its current address."
        ),
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)


def send_portal_invite_email(
    *,
    to_email: str,
    code: str,
    customer_company: str = "",
) -> None:
    """Send the 6-digit verification code for a customer-portal invite.

    Only the *code* is mailed here, not a clickable link — the staff
    member shares the URL by hand. Receiving this email is what
    proves to us the customer actually controls the address on file.
    """

    if not to_email:
        logger.warning(
            "portal.invite_email: skipped — no recipient address.",
        )
        return

    subject = "Vita NPD — your portal activation code"
    intro_html = (
        f"<p style=\"margin-top:0;margin-bottom:0;\">{_greeting(customer_company)}</p>"
        "<p style=\"margin-top:12px;margin-bottom:0;\">Your team at Vita "
        "has issued a portal invite for you. Open the link they shared "
        "and enter this 6-digit code to finish setting up your account.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader="Enter the 6-digit code on the activation page.",
        heading="Activate your portal account",
        intro_html=intro_html,
        code=EmailCode(code),
        outro=(
            "The code expires in 7 days. If you didn't expect this email, "
            "you can safely ignore it."
        ),
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)


def send_proposal_activation_code_email(
    *,
    to_email: str,
    code: str,
    proposal_code: str,
    customer_company: str = "",
) -> None:
    """Send the just-in-time 6-digit activation code for a proposal.

    Standalone OTP email — no link, no cover letter, no other CTA.
    Sent by :func:`apps.client_portal.services.request_activation_code`
    each time the customer hits "Send code" or "Resend" on the
    activation page (rate-limited to one every 60s, with a 10-minute
    TTL on the code itself).
    """

    if not to_email:
        logger.warning(
            "portal.activation_code_email: skipped — no recipient address.",
        )
        return

    subject = f"Your Vita Manufacture verification code · {code}"
    intro_html = (
        f"<p style=\"margin-top:0;margin-bottom:0;\">{_greeting(customer_company)}</p>"
        f"<p style=\"margin-top:12px;margin-bottom:0;\">Your 6-digit "
        f"verification code for proposal <b>{proposal_code}</b> is "
        "below.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader="Enter the code on the activation page to continue.",
        heading="Confirm your email",
        intro_html=intro_html,
        code=EmailCode(code),
        outro=(
            "Enter it on the activation page within the next 10 minutes. "
            "If you didn't request this, ignore the email — the code is "
            "useless without the activation link."
        ),
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)


def send_portal_registration_code_email(
    *,
    to_email: str,
    code: str,
    customer_company: str = "",
) -> None:
    """Send the 6-digit verification code for a self-registration.

    Sibling to :func:`send_portal_invite_email` but the trigger is
    reversed: the customer initiated the registration on the portal,
    so the copy welcomes them in rather than referencing a staff
    invite.
    """

    if not to_email:
        logger.warning(
            "portal.registration_code_email: skipped — no recipient address.",
        )
        return

    subject = f"Your Vita Manufacture portal code · {code}"
    intro_html = (
        f"<p style=\"margin-top:0;margin-bottom:0;\">{_greeting(customer_company)}</p>"
        "<p style=\"margin-top:12px;margin-bottom:0;\">Thanks for signing "
        "up to the Vita Manufacture customer portal. Your 6-digit "
        "confirmation code is below — enter it on the registration page "
        "to finish setting up your account.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader="Enter the code to finish setting up your portal account.",
        heading="Confirm your email",
        intro_html=intro_html,
        code=EmailCode(code),
        outro=(
            "The code expires in 10 minutes. If you didn't request this, "
            "ignore the email — the code is useless without the open "
            "registration tab."
        ),
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)


def send_portal_password_reset_email(
    *,
    to_email: str,
    plaintext_token: str,
) -> None:
    """Send the forgot-password reset link.

    Aimed at ``<APP_BASE_URL>/portal/reset/<token>``. Mirror of the
    staff side (:mod:`apps.accounts.email`) but branded for the
    customer surface.
    """

    if not to_email:
        return

    base = _app_base_url() or "https://npd.vitaintelligent.com"
    reset_url = f"{base}/portal/reset/{plaintext_token}"
    subject = "Vita NPD — reset your portal password"
    intro_html = (
        "<p style=\"margin-top:0;margin-bottom:0;\">Use the button below "
        "to set a new password for your Vita portal account. The link "
        "expires in 30 minutes.</p>"
    )
    html, text = render_email(
        subject=subject,
        preheader="Reset your Vita portal password — link valid for 30 min.",
        heading="Reset your password",
        intro_html=intro_html,
        cta=EmailCTA(label="Reset password", url=reset_url),
        outro="If you didn't request this, ignore this email.",
    )
    _send(to_email=to_email, subject=subject, html=html, text=text)
