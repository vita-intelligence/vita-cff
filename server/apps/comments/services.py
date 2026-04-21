"""Service layer for the comments app.

Rules (same as every other feature app in this repo):

* Views never touch the ORM directly — they call one of the functions
  here. Services take the ``actor``; they do not perform authorisation
  (that is the view / permission class). Services enforce *correctness*
  — depth caps, root-only resolution, target-in-org checks.
* Every write runs inside a single transaction and records an audit
  row via :func:`apps.audit.services.record`.
* Public functions accept only keyword arguments so the call-sites
  cannot silently swap positional values.
"""

from __future__ import annotations

from typing import Any, Sequence

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models import Q, QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.comments.broadcast import schedule_comment_broadcast
from apps.comments.mentions import resolve_mentions
from apps.comments.models import Comment, CommentMention
from apps.formulations.models import Formulation
from apps.organizations.models import Organization
from apps.specifications.models import SpecificationSheet


# ---------------------------------------------------------------------------
# Typed errors — each maps to a stable ``api_code`` the frontend i18n
# layer translates. Keep the strings short and ``snake_case``.
# ---------------------------------------------------------------------------


class CommentNotFound(Exception):
    api_code = "comment_not_found"


class CommentTargetInvalid(Exception):
    """Target is missing, cross-tenant, or of an unsupported type."""

    api_code = "comment_target_invalid"


class CommentReplyDepthExceeded(Exception):
    """Caller tried to reply to a reply — we only support 1-level threads."""

    api_code = "comment_reply_depth_exceeded"


class CommentResolveNonRoot(Exception):
    """Only root comments can be resolved / unresolved."""

    api_code = "comment_resolve_non_root"


class CommentBodyBlank(Exception):
    api_code = "comment_body_blank"


class CommentPermissionDenied(Exception):
    """Author-level guard (services enforce write scope beyond DRF).

    The DRF permission class already authorised the caller to hit the
    endpoint; this surfaces when a service-level check (e.g. "only
    authors can edit their own comment") fails inside the transaction.
    """

    api_code = "comment_permission_denied"


# ---------------------------------------------------------------------------
# Supported targets — each tuple is (Model, direct-FK attribute name).
# Adding a new entity later (e.g. ``TrialBatch``) is a two-line change
# here plus a migration for the new FK column on ``Comment``.
# ---------------------------------------------------------------------------


_SUPPORTED_TARGETS: dict[type, str] = {
    Formulation: "formulation",
    SpecificationSheet: "specification_sheet",
}


def _resolve_target(target) -> tuple[ContentType, Any, str]:
    """Validate ``target`` is one of the supported entity types and
    return ``(content_type, object_id, direct_fk_attr)``.

    Raises :class:`CommentTargetInvalid` for anything else. The three
    returned values are the minimum the create path needs to build a
    polymorphic ``Comment`` row with its denormalised FK populated.
    """

    for model_cls, fk_attr in _SUPPORTED_TARGETS.items():
        if isinstance(target, model_cls):
            return (
                ContentType.objects.get_for_model(model_cls),
                target.pk,
                fk_attr,
            )
    raise CommentTargetInvalid()


# ---------------------------------------------------------------------------
# Read helpers
# ---------------------------------------------------------------------------


_COMMENT_SELECT_RELATED: tuple[str, ...] = (
    "author",
    "resolved_by",
    "deleted_by",
    "parent",
    "organization",
)


def get_comment(*, organization: Organization, comment_id: Any) -> Comment:
    comment = (
        Comment.objects.select_related(*_COMMENT_SELECT_RELATED)
        .filter(organization=organization, id=comment_id)
        .first()
    )
    if comment is None:
        raise CommentNotFound()
    return comment


def list_thread(
    *,
    organization: Organization,
    target,
    include_resolved: bool = True,
    include_deleted: bool = True,
) -> QuerySet[Comment]:
    """Return the comment thread attached to ``target`` oldest-first.

    * ``include_resolved`` — when ``False`` we hide any root (and its
      descendants) where ``is_resolved`` is ``True``. Default True so
      the UI can choose which filter to apply.
    * ``include_deleted`` — we always keep deleted rows in the result
      so threading remains readable; the UI renders a tombstone in
      place of the body. Kept as a knob for admin tooling that may
      want a hard filter later.
    """

    content_type, object_id, _fk = _resolve_target(target)
    queryset = (
        Comment.objects.filter(
            organization=organization,
            content_type=content_type,
            object_id=object_id,
        )
        .select_related(*_COMMENT_SELECT_RELATED)
        .order_by("created_at")
    )
    if not include_resolved:
        # Hide both the resolved root and every reply that hangs off
        # it — walking ``parent__is_resolved`` in a subquery keeps the
        # filter in one round-trip.
        queryset = queryset.filter(
            Q(parent__isnull=True, is_resolved=False)
            | Q(parent__isnull=False, parent__is_resolved=False)
        )
    if not include_deleted:
        queryset = queryset.filter(is_deleted=False)
    return queryset


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------


def _clean_body(body: str) -> str:
    trimmed = (body or "").strip()
    if not trimmed:
        raise CommentBodyBlank()
    return trimmed


def _persist_mentions(
    *, comment: Comment, mentioned_users: Sequence
) -> list:
    """Replace the mention rows + cache for ``comment``.

    Idempotent by design: called on create and on edit, we nuke the
    existing rows and re-insert. The ``CommentNotification`` dedupe
    ledger is what keeps email delivery exactly-once, so re-writing
    the mention rows on edit is harmless for notifications.
    """

    CommentMention.objects.filter(comment=comment).delete()
    rows = [
        CommentMention(comment=comment, mentioned_user=user)
        for user in mentioned_users
    ]
    CommentMention.objects.bulk_create(rows)
    comment.mentions_cache = [str(user.id) for user in mentioned_users]
    comment.save(update_fields=["mentions_cache"])
    return list(mentioned_users)


@transaction.atomic
def create_comment(
    *,
    organization: Organization,
    actor,
    target,
    body: str,
    parent: Comment | None = None,
) -> Comment:
    """Post a new root comment or a reply.

    ``parent`` being a reply itself raises
    :class:`CommentReplyDepthExceeded`; the root-only rule is enforced
    here as well as at the model layer so a bad service caller
    surfaces the same ``api_code`` as a bad request to the view.
    """

    cleaned = _clean_body(body)
    content_type, object_id, fk_attr = _resolve_target(target)

    if parent is not None:
        if parent.organization_id != organization.id:
            raise CommentTargetInvalid()
        if parent.content_type_id != content_type.id or parent.object_id != object_id:
            raise CommentTargetInvalid()
        if parent.parent_id is not None:
            raise CommentReplyDepthExceeded()

    comment = Comment(
        organization=organization,
        content_type=content_type,
        object_id=object_id,
        parent=parent,
        author=actor,
        body=cleaned,
    )
    setattr(comment, fk_attr, target)
    comment.save()

    mentioned_users = resolve_mentions(
        cleaned,
        organization_id=organization.id,
        author_id=getattr(actor, "id", None),
    )
    _persist_mentions(comment=comment, mentioned_users=mentioned_users)

    record_audit(
        organization=organization,
        actor=actor,
        action="comment.create",
        target=comment,
        after=snapshot(comment),
    )

    # Queue notifications (mention + reply) after the transaction
    # commits so the consumer never sees a row the transaction later
    # rolled back.
    from apps.comments.notifications import (
        enqueue_notifications_for_comment,
    )

    transaction.on_commit(
        lambda c=comment: enqueue_notifications_for_comment(c.id)
    )

    # Real-time fan-out to every open watcher of this entity. The
    # helper registers its own ``on_commit`` hook so a rollback
    # suppresses the broadcast.
    schedule_comment_broadcast(comment, "created")
    return comment


@transaction.atomic
def edit_comment(*, comment: Comment, actor, body: str) -> Comment:
    """Update a comment's body. Only the author can edit their own
    comment (the view layer caps this further — moderators do not get
    to impersonate an author by editing their body). Sets the
    ``edited`` flag so readers can see the comment was changed.
    """

    if comment.is_deleted:
        raise CommentPermissionDenied()
    if not _is_author(comment, actor):
        raise CommentPermissionDenied()

    cleaned = _clean_body(body)
    if cleaned == comment.body:
        # No-op: the user re-submitted an unchanged body. Avoid
        # producing a spurious audit row and a false ``edited`` badge.
        return comment

    before = snapshot(comment)
    comment.body = cleaned
    comment.is_edited = True
    comment.edited_at = timezone.now()
    comment.save(update_fields=["body", "is_edited", "edited_at", "updated_at"])

    mentioned_users = resolve_mentions(
        cleaned,
        organization_id=comment.organization_id,
        author_id=getattr(actor, "id", None),
    )
    _persist_mentions(comment=comment, mentioned_users=mentioned_users)

    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.edit",
        target=comment,
        before=before,
        after=snapshot(comment),
    )

    from apps.comments.notifications import (
        enqueue_notifications_for_comment,
    )

    transaction.on_commit(
        lambda cid=comment.id: enqueue_notifications_for_comment(cid)
    )

    schedule_comment_broadcast(comment, "updated")
    return comment


@transaction.atomic
def delete_comment(*, comment: Comment, actor, is_moderator: bool = False) -> Comment:
    """Soft-delete a comment.

    Soft delete = ``is_deleted = True`` + body replaced with an empty
    string so the UI never accidentally renders what the author
    removed. The row is retained to preserve thread continuity and
    the audit trail. Only the author or a moderator may delete.
    """

    if comment.is_deleted:
        return comment
    if not (_is_author(comment, actor) or is_moderator):
        raise CommentPermissionDenied()

    before = snapshot(comment)
    comment.is_deleted = True
    comment.deleted_at = timezone.now()
    comment.deleted_by = actor
    comment.body = ""
    comment.save(
        update_fields=[
            "is_deleted",
            "deleted_at",
            "deleted_by",
            "body",
            "updated_at",
        ]
    )
    # Tear down mentions too — a deleted comment should stop
    # surfacing in mention-inbox views once we build them.
    CommentMention.objects.filter(comment=comment).delete()
    comment.mentions_cache = []
    comment.save(update_fields=["mentions_cache"])

    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.delete",
        target=comment,
        before=before,
        after=snapshot(comment),
    )
    schedule_comment_broadcast(comment, "deleted")
    return comment


@transaction.atomic
def flag_thread(
    *, comment: Comment, actor, is_moderator: bool = False
) -> Comment:
    """Flag a root thread as needing resolution.

    Flagging pins the thread to the top of the list and makes the
    Resolve action available. The flag is the explicit signal that
    this comment is a task to close, not just a passing remark.
    """

    if comment.parent_id is not None:
        raise CommentResolveNonRoot()
    if comment.is_deleted:
        raise CommentPermissionDenied()
    if not (_is_author(comment, actor) or is_moderator):
        raise CommentPermissionDenied()
    if comment.needs_resolution:
        return comment

    before = snapshot(comment)
    comment.needs_resolution = True
    comment.save(update_fields=["needs_resolution", "updated_at"])
    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.flag",
        target=comment,
        before=before,
        after=snapshot(comment),
    )
    schedule_comment_broadcast(comment, "updated")
    return comment


@transaction.atomic
def unflag_thread(
    *, comment: Comment, actor, is_moderator: bool = False
) -> Comment:
    """Clear the "needs resolution" flag without resolving the thread.

    Useful when a teammate flagged a comment by accident — the
    resolve path already clears the flag as a side-effect, so this
    entry-point is only for the "actually this doesn't need
    resolving" case.
    """

    if comment.parent_id is not None:
        raise CommentResolveNonRoot()
    if not comment.needs_resolution:
        return comment
    if not (_is_author(comment, actor) or is_moderator):
        raise CommentPermissionDenied()

    before = snapshot(comment)
    comment.needs_resolution = False
    comment.save(update_fields=["needs_resolution", "updated_at"])
    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.unflag",
        target=comment,
        before=before,
        after=snapshot(comment),
    )
    schedule_comment_broadcast(comment, "updated")
    return comment


@transaction.atomic
def resolve_thread(
    *, comment: Comment, actor, is_moderator: bool = False
) -> Comment:
    """Mark a root thread resolved.

    Allowed actors:
    * the thread's original author (they can close their own question);
    * any caller with moderate scope (``is_moderator=True``).

    Resolving also clears ``needs_resolution`` so the thread unpins
    from the top of the list in the same write.
    """

    if comment.parent_id is not None:
        raise CommentResolveNonRoot()
    if comment.is_resolved:
        return comment
    if not (_is_author(comment, actor) or is_moderator):
        raise CommentPermissionDenied()

    before = snapshot(comment)
    comment.is_resolved = True
    comment.needs_resolution = False
    comment.resolved_by = actor
    comment.resolved_at = timezone.now()
    comment.save(
        update_fields=[
            "is_resolved",
            "needs_resolution",
            "resolved_by",
            "resolved_at",
            "updated_at",
        ]
    )
    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.resolve",
        target=comment,
        before=before,
        after=snapshot(comment),
    )
    schedule_comment_broadcast(comment, "resolved")
    return comment


@transaction.atomic
def unresolve_thread(
    *, comment: Comment, actor, is_moderator: bool = False
) -> Comment:
    """Re-open a resolved thread (inverse of :func:`resolve_thread`)."""

    if comment.parent_id is not None:
        raise CommentResolveNonRoot()
    if not comment.is_resolved:
        return comment
    if not (_is_author(comment, actor) or is_moderator):
        raise CommentPermissionDenied()

    before = snapshot(comment)
    comment.is_resolved = False
    comment.resolved_by = None
    comment.resolved_at = None
    comment.save(
        update_fields=[
            "is_resolved",
            "resolved_by",
            "resolved_at",
            "updated_at",
        ]
    )
    record_audit(
        organization=comment.organization,
        actor=actor,
        action="comment.unresolve",
        target=comment,
        before=before,
        after=snapshot(comment),
    )
    schedule_comment_broadcast(comment, "resolved")
    return comment


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_author(comment: Comment, actor) -> bool:
    """``True`` when ``actor`` authored ``comment`` (guest comments have
    no author, so this always returns ``False`` for those until we
    teach the kiosk layer to pass a session-identified actor)."""

    if comment.author_id is None:
        return False
    actor_id = getattr(actor, "id", None) or getattr(actor, "pk", None)
    return actor_id is not None and actor_id == comment.author_id


# ---------------------------------------------------------------------------
# Kiosk (public / guest) path
# ---------------------------------------------------------------------------


@transaction.atomic
def create_guest_comment(
    *,
    session,
    target,
    body: str,
    parent: Comment | None = None,
) -> Comment:
    """Post a comment as a kiosk visitor.

    ``session`` is a :class:`apps.comments.models.KioskSession` whose
    signed cookie the view already validated. The session carries
    the guest's identity; we stamp ``guest_name`` / ``guest_email``
    / ``guest_session_hash`` on the row so the audit trail and the
    rate-limiter have something to join on.

    Same threading + body rules as :func:`create_comment`. No audit
    actor (``actor=None``) because there's no authenticated user,
    but the row itself still lands in the audit log with a
    ``kind="guest"`` hint in the snapshot.
    """

    cleaned = _clean_body(body)
    content_type, object_id, fk_attr = _resolve_target(target)

    organization = target.organization
    if parent is not None:
        if parent.organization_id != organization.id:
            raise CommentTargetInvalid()
        if (
            parent.content_type_id != content_type.id
            or parent.object_id != object_id
        ):
            raise CommentTargetInvalid()
        if parent.parent_id is not None:
            raise CommentReplyDepthExceeded()

    comment = Comment(
        organization=organization,
        content_type=content_type,
        object_id=object_id,
        parent=parent,
        author=None,
        guest_name=session.guest_name,
        guest_email=session.guest_email,
        guest_org_label=session.guest_org_label or "",
        guest_session_hash=session.session_hash,
        body=cleaned,
    )
    setattr(comment, fk_attr, target)
    comment.save()

    record_audit(
        organization=organization,
        actor=None,
        action="comment.create",
        target=comment,
        after=snapshot(
            comment,
            extra={
                "kind": "guest",
                "guest_label": session.guest_org_label or "",
            },
        ),
    )

    # Notify the parent-comment author (if any) that a client replied.
    from apps.comments.notifications import (
        enqueue_notifications_for_comment,
    )

    transaction.on_commit(
        lambda cid=comment.id: enqueue_notifications_for_comment(cid)
    )

    schedule_comment_broadcast(comment, "created")
    return comment
