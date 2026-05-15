"""Transactional email senders for the accounts app.

Kept separate from :mod:`apps.accounts.services` so the service
module stays focused on token / password mechanics: the moment we
add MFA, change-email confirmation, or login-from-new-device alerts
those each get their own send_* function in this module.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

logger = logging.getLogger(__name__)


class PasswordResetEmailFailed(Exception):
    """Raised when the SMTP layer rejects the reset email.

    The request endpoint catches and *swallows* this so an outage
    of the email provider does not turn into an enumeration vector
    (a 500 on real emails + a 200 on bogus ones would let an
    attacker fingerprint registered addresses).
    """

    code = "password_reset_email_failed"


def _build_reset_url(plaintext_token: str) -> str:
    """Construct the front-end URL the recipient clicks to land on
    the reset page. We deliberately put the token in the path (not
    the query string) so it doesn't leak through Referer headers
    when the user navigates onward, and so corporate URL-rewriting
    proxies treat it as part of the resource identifier.
    """

    app_base = getattr(
        settings, "APP_BASE_URL", "http://localhost:3000"
    ).rstrip("/")
    return f"{app_base}/reset-password/{plaintext_token}"


def send_password_reset_email(
    *,
    user: Any,
    plaintext_token: str,
) -> None:
    """Send the customer-facing reset link.

    Outlook is the most aggressive consumer of the headers below;
    Gmail tolerates anything but rewards plain-text alternatives
    and a tight, transactional shape. Everything in this function
    is tuned for Microsoft delivery first because that is where
    real customers were landing in junk.

    The plaintext token must not be logged anywhere downstream of
    this call — once it is in the email body, the only legitimate
    copies are (a) the user's inbox and (b) the hashed row in the
    database. We pass it through as a function argument rather than
    fetching the row again so the contract is explicit at the
    call site.
    """

    recipient = (getattr(user, "email", "") or "").strip()
    if not recipient:
        # Defensive: the service layer enforces an active user with
        # a real email before calling this, but a bug upstream
        # shouldn't crash the request — the silent return preserves
        # enumeration safety.
        logger.warning(
            "send_password_reset_email called with empty recipient for user_id=%s",
            getattr(user, "id", None),
        )
        return

    from_email = getattr(
        settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
    )
    reset_url = _build_reset_url(plaintext_token)

    first_name = (getattr(user, "first_name", "") or "").strip()

    body_html = render_to_string(
        "accounts/email/password_reset.html",
        {
            "recipient_first_name": first_name,
            "reset_url": reset_url,
        },
    )

    # Plain-text alternative. Microsoft's content filter explicitly
    # rewards a meaningful text/plain part — HTML-only messages from
    # young domains land in junk by default. The body is mirrored
    # carefully so a recipient whose client renders only the text
    # part still gets a complete, parseable message.
    plain_body = "\n".join(
        [
            f"Hi{(' ' + first_name) if first_name else ''},",
            "",
            "We received a request to reset the password for your Vita NPD account.",
            "Open the link below to choose a new one — it expires in 30 minutes",
            "and can only be used once.",
            "",
            reset_url,
            "",
            "If you didn't ask for this, you can safely ignore this email —",
            "your password won't change unless someone clicks the link above",
            "and sets a new one.",
            "",
            "— Vita NPD account security",
        ]
    )

    subject = "Reset your Vita NPD password"

    message = EmailMultiAlternatives(
        subject=subject,
        body=plain_body,
        from_email=from_email,
        to=[recipient],
        headers={
            # ``Auto-Submitted`` is the RFC 3834 marker that tells
            # well-behaved servers (Exchange, Postfix, Sendmail)
            # this is system-generated mail and they should *not*
            # answer it with auto-replies / OOO bounces / vacation
            # responses.
            "Auto-Submitted": "auto-generated",
            # ``X-Auto-Response-Suppress`` is the Microsoft-specific
            # variant. We send both because Exchange honours one
            # and corporate Outlook policies sometimes honour the
            # other.
            "X-Auto-Response-Suppress": "All",
            # Pin both the request and any related future security
            # messages into a single Gmail conversation so the
            # recipient's inbox doesn't accumulate orphaned reset
            # rows when they retry.
            "X-Entity-Ref-ID": f"password-reset:{getattr(user, 'id', '')}",
            # Deliberately NO ``List-Unsubscribe`` header — that is
            # the bulk-mail marker. Outlook penalises transactional
            # mail that carries it because legitimate transactional
            # mail you cannot opt out of.
        },
    )
    message.attach_alternative(body_html, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 — wrapped as domain error
        logger.exception(
            "Password reset email failed for user_id=%s",
            getattr(user, "id", None),
        )
        raise PasswordResetEmailFailed(str(exc)) from exc
