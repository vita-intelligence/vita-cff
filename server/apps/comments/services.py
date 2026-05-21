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

import datetime as _dt
from dataclasses import dataclass
from typing import Any, Sequence

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.db.models import Max, Q, QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.comments.broadcast import schedule_comment_broadcast
from apps.comments.mentions import resolve_mentions
from apps.comments.models import (
    Comment,
    CommentMention,
    ThreadEntityKind,
    ThreadReadState,
)
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


def _proposal_model():
    """Lazy import — ``apps.proposals.models`` pulls a wide dep
    graph (services + render layer), and the comments app needs
    to load before those are ready during initial migrations."""

    from apps.proposals.models import Proposal
    return Proposal


def _cff_submission_model():
    """Lazy import — ``apps.cff_submissions.models`` would pull
    the Wix client + Celery tasks at module load; deferring to
    first-use keeps the comments app importable during migration
    bootstrap when the cff_submissions app may not yet be ready."""

    from apps.cff_submissions.models import CFFSubmission
    return CFFSubmission


_SUPPORTED_TARGETS: dict[type, str] = {
    Formulation: "formulation",
    SpecificationSheet: "specification_sheet",
}


def _supported_targets_dict() -> dict[type, str]:
    """Like ``_SUPPORTED_TARGETS`` but resolved lazily so the
    Proposal + CFFSubmission models can be added without an import
    cycle. The fk_attr for each entry maps to the matching column on
    :class:`Comment` so :func:`create_comment` can ``setattr`` the
    denormalised FK."""

    return {
        **_SUPPORTED_TARGETS,
        _proposal_model(): "proposal",
        _cff_submission_model(): "cff_submission",
    }


def _resolve_target(target) -> tuple[ContentType, Any, str]:
    """Validate ``target`` is one of the supported entity types and
    return ``(content_type, object_id, direct_fk_attr)``.

    Raises :class:`CommentTargetInvalid` for anything else. The three
    returned values are the minimum the create path needs to build a
    polymorphic ``Comment`` row with its denormalised FK populated.
    """

    for model_cls, fk_attr in _supported_targets_dict().items():
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
    # Portal-side authors live on ``client_account`` (with the
    # customer name + company hanging off the bound :class:`Customer`).
    # Pre-loading the chain here keeps the staff-side serializer
    # render path off the N+1 cliff.
    "client_account",
    "client_account__customer",
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

    # Client-visible target classes — comments on these default to
    # ``shared`` so the customer portal can read them. Anything
    # else (formulation / project workspace chatter) stays
    # ``internal`` and only flips via the per-comment toggle.
    CLIENT_VISIBLE_BY_DEFAULT = {
        "specification_sheet",
        "proposal",
        # CFF intake threads default to shared so the customer can
        # follow up on the request they submitted. Existing
        # internal CFF comments are preserved at their original
        # visibility — the per-comment toggle on the staff side
        # still lets a triager flip something internal if they
        # need to discuss something the customer shouldn't see.
        "cff_submission",
    }
    visibility = (
        Comment.Visibility.SHARED
        if fk_attr in CLIENT_VISIBLE_BY_DEFAULT
        else Comment.Visibility.INTERNAL
    )

    comment = Comment(
        organization=organization,
        content_type=content_type,
        object_id=object_id,
        parent=parent,
        author=actor,
        body=cleaned,
        visibility=visibility,
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

    # Mark the thread as read for the author up to the moment they
    # posted. Without this, their own message would show as unread
    # in their own inbox the next time the inbox query polls — the
    # WS fan-out already excludes them, but the REST endpoint
    # computes unread purely from ``created_at > last_read_at`` and
    # would otherwise count their write against them.
    _mark_thread_read_for_author(comment=comment, actor=actor)
    return comment


def _mark_thread_read_for_author(*, comment: Comment, actor) -> None:
    """Upsert the author's read pointer up to ``comment.created_at``.

    No-op for kiosk guests (``actor is None``) — they have no
    user row to attach a read state to, and the kiosk surface
    does not consume the messenger inbox today.
    """

    if actor is None or not getattr(actor, "id", None):
        return
    if comment.formulation_id is not None:
        kind = ThreadEntityKind.FORMULATION.value
        entity_id = comment.formulation_id
    elif comment.specification_sheet_id is not None:
        kind = ThreadEntityKind.SPECIFICATION.value
        entity_id = comment.specification_sheet_id
    elif comment.proposal_id is not None:
        kind = ThreadEntityKind.PROPOSAL.value
        entity_id = comment.proposal_id
    elif comment.cff_submission_id is not None:
        kind = ThreadEntityKind.CFF_SUBMISSION.value
        entity_id = comment.cff_submission_id
    else:
        # Targets we don't (yet) surface in the inbox — nothing to
        # update.
        return
    ThreadReadState.objects.update_or_create(
        user=actor,
        entity_kind=kind,
        entity_id=entity_id,
        defaults={"last_read_at": comment.created_at},
    )


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


# ---------------------------------------------------------------------------
# Messenger inbox — read pointers, unread counts, thread listing.
#
# These functions back the global "messenger bell" surface in the UI:
# the user wants to see new-message indicators for every chat they
# have access to, without having to visit the project / spec page
# first. None of this code touches Channels; the WS push happens
# upstream in :func:`schedule_comment_broadcast` (which fans out an
# ``inbox.message`` envelope to every org-member at create-time). The
# REST endpoints below are the FE's reconciliation path on first
# render + on every "I missed events while disconnected" refetch.
# ---------------------------------------------------------------------------


#: Sentinel "the user has never read anything" timestamp. Threads
#: with no ``ThreadReadState`` row default to this, which makes every
#: comment unread on first sight — the messenger bell lights up the
#: moment the user is added to an org with active chats.
_UNIX_EPOCH = _dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)


@dataclass(frozen=True)
class InboxAuthor:
    """Compact author shape for an inbox row's preview line."""

    name: str
    kind: str  # "member" / "guest" / "system"


@dataclass(frozen=True)
class InboxThread:
    """One row in the messenger inbox.

    Carries everything the dropdown needs to render a list item
    without follow-up fetches: the entity label + code so we can
    show 'CFF-128 · Morning Vital Boost', the unread count for the
    badge, and a single-line preview of the latest message so the
    user can decide whether to open the thread.
    """

    organization_id: str
    organization_name: str
    entity_kind: str
    entity_id: str
    entity_title: str
    entity_code: str
    unread_count: int
    last_message_at: _dt.datetime
    last_message_preview: str
    last_message_author: InboxAuthor


def _accessible_organizations_for_user(user) -> list[Organization]:
    """Return every organisation in which ``user`` may see comments.

    The inbox surface bypasses the project-workspace route entirely
    (the bell is global), so we cannot rely on the page-level
    ``formulations.view`` gate to keep an audience out. Without an
    additional check here, a user granted ``comments_view`` but not
    ``view`` would see chats from projects they cannot otherwise
    reach in the app — a real RBAC leak even though the per-thread
    REST endpoint enforces the same ``comments_view`` rule.

    Eligibility therefore requires **both** capabilities in the
    same org:

    * ``formulations.view`` — the project-visibility gate that
      governs the formulations index and every individual project
      page (also the gate the specifications surface piggybacks on
      for its base view, falling back to ``view_signed`` /
      ``view_approvals`` for the role-scoped read-only flows we
      surface separately on those pages).
    * ``formulations.comments_view`` — the chat-visibility gate the
      per-entity REST + WS layers also enforce.

    Owners short-circuit ``has_capability`` so workspace owners
    always pass. Inactive workspaces are filtered out (pre-billing
    state) unless the caller is a superuser, matching the wider
    :func:`is_organization_accessible` contract.
    """

    # Local import — these modules import service code from this
    # file in the other direction at module load on some paths.
    from apps.organizations.models import Membership
    from apps.organizations.modules import (
        FORMULATIONS_MODULE,
        FormulationsCapability,
    )
    from apps.organizations.services import has_capability

    memberships = (
        Membership.objects.filter(user=user)
        .select_related("organization")
    )
    eligible: list[Organization] = []
    for membership in memberships:
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.VIEW,
        ):
            continue
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_VIEW,
        ):
            continue
        if not membership.organization.is_active and not getattr(
            user, "is_superuser", False
        ):
            # Mirror :func:`is_organization_accessible` — pre-billing
            # workspaces are read-only to non-superusers.
            continue
        eligible.append(membership.organization)
    return eligible


def _preview_for_comment(comment: Comment, *, max_chars: int = 140) -> str:
    """Single-line preview text the dropdown renders next to the
    author name. Strips newlines so a multi-paragraph comment doesn't
    smear the row, and truncates with an ellipsis past ``max_chars``.

    Deleted comments render as the empty string — the FE shows a
    "(message deleted)" placeholder in that case.
    """

    if comment.is_deleted:
        return ""
    body = (comment.body or "").strip().replace("\n", " ")
    if len(body) <= max_chars:
        return body
    # Cut on whitespace if possible so we never split a word mid-character.
    cut = body[:max_chars].rsplit(" ", 1)[0]
    return f"{cut}…"


def _author_snapshot(comment: Comment) -> InboxAuthor:
    """Compact author shape for the inbox preview — same name-resolution
    logic as the in-page broadcast, kept minimal here because the
    dropdown only ever shows a one-line summary."""

    if comment.is_deleted:
        return InboxAuthor(name="", kind="system")
    if comment.author_id and comment.author is not None:
        user = comment.author
        full = (user.get_full_name() or user.email or "").strip()
        return InboxAuthor(name=full, kind="member")
    if comment.client_account_id and comment.client_account is not None:
        # Portal-authored comment. ClientAccount has no ``full_name``
        # field — the canonical display label is the bound Customer's
        # contact name, with the company as the next-best fallback.
        customer = comment.client_account.customer
        name = (
            (customer.name or "").strip()
            or (customer.company or "").strip()
            or comment.client_account.email
        )
        return InboxAuthor(name=name, kind="client")
    return InboxAuthor(
        name=(comment.guest_name or comment.guest_email or "").strip(),
        kind="guest",
    )


@transaction.atomic
def mark_thread_read(
    *,
    user,
    entity_kind: str,
    entity_id: Any,
    at: _dt.datetime | None = None,
) -> ThreadReadState:
    """Upsert the read pointer for ``(user, entity_kind, entity_id)``.

    Caller is responsible for authorising the user against the entity
    — the view layer does this via the same membership + capability
    check the WS consumer enforces. Unknown ``entity_kind`` values
    are refused so a typo in the URL can't seed orphan rows that
    never match a real thread.

    ``at`` defaults to ``timezone.now()`` (the common "I just opened
    this thread" case). Callers can pass an explicit timestamp when
    "I have read up to the message at T" is the right semantic
    (e.g. a scroll-to-bottom event tied to a specific message).
    """

    if entity_kind not in ThreadEntityKind.values:
        raise ValueError(
            f"Unsupported entity_kind for thread read state: {entity_kind!r}"
        )

    timestamp = at or timezone.now()
    state, _created = ThreadReadState.objects.update_or_create(
        user=user,
        entity_kind=entity_kind,
        entity_id=entity_id,
        defaults={"last_read_at": timestamp},
    )
    return state


def list_inbox_threads(*, user) -> list[InboxThread]:
    """Return every chat ``user`` can see, with unread counts +
    previews, newest activity first.

    Implementation note: one query per (org, entity-kind) for the
    entity list, then one ``COUNT`` + one ``ORDER BY`` per entity
    for unread + latest. For Vita-scale tenants (tens of projects,
    one chat each) that's bounded at low double-digit queries, well
    inside the dropdown's perf budget. We optimise later if real
    workloads ever push past a hundred active threads.
    """

    organizations = _accessible_organizations_for_user(user)
    # CFF threads have their own capability axis — a commercial /
    # triage role may have ``cff_submissions.view`` without holding
    # ``formulations.view`` (CFF is upstream of the project
    # workspace). Surface CFF threads from any org that grants CFF
    # view, even when the formulations gate would otherwise exclude
    # it from the main inbox list.
    cff_organizations = _cff_accessible_organizations_for_user(user)
    if not organizations and not cff_organizations:
        return []

    # Read pointers loaded up front so per-thread access is O(1).
    pointer_rows = ThreadReadState.objects.filter(user=user).values_list(
        "entity_kind", "entity_id", "last_read_at"
    )
    pointers: dict[tuple[str, str], _dt.datetime] = {
        (kind, str(eid)): ts for kind, eid, ts in pointer_rows
    }

    threads: list[InboxThread] = []

    for organization in organizations:
        threads.extend(
            _inbox_threads_for_formulations(
                organization=organization, pointers=pointers
            )
        )
        threads.extend(
            _inbox_threads_for_specifications(
                organization=organization, pointers=pointers
            )
        )
        threads.extend(
            _inbox_threads_for_proposals(
                organization=organization, pointers=pointers
            )
        )

    # CFF threads — independent capability gate so we walk the
    # cff-accessible set rather than the formulations-accessible
    # one. Same per-thread shape, same pointer map.
    for organization in cff_organizations:
        threads.extend(
            _inbox_threads_for_cff_submissions(
                organization=organization, pointers=pointers
            )
        )

    threads.sort(key=lambda t: t.last_message_at, reverse=True)
    return threads


def compute_total_unread(*, user) -> int:
    """Sum of unread comments across every thread the user can see.

    Powers the bell badge — the FE polls this on bell mount + on
    every inbox WS event as a cheap reconciliation against the
    optimistic local counter. We could maintain a denormalised
    counter row, but the query as written is one COUNT per active
    thread and the FE only fires this on user-visible state changes,
    so the simpler shape wins.
    """

    return sum(thread.unread_count for thread in list_inbox_threads(user=user))


# ---- internals -------------------------------------------------------------


def _inbox_threads_for_formulations(
    *,
    organization: Organization,
    pointers: dict[tuple[str, str], _dt.datetime],
) -> list[InboxThread]:
    """Build the inbox rows for every formulation in ``organization``
    that has at least one non-deleted comment."""

    formulations = (
        Formulation.objects.filter(
            organization=organization,
            comments__isnull=False,
            comments__is_deleted=False,
        )
        .annotate(last_at=Max("comments__created_at"))
        .distinct()
        .order_by("-last_at")
    )
    rows: list[InboxThread] = []
    for formulation in formulations:
        latest = (
            Comment.objects.filter(
                formulation=formulation, is_deleted=False
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = pointers.get(("formulation", str(formulation.id)), _UNIX_EPOCH)
        unread = Comment.objects.filter(
            formulation=formulation,
            is_deleted=False,
            created_at__gt=last_read,
        ).count()
        rows.append(
            InboxThread(
                organization_id=str(organization.id),
                organization_name=organization.name,
                entity_kind=ThreadEntityKind.FORMULATION.value,
                entity_id=str(formulation.id),
                entity_title=(formulation.name or "").strip(),
                entity_code=(formulation.code or "").strip(),
                unread_count=unread,
                last_message_at=latest.created_at,
                last_message_preview=_preview_for_comment(latest),
                last_message_author=_author_snapshot(latest),
            )
        )
    return rows


def _inbox_threads_for_proposals(
    *,
    organization: Organization,
    pointers: dict[tuple[str, str], _dt.datetime],
) -> list[InboxThread]:
    """Build the inbox rows for every proposal in ``organization``
    that has at least one non-deleted comment. Mirrors the
    formulation / specification helpers — same query shape, same
    pointer lookup, same preview snapshot — so the bell + dropdown
    surface customer-portal proposal chat alongside the project
    threads without any further plumbing on the FE."""

    Proposal = _proposal_model()
    proposals = (
        Proposal.objects.filter(
            organization=organization,
            comments__isnull=False,
            comments__is_deleted=False,
        )
        .annotate(last_at=Max("comments__created_at"))
        .distinct()
        .order_by("-last_at")
    )
    rows: list[InboxThread] = []
    for proposal in proposals:
        latest = (
            Comment.objects.filter(
                proposal=proposal, is_deleted=False
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = pointers.get(
            ("proposal", str(proposal.id)), _UNIX_EPOCH
        )
        unread = Comment.objects.filter(
            proposal=proposal,
            is_deleted=False,
            created_at__gt=last_read,
        ).count()
        # Proposals carry a ``code`` (e.g. ``PROP-0123``) — best
        # title for the dropdown. Fall back to the customer
        # company so a code-less draft still reads sensibly.
        title = (
            (getattr(proposal, "code", "") or "").strip()
            or (getattr(proposal, "customer_company", "") or "").strip()
            or (getattr(proposal, "customer_name", "") or "").strip()
        )
        rows.append(
            InboxThread(
                organization_id=str(organization.id),
                organization_name=organization.name,
                entity_kind=ThreadEntityKind.PROPOSAL.value,
                entity_id=str(proposal.id),
                entity_title=title,
                entity_code=(getattr(proposal, "code", "") or "").strip(),
                unread_count=unread,
                last_message_at=latest.created_at,
                last_message_preview=_preview_for_comment(latest),
                last_message_author=_author_snapshot(latest),
            )
        )
    return rows


def _cff_accessible_organizations_for_user(user) -> list[Organization]:
    """Return every organisation in which ``user`` may see CFF chats.

    Parallels :func:`_accessible_organizations_for_user` but gates on
    the CFF module's ``view`` capability instead of the formulations
    pair. CFF triage is its own role (commercial / customer-success
    members often need to read inbound requests without holding
    projects rights), so the inbox includes their CFF threads even
    when the user is excluded from the formulations gate above.
    """

    from apps.organizations.models import Membership
    from apps.organizations.modules import (
        CFF_SUBMISSIONS_MODULE,
        CFFSubmissionsCapability,
    )
    from apps.organizations.services import has_capability

    memberships = (
        Membership.objects.filter(user=user)
        .select_related("organization")
    )
    eligible: list[Organization] = []
    for membership in memberships:
        if not has_capability(
            membership,
            CFF_SUBMISSIONS_MODULE,
            CFFSubmissionsCapability.VIEW,
        ):
            continue
        if not membership.organization.is_active and not getattr(
            user, "is_superuser", False
        ):
            continue
        eligible.append(membership.organization)
    return eligible


def _inbox_threads_for_cff_submissions(
    *,
    organization: Organization,
    pointers: dict[tuple[str, str], _dt.datetime],
) -> list[InboxThread]:
    """Build the inbox rows for every CFF submission in
    ``organization`` that has at least one non-deleted comment.

    Same query / preview / pointer shape as the formulation +
    proposal helpers so the FE renders CFF chats identically in
    the bell dropdown — the only difference is the title source
    (CFF rows carry the customer-typed company / email rather
    than an internal code).
    """

    CFFSubmission = _cff_submission_model()
    cffs = (
        CFFSubmission.objects.filter(
            organization=organization,
            comments__isnull=False,
            comments__is_deleted=False,
        )
        .annotate(last_at=Max("comments__created_at"))
        .distinct()
        .order_by("-last_at")
    )
    rows: list[InboxThread] = []
    for cff in cffs:
        latest = (
            Comment.objects.filter(
                cff_submission=cff, is_deleted=False
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = pointers.get(
            ("cff_submission", str(cff.id)), _UNIX_EPOCH
        )
        unread = Comment.objects.filter(
            cff_submission=cff,
            is_deleted=False,
            created_at__gt=last_read,
        ).count()
        # CFF row has no team-side title — best fall-backs are the
        # customer's company / email from the raw payload preview
        # the inbox view already computes, but we don't have access
        # to that here. Use the short id slice — the FE rehydrates
        # the title from its own CFF list cache when the dropdown
        # opens. (Same fallback pattern the messenger toast uses.)
        title = f"CFF · {str(cff.id)[:8]}"
        rows.append(
            InboxThread(
                organization_id=str(organization.id),
                organization_name=organization.name,
                entity_kind=ThreadEntityKind.CFF_SUBMISSION.value,
                entity_id=str(cff.id),
                entity_title=title,
                entity_code="",
                unread_count=unread,
                last_message_at=latest.created_at,
                last_message_preview=_preview_for_comment(latest),
                last_message_author=_author_snapshot(latest),
            )
        )
    return rows


def _inbox_threads_for_specifications(
    *,
    organization: Organization,
    pointers: dict[tuple[str, str], _dt.datetime],
) -> list[InboxThread]:
    """Build the inbox rows for every specification sheet in
    ``organization`` that has at least one non-deleted comment."""

    sheets = (
        SpecificationSheet.objects.filter(
            organization=organization,
            comments__isnull=False,
            comments__is_deleted=False,
        )
        .annotate(last_at=Max("comments__created_at"))
        .distinct()
        .order_by("-last_at")
    )
    rows: list[InboxThread] = []
    for sheet in sheets:
        latest = (
            Comment.objects.filter(
                specification_sheet=sheet, is_deleted=False
            )
            .select_related("author", "client_account__customer")
            .order_by("-created_at")
            .first()
        )
        if latest is None:
            continue
        last_read = pointers.get(
            ("specification", str(sheet.id)), _UNIX_EPOCH
        )
        unread = Comment.objects.filter(
            specification_sheet=sheet,
            is_deleted=False,
            created_at__gt=last_read,
        ).count()
        # Specifications have no name field — fall back to client
        # company / code so the dropdown always shows *something*.
        title = (sheet.code or sheet.client_company or "").strip()
        rows.append(
            InboxThread(
                organization_id=str(organization.id),
                organization_name=organization.name,
                entity_kind=ThreadEntityKind.SPECIFICATION.value,
                entity_id=str(sheet.id),
                entity_title=title,
                entity_code=(sheet.code or "").strip(),
                unread_count=unread,
                last_message_at=latest.created_at,
                last_message_preview=_preview_for_comment(latest),
                last_message_author=_author_snapshot(latest),
            )
        )
    return rows
