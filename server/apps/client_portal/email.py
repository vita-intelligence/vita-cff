"""Email senders for the client portal.

Two surfaces:

* :func:`send_portal_activation_email` — the kiosk-email rewrite.
  Used when a proposal is sent for the first time (or re-sent after
  a customer email update). Brutalist plain-HTML body, CTA points
  at ``<APP_BASE_URL>/portal/activate/<public_token>``.
* :func:`send_portal_password_reset_email` — forgot-password flow.
  Mirrors :func:`apps.accounts.email.send_password_reset_email` but
  branded for the client side and aimed at ``/portal/reset/<token>``.

Both use Django's ``send_mail`` rather than EmailMessage so the
backend choice (SMTP in prod, console in dev) remains the single
toggle that decides where mail actually goes.
"""

from __future__ import annotations

import logging

from django.conf import settings
from django.core.mail import EmailMultiAlternatives

logger = logging.getLogger(__name__)


def _app_base_url() -> str:
    """Return the configured frontend URL (no trailing slash)."""

    base = getattr(settings, "APP_BASE_URL", "") or ""
    return base.rstrip("/")


def send_portal_activation_email(
    *,
    to_email: str,
    customer_company: str,
    proposal_code: str,
    public_token: str,
) -> None:
    """Send the kiosk-email replacement — "Set up your account to
    review your proposal".

    The link is ``<APP_BASE_URL>/portal/activate/<public_token>``.
    Whether the customer is a first-time visitor or a returner is
    decided server-side by the activation page, so the copy stays
    the same across both paths (it just says "Sign in or set up
    your account").
    """

    if not to_email:
        logger.warning(
            "portal.activation_email: skipped — no recipient address.",
        )
        return

    base = _app_base_url() or "https://npd.vitaintelligent.com"
    activation_url = f"{base}/portal/activate/{public_token}"
    subject = f"Vita NPD — review proposal {proposal_code}".strip()
    company_line = (
        f"Hi {customer_company},"
        if customer_company
        else "Hi,"
    )
    text = (
        f"{company_line}\n\n"
        f"Your proposal {proposal_code} from Vita is ready to review.\n\n"
        f"Open your account to read, sign, or comment:\n"
        f"{activation_url}\n\n"
        "First time? You'll be asked to set a password. Returning?\n"
        "You'll be taken straight to the sign-in page.\n\n"
        "— The Vita team\n"
    )
    html = (
        '<div style="font-family: ui-sans-serif, system-ui, sans-serif; '
        'color: #000; background: #fff; padding: 24px;">'
        f'<p style="font-size: 14px; line-height: 1.5;">{company_line}</p>'
        '<p style="font-size: 14px; line-height: 1.5;">'
        f'Your proposal <strong>{proposal_code}</strong> from Vita is '
        'ready to review.</p>'
        f'<p style="margin: 24px 0;">'
        f'<a href="{activation_url}" '
        'style="display: inline-block; background: #000; color: #fff; '
        'padding: 12px 24px; font-weight: 700; text-decoration: none; '
        'border: 2px solid #000; box-shadow: 6px 6px 0 #000;">'
        'Open your account →</a></p>'
        '<p style="font-size: 12px; line-height: 1.5; color: #555;">'
        'First time? You will be asked to set a password. Returning? '
        'You will be taken straight to the sign-in page.</p>'
        '<p style="font-size: 12px; color: #555;">— The Vita team</p>'
        "</div>"
    )

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)


def send_email_change_code(
    *,
    to_email: str,
    code: str,
) -> None:
    """Send the 6-digit code that confirms an email-change request.

    The code is mailed to the **new** address — proving the
    customer actually controls it before we flip their login over.
    """

    if not to_email:
        return

    subject = "Vita NPD — confirm your new email"
    text = (
        "Hi,\n\n"
        "Your code to confirm this new email on your Vita portal\n"
        "account is:\n\n"
        f"  {code}\n\n"
        "Enter it on the settings page within the next 30 minutes.\n"
        "If you didn't request this, ignore the email — your account\n"
        "stays on its current address.\n\n"
        "— The Vita team\n"
    )
    html = (
        '<div style="font-family: ui-sans-serif, system-ui, sans-serif; '
        'color: #000; background: #fff; padding: 24px;">'
        '<p style="font-size: 14px; line-height: 1.5;">Hi,</p>'
        '<p style="font-size: 14px; line-height: 1.5;">'
        "Your code to confirm this new email on your Vita portal "
        "account is:</p>"
        '<div style="margin: 24px 0; padding: 14px 28px; border: 2px solid #000; '
        'display: inline-block; font-family: \'Courier New\', monospace; '
        f'font-size: 26px; letter-spacing: 0.5em; font-weight: 700;">{code}</div>'
        '<p style="font-size: 12px; line-height: 1.5; color: #555;">'
        "Enter it on the settings page within the next 30 minutes. "
        "If you didn't request this, ignore the email — your account "
        "stays on its current address.</p>"
        '<p style="font-size: 12px; color: #555;">— The Vita team</p>'
        "</div>"
    )

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)


def send_portal_invite_email(
    *,
    to_email: str,
    code: str,
    customer_company: str = "",
) -> None:
    """Send the 6-digit verification code for a customer-portal invite.

    Sibling to :func:`send_portal_activation_email` but for the
    customers-page-issued flow: only the *code* is mailed here, not
    a clickable link, because the staff member shares the URL by
    hand. Receiving this email is what proves to us the customer
    actually controls the address on file.
    """

    if not to_email:
        logger.warning(
            "portal.invite_email: skipped — no recipient address.",
        )
        return

    subject = "Vita NPD — your portal activation code"
    company_line = (
        f"Hi {customer_company},"
        if customer_company
        else "Hi,"
    )
    text = (
        f"{company_line}\n\n"
        "Your team at Vita has issued a portal invite for you.\n"
        "Open the link they shared and enter this 6-digit code\n"
        "to finish setting up your account:\n\n"
        f"  {code}\n\n"
        "The code expires in 7 days. If you didn't expect this\n"
        "email, you can safely ignore it.\n\n"
        "— The Vita team\n"
    )
    html = (
        '<div style="font-family: ui-sans-serif, system-ui, sans-serif; '
        'color: #000; background: #fff; padding: 24px;">'
        f'<p style="font-size: 14px; line-height: 1.5;">{company_line}</p>'
        '<p style="font-size: 14px; line-height: 1.5;">'
        "Your team at Vita has issued a portal invite for you. Open the "
        "link they shared and enter this 6-digit code to finish setting "
        "up your account:</p>"
        '<div style="margin: 24px 0; padding: 14px 28px; border: 2px solid #000; '
        'display: inline-block; font-family: \'Courier New\', monospace; '
        f'font-size: 26px; letter-spacing: 0.5em; font-weight: 700;">{code}</div>'
        '<p style="font-size: 12px; line-height: 1.5; color: #555;">'
        "The code expires in 7 days. If you didn't expect this email, "
        "you can safely ignore it.</p>"
        '<p style="font-size: 12px; color: #555;">— The Vita team</p>'
        "</div>"
    )

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)


def send_portal_password_reset_email(
    *,
    to_email: str,
    plaintext_token: str,
) -> None:
    if not to_email:
        return

    base = _app_base_url() or "https://npd.vitaintelligent.com"
    reset_url = f"{base}/portal/reset/{plaintext_token}"
    subject = "Vita NPD — reset your portal password"
    text = (
        "Hi,\n\n"
        "Use the link below to set a new password for your Vita portal "
        "account. The link expires in 30 minutes.\n\n"
        f"{reset_url}\n\n"
        "If you didn't request this, ignore this email.\n\n"
        "— The Vita team\n"
    )
    html = (
        '<div style="font-family: ui-sans-serif, system-ui, sans-serif; '
        'color: #000; background: #fff; padding: 24px;">'
        '<p style="font-size: 14px; line-height: 1.5;">Hi,</p>'
        '<p style="font-size: 14px; line-height: 1.5;">'
        'Use the link below to set a new password for your Vita portal '
        'account. The link expires in 30 minutes.</p>'
        f'<p style="margin: 24px 0;">'
        f'<a href="{reset_url}" '
        'style="display: inline-block; background: #000; color: #fff; '
        'padding: 12px 24px; font-weight: 700; text-decoration: none; '
        'border: 2px solid #000; box-shadow: 6px 6px 0 #000;">'
        'Reset password →</a></p>'
        '<p style="font-size: 12px; color: #555;">'
        "If you didn't request this, ignore this email."
        '</p>'
        "</div>"
    )

    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=settings.DEFAULT_FROM_EMAIL,
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)
