"""Outbound email notifications for comment events.

Staff receive comment-email notifications in exactly two cases:

* **mention** — the recipient was @-named in the comment body.
* **customer_post** — the comment was authored by a customer (portal
  account or guest) on a SHARED thread and the recipient is either
  the role-owner of the target entity (assigned designer / sales
  person / lead scientist) or has previously posted on the same
  thread.

The legacy **reply** kind has been retired — staff explicitly asked
for "mention + customer-text only". Existing ``CommentNotification``
rows with ``kind=reply`` stay in the table for historical audit; the
dispatcher just no longer creates new ones. ``CommentNotificationKind.REPLY``
is kept on the enum so older rows still deserialise.

Delivery is synchronous via :func:`django.core.mail.send_mail`
wrapped in :meth:`django.db.transaction.on_commit` so we never send
an email for a write the surrounding transaction later rolled back.

Dedupe is handled by a unique constraint on
:class:`~apps.comments.models.CommentNotification` — ``(comment,
recipient, kind)`` — so a retry of the dispatcher sees the row
already exists and skips the send.
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
    ClientCommentNotification,
    ClientCommentNotificationStatus,
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
        # Staff-side fan-out is intentionally narrow: only @mentions
        # and customer posts. The reply kind was dropped — staff
        # complained that "anyone replied to a thread I touched" was
        # the dominant inbox noise. See module docstring for history.
        _dispatch_mentions(comment)
        _dispatch_customer(comment)
        _dispatch_customer_post_to_staff(comment)
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


def _dispatch_customer(comment: Comment) -> None:
    """Auto-notify the brand-owner customer when a SHARED comment
    lands on a client-visible target.

    Replaces the legacy manual "Notify client" button — every
    shared message now fans out an email automatically, mirroring
    the way teammates get pinged for replies / mentions. Skips:

    * internal comments (visibility != shared) — those are team
      chatter the customer should never see;
    * comments whose author IS the customer (no point emailing
      them about their own post);
    * targets with no resolvable customer (proposal with no
      customer FK, formulation-only thread, etc.).

    Dedupe via ``ClientCommentNotification(comment, recipient_email)``
    so a retry of the dispatcher never double-sends.
    """

    if comment.visibility != Comment.Visibility.SHARED:
        return

    # Customer-authored comments don't notify the customer.
    if comment.guest_email or comment.client_account_id is not None:
        return

    recipients = _resolve_customer_recipients(comment)
    if not recipients:
        return

    for email in recipients:
        _send_customer_once(comment=comment, recipient_email=email)


def _dispatch_customer_post_to_staff(comment: Comment) -> None:
    """Email every staff user who has previously posted on the
    same thread when a customer posts a new shared message.

    "Previously posted on the thread" is a reasonable proxy for
    "people watching this conversation" — the assigned designer
    / sales person / scientist will typically have replied at
    least once, and any teammate who chimed in once expects to
    see follow-ups. Dedupes via the same
    :class:`CommentNotification` ledger as mentions / replies,
    keyed on ``(comment, recipient, kind=customer_post)``.

    Skips when:

    * the comment isn't a customer post (staff author / guest with
      no client_account → nothing to notify staff about),
    * visibility isn't ``SHARED`` (an "internal" customer post is
      a category error — the portal can't create one — but defend
      anyway),
    * the resolver yields zero staff (rare — usually means the
      thread is brand new and the customer is the first to write,
      in which case the @mention path or the dedicated CFF /
      labelling triage rosters catch it instead).
    """

    # Only customer posts qualify. Staff-authored comments use the
    # mention / reply paths.
    if comment.author_id is not None:
        return
    if comment.client_account_id is None and not comment.guest_email:
        return
    if comment.visibility != Comment.Visibility.SHARED:
        return

    recipients = _resolve_staff_who_posted_on_thread(comment)
    for user in recipients:
        if not user.is_active or not user.email:
            continue
        _send_once(
            comment=comment,
            recipient=user,
            kind=CommentNotificationKind.CUSTOMER_POST,
        )


def _resolve_staff_who_posted_on_thread(comment: Comment):
    """Distinct staff users who should be notified when a customer
    posts a shared message on this thread.

    Three layers, union'd:

    1. Anyone who has previously authored a comment on the same
       thread — a reasonable proxy for "people actively watching
       this conversation".
    2. Role pointers on the target entity. For label designs we
       also notify the ``assigned_designer`` because they may not
       have replied yet but they're the staff member who owns the
       work; for proposals we notify the ``sales_person``; for
       spec sheets / formulations we notify the
       ``lead_scientist`` on the parent formulation.
    3. (Reserved) future labelling-team manager rosters.

    Without (2) the very first customer message on a brand-new
    thread would notify nobody (user-reported "no notifications
    for me").
    """

    from django.contrib.auth import get_user_model

    User = get_user_model()
    same_thread_qs = Comment.objects.filter(
        organization_id=comment.organization_id,
        is_deleted=False,
        author__isnull=False,
    ).exclude(id=comment.id)

    role_user_ids: set = set()

    if comment.label_design_id:
        same_thread_qs = same_thread_qs.filter(
            label_design_id=comment.label_design_id
        )
        # Layer 2 — assigned designer on this label workflow.
        from apps.label_design.models import LabelDesign

        designer_id = (
            LabelDesign.objects.filter(id=comment.label_design_id)
            .values_list("assigned_designer_id", flat=True)
            .first()
        )
        if designer_id:
            role_user_ids.add(designer_id)
    elif comment.proposal_id:
        same_thread_qs = same_thread_qs.filter(proposal_id=comment.proposal_id)
        from apps.proposals.models import Proposal

        sales_id = (
            Proposal.objects.filter(id=comment.proposal_id)
            .values_list("sales_person_id", flat=True)
            .first()
        )
        if sales_id:
            role_user_ids.add(sales_id)
    elif comment.specification_sheet_id:
        same_thread_qs = same_thread_qs.filter(
            specification_sheet_id=comment.specification_sheet_id
        )
    elif comment.cff_submission_id:
        same_thread_qs = same_thread_qs.filter(
            cff_submission_id=comment.cff_submission_id
        )
    elif comment.formulation_id:
        same_thread_qs = same_thread_qs.filter(
            formulation_id=comment.formulation_id
        )
        from apps.formulations.models import Formulation

        scientist_id = (
            Formulation.objects.filter(id=comment.formulation_id)
            .values_list("lead_scientist_id", flat=True)
            .first()
        )
        if scientist_id:
            role_user_ids.add(scientist_id)
    else:
        return []

    author_ids = set(
        same_thread_qs.values_list("author_id", flat=True).distinct()
    )
    all_ids = author_ids | role_user_ids
    if not all_ids:
        return []
    return User.objects.filter(id__in=all_ids).only(
        "id", "email", "first_name", "last_name", "is_active"
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
# Customer-side dispatch + send-once primitive
# ---------------------------------------------------------------------------


def _resolve_customer_recipients(comment: Comment) -> list[str]:
    """Distinct, lowercased customer-portal emails for a comment.

    Walks the comment's denormalised target FK to find the
    associated customer record, then expands to every active
    :class:`ClientAccount` email under that customer. Returns an
    empty list when no resolvable customer / accounts exist — that
    case happens for formulation-only threads, draft CFFs with no
    customer link, etc.
    """

    from apps.client_portal.models import ClientAccount

    customer_id = _customer_id_for_target(comment)
    if customer_id is None:
        return []

    raw = (
        ClientAccount.objects.filter(
            customer_id=customer_id, is_active=True
        )
        .exclude(email="")
        .values_list("email", flat=True)
    )
    seen: set[str] = set()
    out: list[str] = []
    for email in raw:
        normalised = (email or "").strip().lower()
        if not normalised or normalised in seen:
            continue
        seen.add(normalised)
        out.append(normalised)
    return out


def _customer_id_for_target(comment: Comment):
    """Resolve the brand-owner customer FK from whichever target
    denormalisation column the comment carries.

    Comment targets that can route to a customer:

    * proposal → ``proposal.customer_id`` (direct)
    * specification_sheet → through any Proposal pinned to the
      sheet (modern per-line link OR legacy 1:1)
    * cff_submission → through the customer attached to the
      submission, if any
    * label_design → through the spec sheet → proposal path

    The first hit wins; ``None`` if nothing resolves.
    """

    from apps.proposals.models import Proposal

    if getattr(comment, "proposal_id", None):
        customer_id = (
            Proposal.objects.filter(id=comment.proposal_id)
            .values_list("customer_id", flat=True)
            .first()
        )
        if customer_id:
            return customer_id

    # Direct label_design → formulation → proposal → customer.
    # Tried BEFORE the spec-sheet path because not every label
    # design carries a ``specification_sheet`` FK (early-flow
    # designs created from a PASSing trial batch sometimes don't
    # have one yet), and we'd rather email the customer too
    # eagerly than silently drop a notification.
    if getattr(comment, "label_design_id", None):
        from apps.label_design.models import LabelDesign

        ld_row = (
            LabelDesign.objects.filter(id=comment.label_design_id)
            .values("formulation_id", "specification_sheet_id")
            .first()
        )
        if ld_row:
            if ld_row.get("formulation_id"):
                customer_id = (
                    Proposal.objects.filter(
                        formulation_version__formulation_id=ld_row[
                            "formulation_id"
                        ],
                        customer__isnull=False,
                    )
                    .order_by("-updated_at")
                    .values_list("customer_id", flat=True)
                    .first()
                )
                if customer_id:
                    return customer_id

    sheet_id = getattr(comment, "specification_sheet_id", None)
    if sheet_id:
        proposal_ids = list(
            Proposal.objects.filter(lines__specification_sheet_id=sheet_id)
            .values_list("id", flat=True)
        )
        proposal_ids.extend(
            Proposal.objects.filter(specification_sheet_id=sheet_id)
            .values_list("id", flat=True)
        )
        if proposal_ids:
            customer_id = (
                Proposal.objects.filter(
                    id__in=proposal_ids, customer__isnull=False
                )
                .values_list("customer_id", flat=True)
                .first()
            )
            if customer_id:
                return customer_id

    if getattr(comment, "cff_submission_id", None):
        from apps.cff_submissions.models import CFFSubmission

        customer_id = (
            CFFSubmission.objects.filter(id=comment.cff_submission_id)
            .values_list("customer_id", flat=True)
            .first()
        )
        if customer_id:
            return customer_id

    return None


def _send_customer_once(*, comment: Comment, recipient_email: str) -> None:
    """Dedupe + render + send the customer-facing message email.

    Uses :class:`ClientCommentNotification` for the dedupe ledger.
    Failures are isolated per recipient — one bad address never
    blocks the next email.
    """

    try:
        row = ClientCommentNotification.objects.create(
            comment=comment,
            recipient_email=recipient_email,
        )
    except IntegrityError:
        return

    try:
        subject, text_body, html_body = _render_customer_email(
            comment=comment, recipient_email=recipient_email
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to render customer comment email (comment=%s to=%s)",
            comment.id,
            recipient_email,
        )
        row.status = ClientCommentNotificationStatus.FAILED
        row.error = repr(exc)[:1000]
        row.save(update_fields=["status", "error"])
        return

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=getattr(
            settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
        ),
        to=[recipient_email],
    )
    if html_body:
        message.attach_alternative(html_body, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to send customer comment email (comment=%s to=%s)",
            comment.id,
            recipient_email,
        )
        row.status = ClientCommentNotificationStatus.FAILED
        row.error = repr(exc)[:1000]
        row.save(update_fields=["status", "error"])
        return

    row.status = ClientCommentNotificationStatus.SENT
    row.sent_at = timezone.now()
    row.save(update_fields=["status", "sent_at"])


def _render_customer_email(
    *, comment: Comment, recipient_email: str
) -> tuple[str, str, str]:
    target_label, portal_url = _describe_portal_target(comment)
    context = {
        "brand": getattr(settings, "APP_BRAND_NAME", "Vita NPD"),
        "recipient_email": recipient_email,
        "author_label": _author_label(comment),
        "body_excerpt": _excerpt(comment.body, limit=400),
        "target_label": target_label,
        "portal_url": portal_url,
        "comment": comment,
        "organization": comment.organization,
    }
    subject = render_to_string(
        "comments/email/customer_message.subject.txt", context
    ).strip()
    text_body = render_to_string(
        "comments/email/customer_message.body.txt", context
    )
    try:
        html_body = render_to_string(
            "comments/email/customer_message.body.html", context
        )
    except Exception:  # noqa: BLE001 — HTML alt is optional
        html_body = ""
    return subject, text_body, html_body


def _describe_portal_target(comment: Comment) -> tuple[str, str]:
    """Customer-portal URL + human label for a comment's target.

    Distinct from :func:`_describe_target` (which points at the
    staff app) because the customer doesn't have a staff session —
    the link in their email must drop them onto the portal page
    they CAN open.
    """

    base = getattr(settings, "APP_BASE_URL", "")
    if getattr(comment, "proposal_id", None):
        from apps.proposals.models import Proposal

        proposal = Proposal.objects.filter(id=comment.proposal_id).first()
        if proposal is not None:
            label = (proposal.code or "proposal").strip() or "proposal"
            return label, f"{base}/portal/proposals/{proposal.id}/"

    if getattr(comment, "label_design_id", None):
        return (
            "label design",
            f"{base}/portal/label-designs/{comment.label_design_id}/",
        )

    if comment.specification_sheet_id is not None:
        sheet = comment.specification_sheet
        label = (sheet.code or "specification sheet") if sheet else "spec sheet"
        # Spec sheet has its own portal kiosk URL keyed on the
        # public token. Falls back to the staff app URL if there's
        # no public token (shouldn't happen on a SHARED comment).
        token = getattr(sheet, "public_token", "")
        if token:
            return label, f"{base}/p/{token}/"
        return label, f"{base}/specifications/{comment.specification_sheet_id}/"

    if getattr(comment, "cff_submission_id", None):
        return (
            "submission",
            f"{base}/portal/cff/{comment.cff_submission_id}/",
        )

    return "a project", base or ""


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
    if comment.label_design_id is not None:
        return "label design", f"{base}/labelling/{comment.label_design_id}"
    if getattr(comment, "proposal_id", None):
        from apps.proposals.models import Proposal

        proposal = Proposal.objects.filter(id=comment.proposal_id).first()
        if proposal is not None:
            label = proposal.code or "proposal"
            return label, f"{base}/proposals/{proposal.id}"
    if getattr(comment, "cff_submission_id", None):
        return (
            "CFF submission",
            f"{base}/cffs/{comment.cff_submission_id}",
        )
    if comment.specification_sheet_id is not None:
        sheet = comment.specification_sheet
        label = (sheet.code if sheet else "") or "specification sheet"
        return label, f"{base}/specifications/{comment.specification_sheet_id}"
    if comment.formulation_id is not None:
        formulation = comment.formulation
        label = formulation.name or formulation.code or "project"
        return label, f"{base}/formulations/{formulation.id}"
    return "a project", base or ""


def _excerpt(body: str, *, limit: int) -> str:
    text = (body or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"
