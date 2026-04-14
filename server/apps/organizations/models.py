"""Domain models for the organizations app."""

from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


INVITATION_EXPIRY = timedelta(days=7)


def _generate_invitation_token() -> str:
    """Return a URL-safe, high-entropy invitation token.

    ``token_urlsafe(32)`` yields ~43 characters — plenty of bits to
    make enumeration infeasible. The token is the *only* credential a
    prospective member needs in order to accept, so it must be
    unguessable.
    """

    return secrets.token_urlsafe(32)


def _default_invitation_expiry():
    return timezone.now() + INVITATION_EXPIRY


class Organization(models.Model):
    """A tenant boundary.

    Everything the application stores — ingredients, formulations,
    proposals — will eventually carry a foreign key to a row on this
    table. For now the only durable attribute is a human-readable name;
    richer settings arrive when features need them.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(_("name"), max_length=150)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_organizations",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("organization")
        verbose_name_plural = _("organizations")
        ordering = ("name",)
        indexes = [
            models.Index(fields=("created_at",)),
        ]

    def __str__(self) -> str:
        return self.name


class Membership(models.Model):
    """Link between a :class:`User` and an :class:`Organization`.

    ``is_owner`` grants unconditional access — the creator of an
    organization is the owner and bypasses ``permissions`` checks entirely.
    Non-owners store their grants as a ``{module_key: level}`` mapping on
    the ``permissions`` JSON field. The set of legal keys and levels is
    defined in :mod:`apps.organizations.modules`.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    is_owner = models.BooleanField(_("is owner"), default=False)
    permissions: models.JSONField = models.JSONField(
        _("permissions"),
        default=dict,
        blank=True,
        help_text=_("Map of module key to permission level for non-owners."),
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("membership")
        verbose_name_plural = _("memberships")
        ordering = ("-is_owner", "user__email")
        constraints = [
            models.UniqueConstraint(
                fields=("user", "organization"),
                name="organizations_membership_unique_user_org",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} @ {self.organization}"


class Invitation(models.Model):
    """A pending invitation for a prospective organization member.

    The ``token`` field is the single credential required to accept: any
    holder of the link can present it, so it must be unguessable. We
    accept the trade-off of "link-as-secret" because email delivery is
    deliberately out of scope for this slice — the owner shares the
    link out-of-band via whatever channel they prefer.

    ``accepted_at`` is the canonical "is this still pending?" signal. A
    row with a non-null ``accepted_at`` is history and must never be
    accepted again, even if the token somehow leaks.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="invitations",
    )
    email = models.EmailField(_("email address"))
    token = models.CharField(
        _("token"),
        max_length=64,
        unique=True,
        default=_generate_invitation_token,
        editable=False,
    )
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="sent_invitations",
    )
    permissions: models.JSONField = models.JSONField(
        _("permissions"),
        default=dict,
        blank=True,
        help_text=_("Permissions the invitee will receive on accept."),
    )
    expires_at = models.DateTimeField(
        _("expires at"),
        default=_default_invitation_expiry,
    )
    accepted_at = models.DateTimeField(
        _("accepted at"),
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("invitation")
        verbose_name_plural = _("invitations")
        ordering = ("-created_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "email"),
                condition=Q(accepted_at__isnull=True),
                name="organizations_invitation_unique_pending_per_org_email",
            ),
        ]
        indexes = [
            models.Index(fields=("token",)),
            models.Index(fields=("expires_at",)),
        ]

    def __str__(self) -> str:
        return f"invite {self.email} -> {self.organization}"

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at

    @property
    def is_pending(self) -> bool:
        return self.accepted_at is None and not self.is_expired
