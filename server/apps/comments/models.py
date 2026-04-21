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

    # Identity. Exactly one of (author) or (guest_name+guest_email) is
    # required — the check constraint below enforces it at the DB level
    # so a service-layer bug cannot create an orphan row.
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="authored_comments",
        help_text=_(
            "The authenticated member who wrote the comment. Null for "
            "kiosk guests (commit 6); authoring is still attributed via "
            "``guest_name`` / ``guest_email``."
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
            # Identity is mandatory. Either a linked author row OR a
            # fully populated guest triple. ``author_id IS NOT NULL``
            # covers every authed write; the else branch requires both
            # a non-empty name AND email (we never let a guest skip
            # either, per the kiosk identity-capture flow).
            models.CheckConstraint(
                name="comments_identity_required",
                condition=(
                    models.Q(author__isnull=False)
                    | (
                        ~models.Q(guest_name="")
                        & ~models.Q(guest_email="")
                    )
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
