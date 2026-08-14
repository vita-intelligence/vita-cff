"""Staff-facing email notifications for CFF submission lifecycle events.

Sibling of :mod:`apps.payments.staff_notifications` — same
``_recipients_with_role`` pattern, same best-effort dispatch shape,
same on_commit expectation from callers. Kept as its own module
because the fields sent through the template are CFF-specific
(customer identity, dosage form intent, sales-lead hint) and
factoring one shared helper across two domains bought less than it
cost.

Fires today for:

* :func:`notify_scientists_new_portal_cff` — one email per member
  of the org whose ``Membership.groups`` includes ``"scientist"``
  (plus owners). Called from
  :func:`apps.cff_submissions.services.create_portal_submission`
  via ``transaction.on_commit`` when a customer-authenticated
  portal CFF lands. Wix / web-site submissions don't fire this
  today — they follow a different intake pipeline that already
  ships to the triage inbox.

Best-effort: broken SMTP never rolls back the CFF write. Empty
recipient lists silently no-op. Exceptions per-recipient are logged
but never propagated so one bad email doesn't block the rest of the
batch.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.template.loader import render_to_string

from apps.cff_submissions.models import CFFSubmission


logger = logging.getLogger(__name__)


def _recipients_with_role(*, organization: Any, role: str) -> list[tuple[str, str]]:
    """``[(email, display_name), ...]`` for every active member of
    ``organization`` whose ``Membership.groups`` includes ``role``.

    Owners always receive regardless of tag — they're responsible for
    anything nobody else is watching. Skips members with empty email
    addresses.
    """

    from apps.organizations.models import Membership

    memberships = (
        Membership.objects.filter(organization=organization)
        .select_related("user")
        .order_by("user__email")
    )

    out: list[tuple[str, str]] = []
    seen_emails: set[str] = set()
    for m in memberships:
        user = m.user
        if user is None:
            continue
        email = (getattr(user, "email", "") or "").strip()
        if not email or email.lower() in seen_emails:
            continue
        role_match = isinstance(m.groups, list) and role in m.groups
        if not (m.is_owner or role_match):
            continue
        name = (
            (getattr(user, "get_full_name", lambda: "")() or "").strip()
            or email
        )
        out.append((email, name))
        seen_emails.add(email.lower())
    return out


def _cff_url(submission: CFFSubmission) -> str:
    """Deep link to the triage-inbox detail for this CFF. Same base
    URL config the payments notifications reuse so the two email
    families point at the same host.
    """

    base = getattr(settings, "APP_BASE_URL", "http://localhost:3000").rstrip("/")
    return f"{base}/cff/{submission.id}"


def _submitter_display(submission: CFFSubmission) -> str:
    """Best effort at "who filled this out" for the email subject
    line — company first, then name, then email fallback so the
    scientist sees a human-readable label rather than a UUID.
    """

    name = (submission.submitter_name or "").strip()
    if name:
        return name
    email = (submission.submitter_email or "").strip()
    if email:
        return email
    return "a customer"


def _send_role_email(
    *,
    recipients: list[tuple[str, str]],
    subject: str,
    template_base: str,
    context: dict,
) -> None:
    if not recipients:
        return

    from_email = getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@example.com")
    text_body = render_to_string(f"{template_base}.txt", context)
    html_body = render_to_string(f"{template_base}.html", context)

    for email, _name in recipients:
        try:
            msg = EmailMultiAlternatives(
                subject=subject,
                body=text_body,
                from_email=from_email,
                to=[email],
            )
            msg.attach_alternative(html_body, "text/html")
            msg.send(fail_silently=False)
        except Exception:
            logger.exception(
                "cff_submissions.staff_notifications: failed to email %s "
                "(template=%s)",
                email,
                template_base,
            )


def notify_scientists_new_portal_cff(*, submission_id: Any) -> None:
    """Email every scientist-tagged member (plus owners) that a fresh
    customer-authored CFF has landed via the portal.

    Called from :func:`create_portal_submission` via
    ``transaction.on_commit``. Silent no-op when the submission
    disappears between commit and dispatch (rare — retriage /
    delete-in-flight race) or the org has no scientist / owner
    audience.
    """

    submission = (
        CFFSubmission.objects.select_related("organization")
        .filter(pk=submission_id)
        .first()
    )
    if submission is None:
        return

    recipients = _recipients_with_role(
        organization=submission.organization, role="scientist"
    )
    if not recipients:
        return

    context = {
        "submitter_display": _submitter_display(submission),
        "submitter_email": (submission.submitter_email or "").strip(),
        "cff_url": _cff_url(submission),
    }
    subject = (
        f"[Vita] New Custom Formulation Form from "
        f"{context['submitter_display']}"
    )
    _send_role_email(
        recipients=recipients,
        subject=subject,
        template_base="cff_submissions/email/scientist_new_portal_cff",
        context=context,
    )
