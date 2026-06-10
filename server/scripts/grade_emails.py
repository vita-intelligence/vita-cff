"""Send every transactional email to Mailpit, then grade each via the
Mailpit ``html-check`` API and print a compatibility report.

Why this script: there's no automated way to know an email is going to
render across the long tail of inboxes (Outlook 2007 through Apple
Mail iOS) other than asking each engine, which Mailpit does via the
caniemail.com dataset. Sending each of our actual senders through the
real SMTP path (Mailpit on ``127.0.0.1:1025``) makes sure the markup
we land in production is the markup we graded — no shortcuts.

Usage::

    DJANGO_SETTINGS_MODULE=config.settings \\
        EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend \\
        EMAIL_HOST=127.0.0.1 EMAIL_PORT=1025 \\
        python scripts/grade_emails.py

The script clears the Mailpit inbox first so the grade reflects only
the messages it just sent. Exit code is 0 when every email scores
≥96% Supported and there are no Unsupported nodes; non-zero otherwise
so a CI hook can use it as a gate.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

# Bootstrap Django before any app imports.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
import django  # noqa: E402

django.setup()

from django.core.mail import EmailMultiAlternatives  # noqa: E402

MAILPIT_BASE = os.environ.get("MAILPIT_BASE", "http://127.0.0.1:8025")
MIN_SCORE = float(os.environ.get("MIN_SCORE", "95"))


def _post(path: str) -> None:
    req = urllib.request.Request(
        f"{MAILPIT_BASE}{path}", method="POST", data=b""
    )
    urllib.request.urlopen(req, timeout=5).read()


def _delete(path: str) -> None:
    req = urllib.request.Request(
        f"{MAILPIT_BASE}{path}", method="DELETE", data=b""
    )
    urllib.request.urlopen(req, timeout=5).read()


def _get(path: str) -> dict:
    with urllib.request.urlopen(
        f"{MAILPIT_BASE}{path}", timeout=10,
    ) as resp:
        return json.loads(resp.read())


def _clear_inbox() -> None:
    try:
        _delete("/api/v1/messages")
    except Exception as exc:  # noqa: BLE001
        print(f"warn: could not clear inbox: {exc}", file=sys.stderr)


def _wait_for_count(expected: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        info = _get("/api/v1/messages?limit=1")
        if info.get("total", 0) >= expected:
            return
        time.sleep(0.2)
    raise RuntimeError(
        f"timed out waiting for {expected} mailpit messages",
    )


def _grade(message_id: str) -> tuple[float, float, float, list[str]]:
    """Return (supported, partial, unsupported, warning_slugs)."""

    report = _get(f"/api/v1/message/{message_id}/html-check")
    total = report.get("Total", {})
    warnings = report.get("Warnings", []) or []
    slugs = [w.get("Slug", "?") for w in warnings]
    return (
        float(total.get("Supported", 0.0)),
        float(total.get("Partial", 0.0)),
        float(total.get("Unsupported", 0.0)),
        slugs,
    )


def _send_via_smtp(
    *,
    subject: str,
    text: str,
    html: str,
    to_email: str = "grader@example.com",
) -> None:
    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=os.environ.get(
            "DEFAULT_FROM_EMAIL", "Vita NPD Dev <dev@localhost>"
        ),
        to=[to_email],
    )
    msg.attach_alternative(html, "text/html")
    msg.send(fail_silently=False)


# ---------------------------------------------------------------------------
# Cases — one per transactional email shape we ship today.
# ---------------------------------------------------------------------------


def _case_registration_code() -> tuple[str, str, str]:
    from config.email_layout import EmailCode, render_email

    subject = "Your Vita Manufacture portal code · 123456"
    html, text = render_email(
        subject=subject,
        preheader="Enter the code to finish setting up your portal account.",
        heading="Confirm your email",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Hi Acme Foods Ltd,</p>"
            "<p style=\"margin-top:12px;margin-bottom:0;\">Thanks for signing up to "
            "the Vita Manufacture customer portal. Your 6-digit confirmation code "
            "is below — enter it on the registration page to finish setting up "
            "your account.</p>"
        ),
        code=EmailCode("123456"),
        outro=(
            "The code expires in 10 minutes. If you didn't request this, "
            "ignore the email — the code is useless without the open "
            "registration tab."
        ),
    )
    return subject, html, text


def _case_portal_invite() -> tuple[str, str, str]:
    from config.email_layout import EmailCode, render_email

    subject = "Vita NPD — your portal activation code"
    html, text = render_email(
        subject=subject,
        preheader="Your 6-digit code to activate the portal account.",
        heading="Activate your portal account",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Hi Acme Foods Ltd,</p>"
            "<p style=\"margin-top:12px;margin-bottom:0;\">Your team at Vita has "
            "issued a portal invite for you. Open the link they shared and enter "
            "this 6-digit code to finish setting up your account.</p>"
        ),
        code=EmailCode("654321"),
        outro=(
            "The code expires in 7 days. If you didn't expect this email, "
            "you can safely ignore it."
        ),
    )
    return subject, html, text


def _case_password_reset() -> tuple[str, str, str]:
    from config.email_layout import EmailCTA, render_email

    subject = "Vita NPD — reset your portal password"
    html, text = render_email(
        subject=subject,
        preheader="Reset your Vita portal password.",
        heading="Reset your password",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Use the button below to "
            "set a new password for your Vita portal account. The link expires "
            "in 30 minutes.</p>"
        ),
        cta=EmailCTA(
            label="Reset password",
            url="http://localhost:3030/portal/reset/EXAMPLE_TOKEN",
        ),
        outro="If you didn't request this, ignore this email.",
    )
    return subject, html, text


def _case_activation_link() -> tuple[str, str, str]:
    from config.email_layout import EmailCTA, render_email

    subject = "Vita NPD — review proposal P-2026-0017"
    html, text = render_email(
        subject=subject,
        preheader="Open your portal to read, sign, or comment on the proposal.",
        heading="Your proposal is ready",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Hi Acme Foods Ltd,</p>"
            "<p style=\"margin-top:12px;margin-bottom:0;\">Your proposal "
            "<b>P-2026-0017</b> from Vita is ready to review.</p>"
        ),
        cta=EmailCTA(
            label="Open your account",
            url="http://localhost:3030/portal/activate/EXAMPLE_TOKEN",
        ),
        outro=(
            "First time? You will be asked to set a password. Returning? "
            "You will be taken straight to the sign-in page."
        ),
    )
    return subject, html, text


def _case_proposal_activation_code() -> tuple[str, str, str]:
    from config.email_layout import EmailCode, render_email

    subject = "Your Vita Manufacture verification code · 998877"
    html, text = render_email(
        subject=subject,
        preheader="Enter the code on the proposal activation page.",
        heading="Confirm your email",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Hi Acme Foods Ltd,</p>"
            "<p style=\"margin-top:12px;margin-bottom:0;\">Your 6-digit "
            "verification code for proposal <b>P-2026-0017</b> is below.</p>"
        ),
        code=EmailCode("998877"),
        outro=(
            "Enter it on the activation page within the next 10 minutes. "
            "If you didn't request this, ignore the email — the code is "
            "useless without the activation link."
        ),
    )
    return subject, html, text


def _case_email_change_code() -> tuple[str, str, str]:
    from config.email_layout import EmailCode, render_email

    subject = "Vita NPD — confirm your new email"
    html, text = render_email(
        subject=subject,
        preheader="Enter this code on the settings page to confirm the change.",
        heading="Confirm your new email",
        intro_html=(
            "<p style=\"margin-top:0;margin-bottom:0;\">Your code to confirm this "
            "new email on your Vita portal account is below.</p>"
        ),
        code=EmailCode("445566"),
        outro=(
            "Enter it on the settings page within the next 30 minutes. "
            "If you didn't request this, ignore the email — your account "
            "stays on its current address."
        ),
    )
    return subject, html, text


def _case_template_password_reset() -> tuple[str, str, str]:
    """Existing template-based email — graded as-is to decide if we
    need to refactor."""

    from django.template.loader import render_to_string

    subject = "Reset your Vita NPD password"
    html = render_to_string(
        "accounts/email/password_reset.html",
        {
            "reset_url": "http://localhost:3030/reset-password/EXAMPLE",
            "recipient_first_name": "Alex",
        },
    )
    return subject, html, "Reset your password: http://localhost:3030/reset-password/EXAMPLE"


def _case_template_proposal_send() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Proposal P-2026-0017 from Vita Manufacture"
    html = render_to_string(
        "proposals/email/send_to_client.html",
        {
            "proposal": type("X", (), {"code": "P-2026-0017"})(),
            "body_text": "Hi Acme,\n\nYour proposal is ready.\n\nThanks,\nVita",
            "kiosk_url": "http://localhost:3030/portal/activate/EXAMPLE",
            "sales_person_name": "Sam Sales",
            "sales_person_email": "sam@vita.example",
        },
    )
    return subject, html, "Proposal ready."


def _case_template_payment_received() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Vita Manufacture · payment received"
    html = render_to_string(
        "payments/email/payment_received.html",
        {
            "project_code": "F-2026-0042",
            "project_name": "Acme Multivitamin",
            "customer_name": "Acme Foods Ltd",
            "amount": "1234.56",
            "amount_label": "1234.56 GBP",
            "invoice_number": "INV-2026-001",
            "reference": "REF-2026-001",
            "paid_at_label": "10 Jun 2026",
            "portal_url": "http://localhost:3030/portal/products/EXAMPLE",
            "sales_person_name": "Sam Sales",
            "sales_person_email": "sam@vita.example",
        },
    )
    return subject, html, "Payment received."


def _case_template_final_spec() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Vita Manufacture · final spec ready"
    sheet_obj = type(
        "X", (), {
            "code": "S-2026-0007",
            "customer_signed_at": None,
        },
    )()
    html = render_to_string(
        "specifications/email/final_spec_to_client.html",
        {
            "sheet": sheet_obj,
            "formulation_name": "Acme Multivitamin",
            "proposal_code": "P-2026-0017",
            "customer_name": "Acme Foods Ltd",
            "kiosk_url": "http://localhost:3030/portal/specs/EXAMPLE",
            "sales_person_name": "Sam Sales",
            "sales_person_email": "sam@vita.example",
            "body_text": "",
        },
    )
    return subject, html, "Final spec ready."


def _case_template_proposal_rejection() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    proposal = type(
        "X", (), {
            "code": "P-2026-0017",
            "customer_company": "Acme Foods Ltd",
        },
    )()
    subject = f"Proposal {proposal.code} declined by the customer"
    html = render_to_string(
        "proposals/email/customer_rejection.html",
        {
            "proposal": proposal,
            "proposal_url": "http://localhost:3030/proposals/EXAMPLE",
            "sales_person_name": "Sam Sales",
            "reason": "Pricing came in higher than we'd planned for.",
        },
    )
    return subject, html, "Proposal declined."


def _case_template_kiosk_alert() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "S-2026-0007 — New update"
    html = render_to_string(
        "comments/email/kiosk_alert.body.html",
        {
            "brand": "Vita Manufacture",
            "sheet_code": "S-2026-0007",
            "recipient_name": "Acme",
            "custom_note": "Pricing has been agreed for the trial.",
            "kiosk_url": "http://localhost:3030/portal/specs/EXAMPLE",
            "triggered_by_name": "Sam Sales",
            "triggered_by_email": "sam@vita.example",
        },
    )
    return subject, html, "New update."


def _case_template_comment_reply() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Sam replied on P-2026-0017"
    organization = type("X", (), {"name": "Vita Manufacture"})()
    html = render_to_string(
        "comments/email/reply.body.html",
        {
            "recipient_name": "Acme",
            "author_label": "Sam Sales",
            "target_label": "P-2026-0017",
            "body_excerpt": "Quick reply on pricing.",
            "target_url": "http://localhost:3030/portal/proposals/EXAMPLE",
            "organization": organization,
        },
    )
    return subject, html, "New reply."


def _case_template_comment_mention() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Sam mentioned you on P-2026-0017"
    organization = type("X", (), {"name": "Vita Manufacture"})()
    html = render_to_string(
        "comments/email/mention.body.html",
        {
            "recipient_name": "Acme",
            "author_label": "Sam Sales",
            "target_label": "P-2026-0017",
            "body_excerpt": "Hey @Acme — what do you think?",
            "target_url": "http://localhost:3030/portal/proposals/EXAMPLE",
            "organization": organization,
        },
    )
    return subject, html, "Mention."


def _case_template_customer_post() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Acme left a message on P-2026-0017"
    organization = type("X", (), {"name": "Vita Manufacture"})()
    html = render_to_string(
        "comments/email/customer_post.body.html",
        {
            "recipient_name": "Sam",
            "author_label": "Acme Foods Ltd",
            "target_label": "P-2026-0017",
            "body_excerpt": "Can we change the pack size?",
            "target_url": "http://localhost:3030/proposals/EXAMPLE",
            "organization": organization,
        },
    )
    return subject, html, "Customer post."


def _case_template_customer_message() -> tuple[str, str, str]:
    from django.template.loader import render_to_string

    subject = "Acme left a message on P-2026-0017"
    html = render_to_string(
        "comments/email/customer_message.body.html",
        {
            "author_label": "Acme Foods Ltd",
            "target_label": "P-2026-0017",
            "body_excerpt": "Can we change the pack size?",
            "portal_url": "http://localhost:3030/portal/proposals/EXAMPLE",
            "brand": "Vita Manufacture",
        },
    )
    return subject, html, "Customer message."


CASES = [
    ("registration_code", _case_registration_code),
    ("portal_invite", _case_portal_invite),
    ("password_reset", _case_password_reset),
    ("activation_link", _case_activation_link),
    ("proposal_activation_code", _case_proposal_activation_code),
    ("email_change_code", _case_email_change_code),
    ("template_password_reset", _case_template_password_reset),
    ("template_proposal_send", _case_template_proposal_send),
    ("template_proposal_rejection", _case_template_proposal_rejection),
    ("template_payment_received", _case_template_payment_received),
    ("template_final_spec", _case_template_final_spec),
    ("template_kiosk_alert", _case_template_kiosk_alert),
    ("template_comment_reply", _case_template_comment_reply),
    ("template_comment_mention", _case_template_comment_mention),
    ("template_customer_post", _case_template_customer_post),
    ("template_customer_message", _case_template_customer_message),
]


def main() -> int:
    _clear_inbox()

    sent_subjects: dict[str, str] = {}
    for name, builder in CASES:
        subject, html, text = builder()
        unique_subject = f"[{name}] {subject}"
        sent_subjects[unique_subject] = name
        _send_via_smtp(subject=unique_subject, html=html, text=text)

    _wait_for_count(len(CASES))

    # Pull the message list and map subjects → ids.
    listing = _get(f"/api/v1/messages?limit={len(CASES) + 5}")
    by_subject = {
        m["Subject"]: m["ID"] for m in listing.get("messages", [])
    }

    failures: list[str] = []
    print()
    print(f"{'case':32s}  {'supported':>10}  {'partial':>8}  {'unsupp':>7}  warnings")
    print("-" * 90)
    for subject, name in sent_subjects.items():
        mid = by_subject.get(subject)
        if mid is None:
            print(f"{name:32s}  not found in mailpit")
            failures.append(name)
            continue
        supported, partial, unsupp, slugs = _grade(mid)
        status_ok = supported >= MIN_SCORE
        marker = " " if status_ok else "*"
        print(
            f"{marker}{name:31s}  {supported:>10.2f}  {partial:>8.2f}  "
            f"{unsupp:>7.2f}  {','.join(slugs) if slugs else '-'}"
        )
        if not status_ok:
            failures.append(name)

    print()
    if failures:
        print(f"FAILED: {len(failures)} email(s) below {MIN_SCORE}% — {failures}")
        return 1
    print(f"OK: all {len(CASES)} emails ≥ {MIN_SCORE}% supported")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
