"""Domain models for the client portal.

Two tables:

* :class:`ClientAccount` — a customer-facing login. Always tied to
  one :class:`apps.customers.models.Customer` row. Activated via the
  proposal's ``public_token`` (the same token the kiosk email
  carries — we repurpose it as a one-shot account-activation token
  rather than a long-lived anonymous view permit).
* :class:`ClientPasswordResetToken` — single-use reset token for
  the forgot-password flow. Mirrors
  :class:`apps.accounts.models.PasswordResetToken` exactly so the
  audit + lifecycle semantics stay consistent across staff and
  client sides.

Why a separate table from :class:`apps.accounts.models.User`:

* Clients never get organization memberships; mixing them in the
  staff users table would force every membership / permission query
  to add a ``WHERE is_client = false`` filter for safety.
* The portal lives at a different URL prefix and uses a different
  cookie (``vita_portal_access`` vs ``vita_access``) so the two
  surfaces never share a session by accident.
* A future mobile app for clients can issue its own JWTs against
  this table without bumping into the staff token format.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from django.conf import settings
from django.contrib.auth.models import AbstractBaseUser
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.client_portal.managers import ClientAccountManager


# Portal reset links match the staff cadence (30 min) — same risk
# profile, same UX, no reason to drift.
PORTAL_PASSWORD_RESET_TOKEN_TTL = timedelta(minutes=30)


class ClientAccount(AbstractBaseUser):
    """Authenticatable customer-facing account.

    Bound 1:1 to a :class:`apps.customers.models.Customer` at
    activation time. The portal endpoints filter every proposal /
    spec / comment query by ``request.user.customer_id`` so a client
    only ever sees data tied to *their* customer row.

    No :class:`PermissionsMixin` — portal endpoints gate on
    ownership of the parent customer, not on per-permission grants.
    Adding that machinery would mislead future readers into thinking
    clients can be granted staff-like roles.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )

    email = models.EmailField(
        _("email address"),
        unique=True,
        help_text=_(
            "Login identity. Set from the Customer.email on the "
            "proposal that issued the activation token, so the "
            "address the kiosk email reached is the address that "
            "logs in. Never edited by the client themselves."
        ),
    )

    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.PROTECT,
        related_name="client_accounts",
        help_text=_(
            "The CRM row this account belongs to. PROTECT because "
            "deleting a Customer that still has live portal logins "
            "would orphan sessions; the staff side has to detach "
            "logins (or move them) first."
        ),
    )

    is_active = models.BooleanField(
        _("active"),
        default=True,
        help_text=_(
            "Designates whether this account can sign in. Staff "
            "may flip this OFF to revoke portal access without "
            "deleting historical comments / signatures."
        ),
    )

    activated_at = models.DateTimeField(
        _("activated at"),
        null=True,
        blank=True,
        help_text=_(
            "Set once on the first successful activation (when the "
            "client sets their password via the kiosk-token landing "
            "page). ``NULL`` means the account row exists (we "
            "pre-create on send) but no one has set a password yet."
        ),
    )

    last_login_ip = models.CharField(
        max_length=45,
        blank=True,
        default="",
        help_text=_(
            "Most recent IP that completed a successful login. "
            "IPv4 or IPv6. Audit breadcrumb only — never gated on."
        ),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    objects = ClientAccountManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS: list[str] = []

    class Meta:
        verbose_name = _("client account")
        verbose_name_plural = _("client accounts")
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("email",)),
            models.Index(fields=("customer",)),
        ]

    def __str__(self) -> str:
        return self.email

    @property
    def is_activated(self) -> bool:
        """Has the client completed first-time password setup?

        A row can exist without being activated (we pre-create on
        kiosk-email send so the FK to Customer is durable even if
        the customer never clicks). Used by the login view to tell
        first-time visitors apart from returners.
        """

        return self.activated_at is not None


class EmailChangeRequest(models.Model):
    """A pending email-change request for one :class:`ClientAccount`.

    Customers can edit their on-file email via the portal settings.
    To prove they actually own the new address, we mail a 6-digit
    code there and refuse the change until the customer types that
    code back into the settings page. Same pattern as the activation
    code that gates first-time setup; same TTL as the password reset
    flow (30 minutes) so the inbox / settings page UX is consistent.

    A fresh request invalidates every prior unused one for the same
    account — only the most recent code in the customer's inbox can
    be redeemed, identical to the password-reset enumeration policy.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    account = models.ForeignKey(
        "client_portal.ClientAccount",
        related_name="email_change_requests",
        on_delete=models.CASCADE,
    )
    new_email = models.EmailField(
        help_text=_(
            "Address the customer typed into the settings form. "
            "Stored lowercased + trimmed so the confirm step can "
            "match against ``normalize_email`` output without "
            "needing a second normalisation pass."
        ),
    )
    code_hash = models.CharField(
        max_length=64,
        help_text=_(
            "SHA-256 of the plaintext 6-digit code sent in the "
            "verification email. Stored hashed so a DB dump can't "
            "be turned into a working email-change confirmation."
        ),
    )
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    invalidated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=_(
            "Set when a fresher request superseded this one. "
            "Distinct from ``used_at`` so the audit log can tell "
            "an abandoned request apart from a consumed one."
        ),
    )

    class Meta:
        verbose_name = _("email change request")
        verbose_name_plural = _("email change requests")
        indexes = [
            models.Index(fields=("account", "-created_at")),
            models.Index(fields=("expires_at",)),
        ]

    @property
    def is_consumable(self) -> bool:
        now = timezone.now()
        return (
            self.used_at is None
            and self.invalidated_at is None
            and self.expires_at > now
        )


class ClientPasswordResetToken(models.Model):
    """Single-use forgot-password token for a :class:`ClientAccount`.

    Storage shape mirrors :class:`apps.accounts.models.PasswordResetToken`
    exactly — the plaintext token lives only in the email link, the
    DB stores SHA-256 of it. Lifecycle invariants
    (``used_at`` / ``invalidated_at`` / ``expires_at``) match so a
    future shared abstraction can fold the two together without
    losing audit fidelity.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    account = models.ForeignKey(
        "client_portal.ClientAccount",
        related_name="password_reset_tokens",
        on_delete=models.CASCADE,
    )
    token_hash = models.CharField(
        max_length=64,
        unique=True,
        help_text=_(
            "Hex-encoded SHA-256 of the plaintext token emailed to "
            "the client. DB dump can't be turned into working reset "
            "links."
        ),
    )
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    invalidated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=_(
            "Set when a fresher request superseded this token. "
            "Distinct from ``used_at`` so the audit trail can "
            "tell a never-used token apart from a consumed one."
        ),
    )
    requested_ip = models.CharField(
        max_length=45,
        blank=True,
        default="",
    )

    class Meta:
        verbose_name = _("client password reset token")
        verbose_name_plural = _("client password reset tokens")
        indexes = [
            models.Index(fields=("account", "-created_at")),
            models.Index(fields=("expires_at",)),
        ]

    def __str__(self) -> str:
        return (
            f"ClientPasswordResetToken(account={self.account_id}, "
            f"created={self.created_at:%Y-%m-%dT%H:%M:%SZ})"
        )

    @property
    def is_consumable(self) -> bool:
        now = timezone.now()
        return (
            self.used_at is None
            and self.invalidated_at is None
            and self.expires_at > now
        )
