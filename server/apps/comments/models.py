"""Domain models for the comments app.

A :class:`Comment` is a polymorphic row attached to any project-workspace
target: a :class:`~apps.formulations.models.Formulation` or a
:class:`~apps.specifications.models.SpecificationSheet` today,
``TrialBatch`` / ``ProductValidation`` later. The polymorphic plumbing is
Django's :mod:`contenttypes` framework, plus nullable direct FKs to the
two entities commit 1 supports — the direct FKs let list endpoints and
resolve-count queries stay on fast indexed paths without joining
``django_content_type`` on every read.

Threading is deliberately **one level deep**: a root comment plus flat
replies. The model enforces this in :meth:`Comment.clean` — a reply
whose parent is itself a reply is rejected. Same shape Asana uses, and
it keeps the UI predictable: no deeply nested trees to indent.

Kiosk / guest identity lands in commit 6 of the comments roadmap.
Commit 1 ships the schema so later commits never need a migration:

* :attr:`Comment.author` is nullable — a kiosk guest has no user.
* :attr:`Comment.guest_name`, :attr:`Comment.guest_email`,
  :attr:`Comment.guest_session_hash` carry the guest identity once
  :class:`KioskSession` is wired through the public API. A row-level
  :class:`~django.db.models.CheckConstraint` asserts that **every**
  comment has either an authenticated author or a fully-populated guest
  triple, so a bug in the service layer cannot create an orphan row.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class CommentNotificationKind(models.TextChoices):
    MENTION = "mention", _("Mention")
    REPLY = "reply", _("Reply")


class CommentNotificationStatus(models.TextChoices):
    QUEUED = "queued", _("Queued")
    SENT = "sent", _("Sent")
    FAILED = "failed", _("Failed")


class Comment(models.Model):
    """A threaded, polymorphic comment on a project-workspace target."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="comments",
    )

    # Polymorphic target — keeps the door open for ``TrialBatch`` /
    # ``ProductValidation`` in later phases without a schema migration.
    content_type = models.ForeignKey(
        ContentType,
        on_delete=models.PROTECT,
        related_name="+",
    )
    object_id = models.UUIDField(db_index=True)
    target = GenericForeignKey("content_type", "object_id")

    # Denormalised fast-path FKs. Populated by :func:`save` from the
    # generic FK. Nullable so a comment on a future entity (e.g. a
    # trial batch) does not require either column to exist. List /
    # resolve-count queries hit these columns directly to avoid a join
    # through ``django_content_type`` on the hot path.
    formulation = models.ForeignKey(
        "formulations.Formulation",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comments",
    )
    specification_sheet = models.ForeignKey(
        "specifications.SpecificationSheet",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comments",
    )
    #: Denormalised FK for proposal-level threads. Populated when
    #: a comment targets a :class:`apps.proposals.models.Proposal`
    #: row directly (the customer portal's "messages about this
    #: proposal" surface). Mirrors the ``formulation`` + ``specification_sheet``
    #: fast-path columns — list queries hit this directly instead of
    #: joining through ``django_content_type``.
    proposal = models.ForeignKey(
        "proposals.Proposal",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comments",
    )

    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="replies",
        help_text=_(
            "Root comments have ``parent = NULL``. Replies point at a root "
            "comment. Two-level nesting is rejected in ``clean()`` — UI "
            "convention matches Asana: flat replies under a single thread."
        ),
    )

    # Identity. Exactly one of (author), (client_account), or
    # (guest_name+guest_email) is required — the check constraint
    # below enforces it at the DB level so a service-layer bug
    # cannot create an orphan row.
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="authored_comments",
        help_text=_(
            "The authenticated staff member who wrote the comment. "
            "Null for kiosk guests (legacy) and for portal client "
            "authors (see ``client_account``)."
        ),
    )
    #: Customer-portal author. Set when an authenticated
    #: :class:`apps.client_portal.models.ClientAccount` posts via
    #: the portal API. Mutually exclusive with ``author`` — the
    #: constraint below enforces "exactly one identity path".
    client_account = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="authored_comments",
        help_text=_(
            "The portal client who wrote the comment. NULL for "
            "staff-authored comments and for legacy kiosk-guest "
            "rows. Adding this as a separate FK (rather than a "
            "polymorphic GenericFK) keeps the JOIN cheap and the "
            "staff comments query unchanged."
        ),
    )
    guest_name = models.CharField(
        _("guest name"), max_length=120, blank=True, default=""
    )
    guest_email = models.EmailField(
        _("guest email"), blank=True, default=""
    )
    #: Optional company / org label the guest typed during
    #: identity capture. We keep it on the ``Comment`` row rather
    #: than joining through :class:`KioskSession` at read time so
    #: revoking or deleting the session leaves the historical
    #: attribution intact — the client team still sees "Jane Doe
    #: (ACME Corp)" on a comment they read last week.
    guest_org_label = models.CharField(
        _("guest organisation label"),
        max_length=120,
        blank=True,
        default="",
    )
    guest_session_hash = models.CharField(
        _("guest session hash"),
        max_length=64,
        blank=True,
        default="",
        db_index=True,
        help_text=_(
            "SHA-256 of the signed kiosk session cookie. Used by the "
            "rate-limiter + duplicate-submit guard in the public comment "
            "endpoint. Blank for authenticated authors."
        ),
    )

    #: Who can see this comment. ``internal`` (the default) means
    #: staff-only — the customer portal never surfaces these. ``shared``
    #: means visible to both staff AND the client whose customer this
    #: comment's target belongs to. Project-level comments default to
    #: ``internal``; spec sheet comments posted from the portal default
    #: to ``shared`` (the client started the thread).
    class Visibility(models.TextChoices):
        INTERNAL = "internal", _("Internal")
        SHARED = "shared", _("Shared")

    visibility = models.CharField(
        _("visibility"),
        max_length=16,
        choices=Visibility.choices,
        default=Visibility.INTERNAL,
        db_index=True,
        help_text=_(
            "``internal`` is staff-only; ``shared`` is visible to "
            "both the staff team and the portal client whose "
            "customer this comment's target belongs to."
        ),
    )

    body = models.TextField(_("body"))

    #: Cached list of mentioned user UUIDs parsed out of ``body`` at
    #: write time. The canonical list lives in :class:`CommentMention`
    #: — this column is a denormalised read-path for the serialiser so
    #: a single comment fetch does not trigger an extra query.
    mentions_cache = models.JSONField(
        _("mentions cache"),
        default=list,
        blank=True,
    )

    # Thread resolution — root-only. A check constraint ensures a reply
    # can never be marked resolved so the UI never has to reason about
    # "what does it mean for a reply to be resolved?".
    #
    # ``needs_resolution`` is the explicit "flag this as a task / open
    # question" gesture a teammate makes. Only flagged roots show the
    # Resolve button + pin to the top of the thread list. Resolving
    # clears the flag in the same write so the comment drops back into
    # normal chronological order.
    needs_resolution = models.BooleanField(
        _("needs resolution"), default=False
    )
    is_resolved = models.BooleanField(_("resolved"), default=False)
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="resolved_comments",
    )
    resolved_at = models.DateTimeField(_("resolved at"), null=True, blank=True)

    is_edited = models.BooleanField(_("edited"), default=False)
    edited_at = models.DateTimeField(_("edited at"), null=True, blank=True)

    # Soft delete — body is cleared, row is retained so thread
    # continuity and audit references survive. The UI renders a
    # tombstone ("This comment was deleted.") in place of the body.
    is_deleted = models.BooleanField(_("deleted"), default=False)
    deleted_at = models.DateTimeField(_("deleted at"), null=True, blank=True)
    deleted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deleted_comments",
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("comment")
        verbose_name_plural = _("comments")
        ordering = ("created_at",)
        indexes = [
            models.Index(
                fields=("organization", "content_type", "object_id", "created_at"),
                name="comments_target_created_idx",
            ),
            models.Index(
                fields=("formulation", "is_resolved", "created_at"),
                name="comments_formulation_idx",
            ),
            models.Index(
                fields=("specification_sheet", "is_resolved", "created_at"),
                name="comments_spec_idx",
            ),
            models.Index(
                fields=("parent", "created_at"),
                name="comments_parent_idx",
            ),
        ]
        constraints = [
            # Resolution only on root threads. A reply never carries
            # its own resolved state — the UI reads the root's flag.
            models.CheckConstraint(
                name="comments_resolve_root_only",
                condition=(
                    models.Q(is_resolved=False)
                    | models.Q(parent__isnull=True)
                ),
            ),
            # Same root-only rule for the "needs resolution" flag.
            # Flagging a reply has no product meaning — the thread is
            # the unit we resolve, and replies live underneath it.
            models.CheckConstraint(
                name="comments_needs_resolution_root_only",
                condition=(
                    models.Q(needs_resolution=False)
                    | models.Q(parent__isnull=True)
                ),
            ),
            # Identity is mandatory. Three valid shapes:
            #   1. staff author    — ``author`` set
            #   2. portal client   — ``client_account`` set
            #   3. legacy kiosk    — both guest_name + guest_email set
            # Exactly one of (1) and (2) is allowed — the service layer
            # never sets both, and the DB-level
            # ``comments_identity_single_path`` constraint below makes
            # that explicit.
            models.CheckConstraint(
                name="comments_identity_required",
                condition=(
                    models.Q(author__isnull=False)
                    | models.Q(client_account__isnull=False)
                    | (
                        ~models.Q(guest_name="")
                        & ~models.Q(guest_email="")
                    )
                ),
            ),
            # No row can be authored by BOTH a staff user AND a portal
            # client simultaneously. The frontend chooses the right
            # identity based on which session cookie it sends; this
            # constraint catches a service-layer bug that wires both
            # FKs by mistake.
            models.CheckConstraint(
                name="comments_identity_single_path",
                condition=(
                    models.Q(author__isnull=True)
                    | models.Q(client_account__isnull=True)
                ),
            ),
        ]

    def __str__(self) -> str:
        author_label = self.author_id or self.guest_email or "anonymous"
        return f"Comment({self.pk}) by {author_label}"

    def clean(self) -> None:
        super().clean()
        # Threading depth cap — matches Asana's "flat replies" pattern.
        # A reply's parent must itself be a root (``parent IS NULL``).
        if self.parent_id is not None and self.parent is not None:
            if self.parent.parent_id is not None:
                raise ValidationError(
                    {"parent": _("Replies may not nest beyond one level.")}
                )
        # Resolution only on roots.
        if self.is_resolved and self.parent_id is not None:
            raise ValidationError(
                {
                    "is_resolved": _(
                        "Only root comments can be marked resolved."
                    )
                }
            )
        # Same for the "needs resolution" flag — the thread, not any
        # individual reply, is what gets flagged as a task to close.
        if self.needs_resolution and self.parent_id is not None:
            raise ValidationError(
                {
                    "needs_resolution": _(
                        "Only root comments can be flagged for resolution."
                    )
                }
            )


class CommentReadState(models.Model):
    """Per-thread last-read timestamp for one viewer.

    Powers the "Seen ✓" tick the portal renders on messages older
    than the other side's last read. Keyed on the *target* a thread
    belongs to (formulation OR spec sheet OR proposal) rather than a
    synthetic "thread id" because the comments app keeps threads
    implicit — they live as ``parent IS NULL`` rows scoped to a
    polymorphic target. One row per ``(target, viewer)``.

    Viewer is a soft polymorphism: a row is owned by *either* a
    staff :class:`User` *or* a portal
    :class:`apps.client_portal.models.ClientAccount`. The CHECK
    constraint enforces "exactly one viewer set" so a malformed
    row can't silently masquerade as either side.

    Per-thread (not per-message) is a deliberate scale choice —
    storage is O(threads × participants) rather than
    O(messages × participants). Slack and Linear use the same
    pattern.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="comment_read_states",
    )

    # Thread target — exactly the same polymorphic shape as
    # :class:`Comment`. Mirroring the columns (rather than joining
    # through the comments table) keeps the "is this thread stale
    # for me?" query a single point lookup.
    content_type = models.ForeignKey(
        ContentType,
        on_delete=models.PROTECT,
        related_name="+",
    )
    object_id = models.UUIDField(db_index=True)

    # Viewer — exactly one side set.
    viewer_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comment_read_states",
    )
    viewer_client = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="comment_read_states",
    )

    last_read_at = models.DateTimeField(
        help_text=_(
            "Every comment with ``created_at <= last_read_at`` is "
            "considered seen by this viewer. The portal / staff UI "
            "bumps this on thread-open and on every new message "
            "rendered while the tab is foregrounded."
        ),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("comment read state")
        verbose_name_plural = _("comment read states")
        indexes = [
            models.Index(
                fields=("viewer_user", "content_type", "object_id"),
                name="crs_user_target_idx",
            ),
            models.Index(
                fields=("viewer_client", "content_type", "object_id"),
                name="crs_client_target_idx",
            ),
        ]
        constraints = [
            # Exactly one viewer.
            models.CheckConstraint(
                name="crs_one_viewer",
                condition=(
                    (
                        models.Q(viewer_user__isnull=False)
                        & models.Q(viewer_client__isnull=True)
                    )
                    | (
                        models.Q(viewer_user__isnull=True)
                        & models.Q(viewer_client__isnull=False)
                    )
                ),
            ),
            # Unique per (viewer, target).
            models.UniqueConstraint(
                fields=("viewer_user", "content_type", "object_id"),
                condition=models.Q(viewer_user__isnull=False),
                name="crs_unique_user_target",
            ),
            models.UniqueConstraint(
                fields=("viewer_client", "content_type", "object_id"),
                condition=models.Q(viewer_client__isnull=False),
                name="crs_unique_client_target",
            ),
        ]

    def __str__(self) -> str:
        viewer = self.viewer_user_id or self.viewer_client_id or "?"
        return f"CommentReadState(viewer={viewer}, target={self.object_id})"


class CommentMention(models.Model):
    """One row per user @-mentioned in a comment body.

    The column is populated on comment create / edit so the
    notification dispatcher has a single read to answer "who needs an
    email for this comment?" — email delivery never re-parses the
    body. Replying to your own mention is a valid write (we simply
    skip the self-notification downstream).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    comment = models.ForeignKey(
        Comment,
        on_delete=models.CASCADE,
        related_name="mentions",
    )
    mentioned_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="mentions_received",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("comment mention")
        verbose_name_plural = _("comment mentions")
        constraints = [
            models.UniqueConstraint(
                fields=("comment", "mentioned_user"),
                name="comment_mentions_unique",
            ),
        ]
        indexes = [
            models.Index(fields=("mentioned_user", "-created_at")),
        ]

    def __str__(self) -> str:
        return f"Mention({self.mentioned_user_id} in {self.comment_id})"


class CommentNotification(models.Model):
    """Dedup ledger for outbound notification emails.

    Each (comment, recipient, kind) tuple lands in here exactly once —
    the unique constraint is the dedupe key. A retry of the email
    dispatcher finds the existing row and updates its ``status``
    instead of sending a second copy. Also lets an admin audit
    delivery state without opening the SMTP logs.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    comment = models.ForeignKey(
        Comment,
        on_delete=models.CASCADE,
        related_name="notifications",
    )
    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="comment_notifications",
    )
    kind = models.CharField(
        _("kind"),
        max_length=16,
        choices=CommentNotificationKind.choices,
    )
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=CommentNotificationStatus.choices,
        default=CommentNotificationStatus.QUEUED,
    )
    error = models.TextField(_("error"), blank=True, default="")

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    sent_at = models.DateTimeField(_("sent at"), null=True, blank=True)

    class Meta:
        verbose_name = _("comment notification")
        verbose_name_plural = _("comment notifications")
        constraints = [
            models.UniqueConstraint(
                fields=("comment", "recipient", "kind"),
                name="comment_notifications_unique",
            ),
        ]
        indexes = [
            models.Index(fields=("recipient", "-created_at")),
            models.Index(fields=("status",)),
        ]

    def __str__(self) -> str:
        return f"Notification({self.kind} → {self.recipient_id})"


class KioskSession(models.Model):
    """Persistent identity for an unauthenticated kiosk commenter.

    Not consumed by commit 1 — the authed REST paths never write a
    :class:`KioskSession`. Shipping the table now avoids a second
    migration when the kiosk commit lands.

    Flow (commit 6): the client's browser hits ``POST /api/public/
    specifications/<token>/identify/`` with name + email. The view
    creates a :class:`KioskSession` and returns a signed cookie whose
    SHA-256 hash equals :attr:`session_hash`. Subsequent public
    comment writes look up the row via the hash, inherit
    ``guest_name`` / ``guest_email`` for the comment, and bump
    ``last_seen_at``. Revocation is a row update (``revoked_at``) so
    a rotated share token immediately invalidates every open session.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    public_token = models.UUIDField(
        _("public token"),
        db_index=True,
        help_text=_(
            "The share-link token the session belongs to. Not a FK so "
            "rotating the token on the spec sheet does not cascade-"
            "delete history — revocation is driven by ``revoked_at``."
        ),
    )
    guest_name = models.CharField(_("guest name"), max_length=120)
    guest_email = models.EmailField(_("guest email"))
    guest_org_label = models.CharField(
        _("guest organisation label"),
        max_length=120,
        blank=True,
        default="",
    )
    session_hash = models.CharField(
        _("session hash"), max_length=64, unique=True
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    last_seen_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(_("revoked at"), null=True, blank=True)

    class Meta:
        verbose_name = _("kiosk session")
        verbose_name_plural = _("kiosk sessions")
        indexes = [
            models.Index(fields=("public_token", "-last_seen_at")),
        ]

    def __str__(self) -> str:
        return f"KioskSession({self.guest_email} @ {self.public_token})"


class ThreadEntityKind(models.TextChoices):
    """The supported comment-thread targets, mirrored from the polymorphic
    set on :class:`Comment`. Kept as a closed set here so a typo in the
    inbox path cannot create an orphan read-state row whose ``entity_kind``
    doesn't match any consumer route or REST endpoint."""

    FORMULATION = "formulation", _("Formulation")
    SPECIFICATION = "specification", _("Specification")
    PROPOSAL = "proposal", _("Proposal")


class ThreadReadState(models.Model):
    """Per-user read pointer for one comment thread.

    The messenger inbox surface needs to answer two questions on every
    render: "how many unread messages do I have across all threads I
    can see?" and "for each thread, what's my unread count?". Both
    reduce to ``COUNT(*) FROM comments c WHERE c.target = X AND
    c.created_at > my_last_read_at``, which is fast as long as the
    read pointer is row-shaped + indexed — JSON-on-Membership would
    not index for the "all threads I have unread on" sweep the bell
    badge needs.

    Lifecycle:

    * Created lazily — the first :func:`mark_thread_read` for a
      ``(user, kind, id)`` tuple INSERTs the row. Threads the user has
      never visited contribute "everything is unread" to the inbox
      via ``COALESCE(last_read_at, '1970-01-01')`` in the service
      layer.
    * Updated by :func:`mark_thread_read` — bumps ``last_read_at`` to
      either ``timezone.now()`` (FE: "I opened this thread") or to a
      caller-supplied timestamp (FE: "I scrolled to the bottom and
      the newest message I saw was at T").
    * Never deleted on entity removal — the read state row becomes an
      orphan that never matches any thread again. Cheap to leave; a
      future cron can sweep them up if storage ever matters.

    The ``organization`` FK is deliberately omitted. It's derivable
    through the entity and adding it here would create a denormalised
    field that could drift if a workspace is ever migrated. Inbox
    queries always JOIN through the entity to fetch the project
    title anyway, so the org row comes along for free.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="thread_read_states",
    )
    entity_kind = models.CharField(
        _("entity kind"),
        max_length=24,
        choices=ThreadEntityKind.choices,
    )
    entity_id = models.UUIDField(_("entity id"), db_index=True)

    #: Timestamp of the most recent comment the user has acknowledged.
    #: All comments on the thread with ``created_at > last_read_at`` are
    #: counted as unread. The column is monotonic non-decreasing — the
    #: service layer rejects bumps that would move the pointer
    #: backwards so a stale "I read this" from a slow client cannot
    #: re-surface already-read messages.
    last_read_at = models.DateTimeField(_("last read at"), default=timezone.now)

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("thread read state")
        verbose_name_plural = _("thread read states")
        constraints = [
            # One row per (user, thread). The upsert in the service
            # layer relies on this constraint to convert a duplicate
            # write into an update without a SELECT-then-INSERT race.
            models.UniqueConstraint(
                fields=("user", "entity_kind", "entity_id"),
                name="thread_read_state_unique",
            ),
        ]
        indexes = [
            # The inbox "unread count for bell badge" sweep filters by
            # ``user`` and reads ``last_read_at`` for every row — this
            # index lets the planner skip a heap scan on big tenants.
            models.Index(
                fields=("user", "-last_read_at"),
                name="thread_read_state_user_idx",
            ),
        ]

    def __str__(self) -> str:
        return (
            f"ThreadReadState(user={self.user_id}, "
            f"{self.entity_kind}={self.entity_id}, "
            f"last_read_at={self.last_read_at.isoformat()})"
        )


class KioskAlertStatus(models.TextChoices):
    QUEUED = "queued", _("Queued")
    SENT = "sent", _("Sent")
    FAILED = "failed", _("Failed")
    SKIPPED = "skipped", _("Skipped (cooldown)")


class KioskAlert(models.Model):
    """One row per outbound "notify the client" email.

    Triggered by a team member clicking the **Notify client** action
    on a spec-sheet chat. Unlike :class:`CommentNotification` (which
    is wired to mention + reply emails and is keyed on the comment
    that caused the send), a kiosk alert is a deliberate team
    gesture not tied to a specific message — the trigger is "we'd
    like the customer to come back and look at this sheet now".

    The ledger doubles as the cooldown gate: before sending we look
    for any sibling row for the same ``(sheet, recipient_email)``
    sent within :data:`KIOSK_ALERT_COOLDOWN_SECONDS` and skip if so.
    That stops a double-click from delivering two emails and lets a
    quick burst of team activity collapse into a single customer
    notification.

    A ``SKIPPED`` row is still inserted on cooldown so the UI can
    surface the "Last notified X ago" hint without scanning sent
    rows separately.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    sheet = models.ForeignKey(
        "specifications.SpecificationSheet",
        on_delete=models.CASCADE,
        related_name="kiosk_alerts",
    )
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="kiosk_alerts",
    )

    #: Email the alert was addressed to. Stored verbatim so an admin
    #: looking at the ledger sees the exact recipient even if the
    #: underlying KioskSession is later revoked / deleted.
    recipient_email = models.EmailField(_("recipient email"))

    #: User who clicked the Notify button. Nullable on user deletion
    #: so the row survives an offboarded teammate.
    triggered_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="kiosk_alerts_triggered",
    )

    #: Optional free-text note the sender typed in the dialog. Quoted
    #: verbatim in the email body so the customer sees a contextual
    #: line ("we've adjusted the pricing — please review"). Blank
    #: when the sender chose the silent "just nudge them" option.
    custom_note = models.TextField(_("custom note"), blank=True, default="")

    status = models.CharField(
        _("status"),
        max_length=16,
        choices=KioskAlertStatus.choices,
        default=KioskAlertStatus.QUEUED,
    )
    error = models.TextField(_("error"), blank=True, default="")

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    sent_at = models.DateTimeField(_("sent at"), null=True, blank=True)

    class Meta:
        verbose_name = _("kiosk alert")
        verbose_name_plural = _("kiosk alerts")
        indexes = [
            # Powers the cooldown lookup ("most recent alert for this
            # sheet + email") + the "last notified at" UI hint.
            models.Index(
                fields=("sheet", "recipient_email", "-created_at"),
                name="kiosk_alerts_sheet_email_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"KioskAlert(sheet={self.sheet_id}, to={self.recipient_email})"


#: How long after a successful send we refuse a second alert to the
#: same recipient for the same sheet. Strict (server-side); the FE
#: also disables the button for the same window.
KIOSK_ALERT_COOLDOWN_SECONDS = 5 * 60
