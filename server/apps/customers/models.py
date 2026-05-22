"""Domain model for the customers app.

A :class:`Customer` is the org's address-book entry for an external
client — contact person, company, emails, phones, invoice + delivery
addresses. Proposals reference customers so the same client can be
quoted across multiple projects without re-typing their details
every time, and so sales has a single place to update a changed
phone number without sweeping every historical proposal.

Kept deliberately thin. Notes / relationship history belong on a
future ``CustomerActivity`` model; this one is a searchable lookup
the proposal picker drops into.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class Customer(models.Model):
    """An external client the organization quotes to."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="customers",
    )

    name = models.CharField(
        _("contact name"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Primary contact person at the client (e.g. James Brown). "
            "Maps to the proposal's ``billto_contactname`` and the "
            "``Dear …`` greeting."
        ),
    )
    company = models.CharField(
        _("company"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Client organization name. Maps to ``customeridname`` in "
            "the Dynamics template."
        ),
    )
    email = models.EmailField(
        _("email"), blank=True, default=""
    )
    phone = models.CharField(
        _("phone"),
        max_length=60,
        blank=True,
        default="",
    )

    invoice_address = models.TextField(
        _("invoice address"), blank=True, default=""
    )
    delivery_address = models.TextField(
        _("delivery address"), blank=True, default=""
    )
    notes = models.TextField(
        _("notes"),
        blank=True,
        default="",
        help_text=_(
            "Free-text internal notes. Never rendered on the "
            "customer-facing proposal — kept for the sales team's "
            "context (e.g. 'prefers email, pays late')."
        ),
    )

    #: Legacy Dataverse GUID — could be a contact or an account
    #: depending on what the operator picked at import time. Kept on
    #: the schema for rows minted before the account/contact split
    #: landed; new rows now use the explicit
    #: :attr:`dynamics_account_id` + :attr:`dynamics_contact_id`
    #: pair below. The import resolver falls back to this column so
    #: legacy rows continue to dedupe on the same Dataverse record.
    dynamics_id = models.UUIDField(
        _("dynamics id"),
        null=True,
        blank=True,
        db_index=True,
        help_text=_(
            "Legacy Dataverse GUID — populated for customers imported "
            "before the account/contact split. New imports populate "
            "dynamics_account_id / dynamics_contact_id instead."
        ),
    )
    #: The parent **account** GUID — the business this customer
    #: represents. New imports anchor on this column so the same
    #: business never gets two local rows just because the
    #: operator picked it once as an account and once as a person.
    #: The unique constraint below enforces this org-scoped.
    #:
    #: Stays ``NULL`` for legacy rows and for the rare contact that
    #: has no parent account (e.g. a freelancer). Those continue to
    #: resolve via :attr:`dynamics_id`.
    dynamics_account_id = models.UUIDField(
        _("dynamics account id"),
        null=True,
        blank=True,
        db_index=True,
        help_text=_(
            "Dataverse account GUID — the company this customer "
            "represents. New imports key on this so the same "
            "business never duplicates into two local rows."
        ),
    )
    #: The Dataverse contact GUID currently acting as the primary
    #: person on this customer. The Customer's own ``name`` / ``email``
    #: / ``phone`` / addresses are a snapshot of this contact's
    #: Dataverse record at the last import or swap. Operators can
    #: "swap primary contact" later to move the snapshot to a
    #: different person under the same account.
    dynamics_contact_id = models.UUIDField(
        _("dynamics contact id"),
        null=True,
        blank=True,
        db_index=True,
        help_text=_(
            "Dataverse contact GUID for the current primary contact. "
            "Snapshot of this contact's details lives in name / email "
            "/ phone / addresses. Swap moves the snapshot to a new "
            "contact under the same account."
        ),
    )
    #: Timestamp of the last successful pull from Dynamics. Updated
    #: on every import that refreshes the local copy from Dataverse.
    dynamics_synced_at = models.DateTimeField(
        _("dynamics synced at"),
        null=True,
        blank=True,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_customers",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_customers",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("customer")
        verbose_name_plural = _("customers")
        ordering = ("company", "name")
        indexes = [
            models.Index(fields=("organization", "company")),
            models.Index(fields=("organization", "name")),
            models.Index(fields=("organization", "-updated_at")),
        ]
        constraints = [
            # Legacy uniqueness on the catch-all dynamics_id. Still
            # honoured for rows that exist with that column set; new
            # imports populate dynamics_account_id below instead and
            # never write dynamics_id, so the two constraints don't
            # fight.
            models.UniqueConstraint(
                fields=("organization", "dynamics_id"),
                condition=~models.Q(dynamics_id=None),
                name="customers_unique_dynamics_per_org",
            ),
            # One local Customer per Dataverse account per org. The
            # account is the "this is the same business" identity —
            # anchoring new imports on this prevents the duplicate
            # trap where the same company gets picked once as a
            # contact and once as an account.
            models.UniqueConstraint(
                fields=("organization", "dynamics_account_id"),
                condition=~models.Q(dynamics_account_id=None),
                name="customers_unique_dynamics_account_per_org",
            ),
        ]

    def __str__(self) -> str:
        pieces = [self.company, self.name]
        return " · ".join(p for p in pieces if p) or str(self.id)


class CustomerEmailAliasSource(models.TextChoices):
    """How a given alias row was created.

    Kept as a TextChoices so future sources (e.g. Dynamics-side
    historical addresses, staff-side merge consolidation) can be
    added without touching the schema.
    """

    PORTAL_EMAIL_CHANGE = "portal_email_change", _("Portal email change")


class CustomerEmailAlias(models.Model):
    """Historical email addresses associated with a :class:`Customer`.

    Pure additive structure — never replaces or rewrites the
    canonical :attr:`Customer.email`. Captures *prior* addresses so
    portal-side queries that join by email (notably
    :func:`apps.cff_submissions.services.list_customer_cffs`) can
    union across the current and historical addresses. Without this,
    when a customer changes their portal email, every CFF they
    submitted under the previous address silently disappears from
    their portal view — the denormalised ``submitter_email`` on the
    CFF row is frozen at intake by design, and a single-email join
    can't span the change.

    Writes are deliberately additive: each unique
    ``(customer, lower(email))`` pair gets at most one row, so a
    customer who flips between two addresses doesn't accumulate
    duplicates. The constraint also lets the writer use
    ``get_or_create`` without racing.

    Lifecycle:

    * Created when :func:`apps.client_portal.profile_services
      .confirm_email_change` flips a customer's email — the *prior*
      address is archived here before the canonical row is updated.
    * Never auto-deleted. The whole point is permanence: the
      customer's old CFFs should remain reachable forever, including
      after multiple subsequent email rotations.

    Existing customers whose email changed *before* this table
    existed have no aliases (we don't backfill historical changes —
    we don't know what the prior address was without the audit log,
    and even there it's per-event noise). Going forward every change
    leaves a row.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    customer = models.ForeignKey(
        Customer,
        on_delete=models.CASCADE,
        related_name="email_aliases",
        help_text=_(
            "The customer this prior email belonged to. ``CASCADE`` "
            "because aliases are intrinsic to their owner; deleting "
            "the customer drops them too."
        ),
    )
    email = models.EmailField(
        _("email"),
        help_text=_(
            "Lower-case-normalised historical address. Always "
            "different from the customer's current ``email`` — the "
            "writer skips creating an alias for the customer's own "
            "canonical address."
        ),
    )
    source = models.CharField(
        _("source"),
        max_length=32,
        choices=CustomerEmailAliasSource.choices,
        default=CustomerEmailAliasSource.PORTAL_EMAIL_CHANGE,
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("customer email alias")
        verbose_name_plural = _("customer email aliases")
        ordering = ("-created_at",)
        constraints = [
            # One row per (customer, email) pair. A customer who
            # ping-pongs between two addresses accumulates a single
            # alias per past address rather than a new row on every
            # cycle. The ``Lower`` wrapper guarantees the dedup is
            # case-insensitive — ``Alex@…`` and ``alex@…`` are the
            # same alias.
            models.UniqueConstraint(
                models.functions.Lower("email"),
                "customer",
                name="customer_email_alias_unique_per_customer",
            ),
        ]
        indexes = [
            # Lookup the join uses on the portal side — find every
            # customer that has historically used a given address.
            models.Index(
                models.functions.Lower("email"),
                name="cust_email_alias_lower_idx",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.email} → {self.customer_id}"
