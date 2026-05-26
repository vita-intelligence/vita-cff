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

    avatar_image = models.TextField(
        _("avatar image"),
        blank=True,
        default="",
        help_text=_(
            "Base64 data URL the customer uploaded as their profile "
            "photo. Rendered next to their own messages in the "
            "portal chat and on the staff comments side so the team "
            "can match a thread to a face. Mirrors "
            "``apps.accounts.User.avatar_image`` so the two surfaces "
            "share the same wire shape (opaque string, displayed via "
            "``<img src={value}/>``). When we migrate to blob storage "
            "this column becomes a URL — every consumer already "
            "treats the value as opaque."
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


class CustomerPortalInvite(models.Model):
    """Staff-issued invitation for a :class:`Customer` to activate
    a portal account without first being sent a proposal.

    Sibling to the proposal-driven kiosk flow: same activate page
    shape (set a password, type a 6-digit code mailed to the
    customer's address), but the invite is bound to a customer
    record directly so it works for clients we haven't yet quoted.
    Staff issues an invite from the customers page and shares the
    resulting URL by whatever channel they prefer (Slack, email,
    text) — only the **code** is sent by us, which is also what
    proves the customer actually controls the email on file.

    Lifecycle mirrors :class:`EmailChangeRequest`:

    * ``used_at`` set when the customer successfully activates.
    * ``invalidated_at`` set when a fresher invite supersedes this
      one (operator re-issued because the customer lost the email).
    * ``expires_at`` defaults to 7 days from creation.
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        editable=False,
    )
    customer = models.ForeignKey(
        "customers.Customer",
        related_name="portal_invites",
        on_delete=models.CASCADE,
        help_text=_(
            "Customer the invite activates. ``on_delete=CASCADE`` "
            "so deleting the CRM row sweeps any open invites with "
            "it — they'd never be redeemable anyway."
        ),
    )
    token = models.UUIDField(
        default=uuid.uuid4,
        unique=True,
        editable=False,
        help_text=_(
            "URL token shared with the customer. The full UUID is "
            "the secret — there is no plaintext-hash split here "
            "because the customer needs the raw token in the link."
        ),
    )
    code_hash = models.CharField(
        max_length=64,
        help_text=_(
            "SHA-256 of the plaintext 6-digit code mailed to the "
            "customer's address. Stored hashed so a DB dump can't "
            "be turned into a working activation."
        ),
    )
    email_snapshot = models.EmailField(
        help_text=_(
            "Customer's email at the moment of invite creation. "
            "Pinned here so a later edit to ``Customer.email`` "
            "doesn't desync the activate page from the inbox the "
            "code was actually sent to."
        ),
    )
    created_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text=_("Staff member who issued the invite."),
    )
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    invalidated_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=_(
            "Set when a fresher invite superseded this one. "
            "Distinct from ``used_at`` so the audit log can tell a "
            "re-issued (abandoned) invite apart from a consumed one."
        ),
    )

    class Meta:
        verbose_name = _("customer portal invite")
        verbose_name_plural = _("customer portal invites")
        indexes = [
            models.Index(fields=("customer", "-created_at")),
            models.Index(fields=("expires_at",)),
        ]

    def __str__(self) -> str:
        return (
            f"CustomerPortalInvite(customer={self.customer_id}, "
            f"created={self.created_at:%Y-%m-%dT%H:%M:%SZ})"
        )

    @property
    def is_consumable(self) -> bool:
        """``True`` when this invite can still drive an activation.

        Matches the lifecycle invariants of the sibling token /
        request rows: not yet used, not superseded by a fresher
        invite, and the expiry window hasn't passed.
        """

        now = timezone.now()
        return (
            self.used_at is None
            and self.invalidated_at is None
            and self.expires_at > now
        )


class PortalEvent(models.Model):
    """A single customer action recorded on the client portal.

    Append-only by design — every row is the trace of one thing the
    customer did (clicked the activation link, requested an OTP,
    signed a proposal, …). Staff use the rollup to answer the simple
    question that today we can only guess at: *did the customer
    actually open the proposal we sent them?*

    Mirrors :class:`apps.audit.models.AuditLog` in shape (org-scoped,
    JSON metadata, append-only) but lives next to the portal because
    every event originates from a portal request — keeping it here
    means the producers and the table are in the same app and the
    audit log stays focused on staff-side mutations.

    FK posture:

    - ``proposal`` is nullable so future portal-wide events untied
      to a specific proposal (e.g. password-reset clicks) can land
      in the same table without a schema split.
    - ``client_account`` is nullable because pre-activation events
      have no account yet. After ``activated``, every subsequent
      event the same session fires carries it.
    - Both FKs are ``SET_NULL`` so deleting a proposal or churning
      a client account never destroys the audit trail. Staff can
      still see what happened historically.

    Schema-on-read JSON ``metadata`` so we don't migrate for each
    new attribute we want to capture. Per-``kind`` schema is the
    producer's responsibility; readers ``.get()`` defensively.
    """

    class Kind(models.TextChoices):
        # Pre-activation — fired before the customer has an account.
        LINK_OPENED = "link_opened", _("Activation link opened")
        ACTIVATION_CODE_REQUESTED = (
            "activation_code_requested",
            _("Verification code requested"),
        )
        ACTIVATED = "activated", _("Account activated")
        # Authenticated session events.
        SIGNED_IN = "signed_in", _("Signed in")
        SIGNED_OUT = "signed_out", _("Signed out")
        # Proposal interactions.
        PROPOSAL_VIEWED = "proposal_viewed", _("Proposal opened")
        PROPOSAL_PDF_DOWNLOADED = (
            "proposal_pdf_downloaded",
            _("Proposal PDF downloaded"),
        )
        PROPOSAL_SIGNED = "proposal_signed", _("Proposal signed")
        PROPOSAL_REJECTED = "proposal_rejected", _("Proposal rejected")
        # Spec sheet interactions.
        SPEC_VIEWED = "spec_viewed", _("Spec sheet opened")
        SPEC_SIGNED = "spec_signed", _("Spec sheet signed")

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="portal_events",
    )
    proposal = models.ForeignKey(
        "proposals.Proposal",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="portal_events",
    )
    client_account = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="portal_events",
    )

    kind = models.CharField(max_length=40, choices=Kind.choices)
    metadata = models.JSONField(default=dict, blank=True)

    ip_address = models.GenericIPAddressField(null=True, blank=True)
    #: Truncated to 255 — UAs longer than that are almost always
    #: bot fingerprints, not real customer browsers.
    user_agent = models.CharField(max_length=255, blank=True)

    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("portal event")
        verbose_name_plural = _("portal events")
        ordering = ("-created_at",)
        indexes = [
            # Primary query path: "show me everything that happened
            # on this proposal, newest first" — the staff panel.
            models.Index(fields=("organization", "proposal", "-created_at")),
            # Secondary: "has this proposal ever fired event X?"
            # (e.g. ``proposal_viewed`` → "first opened at").
            models.Index(fields=("proposal", "kind")),
        ]

    def __str__(self) -> str:
        return (
            f"PortalEvent(kind={self.kind}, "
            f"proposal={self.proposal_id}, "
            f"at={self.created_at:%Y-%m-%dT%H:%M:%SZ})"
        )
