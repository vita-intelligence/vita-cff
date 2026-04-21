"""Outbound email notifications for comment events.

Two notification kinds land today:

* **mention** — the recipient was @-named in the comment body.
* **reply** — the recipient is the parent-thread author and a
  different user posted a child comment.

Delivery is synchronous via :func:`django.core.mail.send_mail`
wrapped in :meth:`django.db.transaction.on_commit` so we never send
an email for a write the surrounding transaction later rolled back.
When the Channels + Redis layer lands in a later commit the
dispatcher swaps to a Celery task with the same contract; nothing
calling it should need to change.

Dedupe is handled by a unique constraint on
:class:`~apps.comments.models.CommentNotification` — ``(comment,
recipient, kind)`` — so a retry of the dispatcher sees the row
already exists and skips the send. A user mentioned *and* replied
to in the same comment receives **one** mention email; the reply
row is not created.
"""

from __future__ import annotations

import logging
from typing import Any

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.db import IntegrityError
from django.template.loader import render_to_string
from django.urls import NoReverseMatch
from django.utils import timezone

from apps.comments.models import (
    Comment,
    CommentNotification,
    CommentNotificationKind,
    CommentNotificationStatus,
)


logger = logging.getLogger(__name__)


def enqueue_notifications_for_comment(comment_id) -> None:
    """Fan out mention + reply emails for a newly-written comment.

    Called from :meth:`transaction.on_commit` so the comment row is
    durably persisted before any email flies. A failure here never
    propagates — the surrounding write has already committed and the
    log row is observability, not correctness.
    """

    try:
        comment = (
            Comment.objects.select_related(
                "author",
                "organization",
                "parent",
                "parent__author",
                "formulation",
                "specification_sheet",
            )
            .filter(id=comment_id)
            .first()
        )
        if comment is None or comment.is_deleted:
            return
        _dispatch_mentions(comment)
        _dispatch_reply(comment)
    except Exception:  # noqa: BLE001 — never break the write path
        logger.exception(
            "Failed to enqueue comment notifications (comment_id=%s)",
            comment_id,
        )


# ---------------------------------------------------------------------------
# Per-kind dispatch
# ---------------------------------------------------------------------------


def _dispatch_mentions(comment: Comment) -> None:
    recipients = list(
        comment.mentions.select_related("mentioned_user").all()
    )
    for row in recipients:
        user = row.mentioned_user
        if not user.is_active or not user.email:
            continue
        _send_once(
            comment=comment,
            recipient=user,
            kind=CommentNotificationKind.MENTION,
        )


def _dispatch_reply(comment: Comment) -> None:
    parent = comment.parent
    if parent is None or parent.author_id is None:
        return
    author = parent.author
    if not author.is_active or not author.email:
        return
    # Don't notify someone for replying to themselves.
    if comment.author_id == parent.author_id:
        return
    # Suppress the reply email when the same user is also mentioned —
    # mention copy is more specific.
    if parent.author_id and any(
        mention.mentioned_user_id == parent.author_id
        for mention in comment.mentions.all()
    ):
        return
    _send_once(
        comment=comment,
        recipient=author,
        kind=CommentNotificationKind.REPLY,
    )


# ---------------------------------------------------------------------------
# Send-once primitive (writes the dedupe row, then the email)
# ---------------------------------------------------------------------------


def _send_once(
    *,
    comment: Comment,
    recipient,
    kind: str,
) -> CommentNotification | None:
    """Create or reuse the dedupe row, then send the email.

    Dedupe flow:

    1. Insert ``CommentNotification(..., status=queued)``. A unique
       constraint on ``(comment, recipient, kind)`` means a second
       caller will trip an :class:`IntegrityError`; we swallow it
       because the first caller is already on the delivery path.
    2. Render + send. On success bump the row to ``sent``; on failure
       to ``failed`` with the exception repr stored for later review.
    """

    try:
        row = CommentNotification.objects.create(
            comment=comment,
            recipient=recipient,
            kind=kind,
        )
    except IntegrityError:
        # A previous dispatch already took the lane. Nothing to do —
        # the original attempt is authoritative for this recipient.
        return None

    try:
        subject, text_body, html_body = _render_email(comment, recipient, kind)
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to render comment email (comment=%s kind=%s)",
            comment.id,
            kind,
        )
        row.status = CommentNotificationStatus.FAILED
        row.error = repr(exc)[:1000]
        row.save(update_fields=["status", "error"])
        return row

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=getattr(
            settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
        ),
        to=[recipient.email],
    )
    if html_body:
        message.attach_alternative(html_body, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to send comment email (comment=%s kind=%s to=%s)",
            comment.id,
            kind,
            recipient.email,
        )
        row.status = CommentNotificationStatus.FAILED
        row.error = repr(exc)[:1000]
        row.save(update_fields=["status", "error"])
        return row

    row.status = CommentNotificationStatus.SENT
    row.sent_at = timezone.now()
    row.save(update_fields=["status", "sent_at"])
    return row


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------


def _render_email(
    comment: Comment, recipient, kind: str
) -> tuple[str, str, str]:
    context = _template_context(comment, recipient, kind)
    subject = render_to_string(
        f"comments/email/{kind}.subject.txt", context
    ).strip()
    text_body = render_to_string(
        f"comments/email/{kind}.body.txt", context
    )
    try:
        html_body = render_to_string(
            f"comments/email/{kind}.body.html", context
        )
    except Exception:  # noqa: BLE001 — HTML alt is optional
        html_body = ""
    return subject, text_body, html_body


def _template_context(
    comment: Comment, recipient, kind: str
) -> dict[str, Any]:
    target_label, target_url = _describe_target(comment)
    author_label = _author_label(comment)
    body_excerpt = _excerpt(comment.body, limit=400)
    return {
        "recipient": recipient,
        "recipient_name": (
            recipient.get_full_name() or recipient.email
        ).strip(),
        "comment": comment,
        "organization": comment.organization,
        "author_label": author_label,
        "target_label": target_label,
        "target_url": target_url,
        "body_excerpt": body_excerpt,
        "kind": kind,
    }


def _author_label(comment: Comment) -> str:
    if comment.author_id and comment.author is not None:
        return (
            comment.author.get_full_name() or comment.author.email
        ).strip()
    if comment.guest_name:
        return f"{comment.guest_name} (client)"
    return "Someone"


def _describe_target(comment: Comment) -> tuple[str, str]:
    """Return ``(human_label, app_url)`` for the comment's target.

    The URL points at the frontend route — the backend does not
    own the router. We concatenate onto ``APP_BASE_URL`` so the
    link in the email drops the reader onto the right page.
    """

    base = getattr(settings, "APP_BASE_URL", "")
    if comment.formulation_id is not None:
        formulation = comment.formulation
        label = formulation.name or formulation.code or "project"
        url = f"{base}/formulations/{formulation.id}"
        return label, url
    if comment.specification_sheet_id is not None:
        sheet = comment.specification_sheet
        label = sheet.code or "specification sheet"
        url = f"{base}/specifications/{sheet.id}"
        return label, url
    return "a project", base or ""


def _excerpt(body: str, *, limit: int) -> str:
    text = (body or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"
