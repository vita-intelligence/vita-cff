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

    def __str__(self) -> str:
        pieces = [self.company, self.name]
        return " · ".join(p for p in pieces if p) or str(self.id)
