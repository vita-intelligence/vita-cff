"""Domain models for the accounts app."""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser, PermissionsMixin
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.accounts.managers import UserManager

# Reset links are intentionally short-lived: 30 minutes is enough for
# a user to find the message and click through, but tight enough to
# limit the blast radius if the recipient's inbox is later compromised.
PASSWORD_RESET_TOKEN_TTL = timedelta(minutes=30)


class User(AbstractBaseUser, PermissionsMixin):
    """Application user identified by email.

    We deliberately subclass :class:`AbstractBaseUser` (not ``AbstractUser``)
    to fully remove the legacy ``username`` field. Primary key is a UUID so
    identifiers are safe to expose in URLs, logs, and cross-service calls.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )

    email = models.EmailField(
        _("email address"),
        unique=True,
    )
    first_name = models.CharField(
        _("first name"),
        max_length=150,
    )
    last_name = models.CharField(
        _("last name"),
        max_length=150,
    )

    is_active = models.BooleanField(
        _("active"),
        default=True,
        help_text=_("Designates whether this user should be treated as active."),
    )
    is_staff = models.BooleanField(
        _("staff status"),
        default=False,
        help_text=_("Designates whether the user can access the admin site."),
    )

    date_joined = models.DateTimeField(
        _("date joined"),
        default=timezone.now,
    )

    avatar_image = models.TextField(
        _("avatar image"),
        blank=True,
        default="",
        help_text=_(
            "Base64 data URL the user uploaded as their profile photo. "
            "Rendered alongside the name in the comments feed, presence "
            "roster, and mentions. Empty renders as initials. When we "
            "migrate to blob storage, this column gets swapped for a "
            "URL — every consumer already treats the value as opaque."
        ),
    )

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    class Meta:
        verbose_name = _("user")
        verbose_name_plural = _("users")
        ordering = ("-date_joined",)
        indexes = [
            models.Index(fields=("email",)),
        ]

    def __str__(self) -> str:
        return self.email

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    def get_full_name(self) -> str:
        return self.full_name

    def get_short_name(self) -> str:
        return self.first_name


class PasswordResetToken(models.Model):
    """Single-use token issued by the forgot-password flow.

    The plaintext token only exists in the email link — we store
    SHA-256 of it server-side so a stolen database dump can't be
    converted into working reset links. ``used_at`` and
    ``invalidated_at`` are independent: ``used`` means the user
    actually completed the reset; ``invalidated`` means a newer
    request superseded this row before it could be consumed. We keep
    rows around (rather than deleting on consume) so the audit log
    can replay who asked for resets and when.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="password_reset_tokens",
        on_delete=models.CASCADE,
    )
    token_hash = models.CharField(
        max_length=64,
        unique=True,
        help_text=_(
            "Hex-encoded SHA-256 of the plaintext token that was emailed "
            "to the user. Stored hashed so a DB dump can't be turned "
            "into working reset links."
        ),
    )
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    invalidated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=_(
            "Set when a fresher reset request superseded this token "
            "before the user clicked through. Distinct from used_at."
        ),
    )
    requested_ip = models.CharField(
        max_length=45,
        blank=True,
        default="",
        help_text=_("Audit breadcrumb — IPv4/IPv6 of the requester."),
    )

    class Meta:
        verbose_name = _("password reset token")
        verbose_name_plural = _("password reset tokens")
        indexes = [
            models.Index(fields=("user", "-created_at")),
            models.Index(fields=("expires_at",)),
        ]

    def __str__(self) -> str:
        return f"PasswordResetToken(user={self.user_id}, created={self.created_at:%Y-%m-%dT%H:%M:%SZ})"

    @property
    def is_consumable(self) -> bool:
        """Whether this token can still be exchanged for a password reset.

        Centralising the rule here keeps service code from having to
        re-derive the same boolean from four timestamps every call —
        the *only* thing that can change `is_consumable` is mutating
        this row, so caching at the row level is safe.
        """

        now = timezone.now()
        return (
            self.used_at is None
            and self.invalidated_at is None
            and self.expires_at > now
        )
