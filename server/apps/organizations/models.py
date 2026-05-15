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


#: Picker-scoping role tags on a Membership. Independent of the
#: capability grid in :mod:`apps.organizations.modules` — a member's
#: ``groups`` tells the UI which dropdowns to surface them in, while
#: ``permissions`` decides what they can actually do once there.
#: Kept as a hardcoded frozenset (rather than an admin-managed
#: table) because the two roles map directly onto the product's
#: lifecycle: scientists author formulations and spec sheets;
#: salespeople negotiate proposals. Adding a third group later is a
#: one-line change.
MEMBERSHIP_GROUPS: frozenset[str] = frozenset({"scientist", "sales"})


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
    # Pre-billing access gate. New workspaces default to inactive and
    # must be flipped on by a platform admin (Django admin or the
    # ``activate_organization`` management command) before members can
    # use the app. When the real billing integration lands, the field
    # will be driven by subscription state instead of a manual toggle —
    # the capability checks stay identical so downstream code does not
    # change.
    is_active = models.BooleanField(
        _("is active"),
        default=False,
        help_text=_(
            "Members can only use the workspace when this is enabled. "
            "Superusers always bypass the check."
        ),
    )
    default_spec_limits = models.JSONField(
        _("default spec limits"),
        default=dict,
        blank=True,
        help_text=_(
            "Organization-level defaults for the spec sheet's "
            "``Microbiological, PAH, Pesticides and Heavy Metal`` "
            "block. Keys: ``total_aerobic``, ``total_yeast``, "
            "``e_coli``, ``salmonella``, ``pah``, ``heavy_metal``, "
            "``pesticides``, ``others``. Individual sheets can "
            "override via :attr:`SpecificationSheet.limits_override`."
        ),
    )
    #: Per-org Microsoft Dynamics 365 (Sales / CE) integration config.
    #: When ``enabled`` is True the customer picker surfaces
    #: Dynamics contacts alongside local customers. The Fernet-
    #: encrypted ``client_secret_ciphertext`` is stored here too so
    #: every Dynamics request reads the current secret from a single
    #: source. Schema:
    #:
    #: .. code-block:: json
    #:
    #:    {
    #:      "enabled": true,
    #:      "dataverse_url": "https://contoso.crm.dynamics.com",
    #:      "tenant_id": "<azure ad tenant uuid>",
    #:      "client_id": "<azure ad app uuid>",
    #:      "client_secret_ciphertext": "<fernet ciphertext>",
    #:      "last_tested_at": "2026-05-13T07:00:00Z"
    #:    }
    #:
    #: Empty dict means "no integration configured" — every Dynamics
    #: code path treats that as off and the rest of the app behaves
    #: exactly as today.
    dynamics_config = models.JSONField(
        _("dynamics integration config"),
        default=dict,
        blank=True,
        help_text=_(
            "Microsoft Dynamics 365 connection settings for this "
            "workspace. Empty dict = integration disabled."
        ),
    )
    #: Per-org MRPEasy integration config. When live, the spec
    #: approval modal and the proposal create / detail surfaces
    #: look up the project's MRPEasy ``selling_price`` (filtered
    #: by the project code) so the director can see the
    #: catalogue-suggested unit price beside the figure they're
    #: typing. The Fernet-encrypted ``api_secret_ciphertext`` is
    #: stored here so every MRPEasy request reads the current
    #: secret from a single source. Schema:
    #:
    #: .. code-block:: json
    #:
    #:    {
    #:      "enabled": true,
    #:      "api_key": "<mrpeasy api key>",
    #:      "api_secret_ciphertext": "<fernet ciphertext>",
    #:      "last_tested_at": "2026-05-15T10:00:00Z"
    #:    }
    #:
    #: Empty dict = no integration configured. Every MRPEasy code
    #: path treats that as off — the price-hint component renders
    #: nothing, settings UI offers the connect form, no calls go
    #: out. The base URL is fixed (``https://app.mrpeasy.com``)
    #: so no per-org subdomain field is needed.
    mrpeasy_config = models.JSONField(
        _("mrpeasy integration config"),
        default=dict,
        blank=True,
        help_text=_(
            "MRPEasy connection settings for this workspace. "
            "Empty dict = integration disabled."
        ),
    )
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
    #: Optional role tags. Currently restricted to ``"scientist"`` and
    #: ``"sales"`` (see :data:`MEMBERSHIP_GROUPS`). Drives picker
    #: scoping so the sales-person dropdown lists only commercial
    #: staff, not the entire org roster. Independent of
    #: :attr:`permissions` — a sales rep with ``proposals.edit`` and a
    #: scientist with ``formulations.edit`` are both ordinary members
    #: from a capability standpoint; ``groups`` is a directory
    #: classifier the admin curates on the Members tab.
    groups: models.JSONField = models.JSONField(
        _("groups"),
        default=list,
        blank=True,
        help_text=_(
            "Role tags for picker scoping (subset of "
            '{"scientist", "sales"}).'
        ),
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
        indexes = [
            # Permission checks routinely scan all memberships for an
            # org (settings page, audit-log filter, owner reassign).
            # The unique constraint on (user, organization) already
            # indexes the user-side lookup; this one covers the
            # org-side scan.
            models.Index(
                fields=("organization",),
                name="orgs_membership_org_idx",
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
