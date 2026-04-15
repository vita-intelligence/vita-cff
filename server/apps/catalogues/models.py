"""Domain models for the catalogues app.

A :class:`Catalogue` is a user-configurable typed reference table (raw
materials, packaging, equipment, suppliers, ...). Each organization
gets a fixed set of *system* catalogues seeded on creation whose slugs
are load-bearing for business logic (the formulation engine references
``raw_materials`` and ``packaging`` by slug), and owners can create
any number of additional custom catalogues on top.

An :class:`Item` is a row inside a catalogue. It carries a small set
of builtin columns (name, code, unit, base_price) plus a typed dynamic
``attributes`` JSON map whose schema is defined by
:class:`apps.attributes.models.AttributeDefinition` rows scoped to the
same catalogue.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


#: Slug of the catalogue that stores raw materials. The formulation
#: engine reads purity, extract ratio, nutrition, and compliance
#: attributes from items in this catalogue. Never rename without a
#: coordinated codebase sweep.
RAW_MATERIALS_SLUG = "raw_materials"

#: Slug of the catalogue that stores packaging components (bottles,
#: lids, labels, tubs). Referenced from specification sheets.
PACKAGING_SLUG = "packaging"

#: Slugs seeded automatically on every new organization. Marked
#: ``is_system=True`` so users cannot delete or rename them.
SYSTEM_CATALOGUE_SLUGS: tuple[str, ...] = (RAW_MATERIALS_SLUG, PACKAGING_SLUG)


class Catalogue(models.Model):
    """A typed reference table owned by a single organization.

    ``slug`` is the stable machine identifier used in permission
    checks, URL routing, and business-logic references. It is unique
    within an organization and never renamed after creation so that
    code-side coupling (``Catalogue.objects.get(slug="raw_materials")``)
    remains valid.

    ``is_system`` marks the two catalogues seeded automatically on
    organization creation. System catalogues cannot be deleted — they
    are load-bearing for downstream features.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="catalogues",
    )
    slug = models.SlugField(
        _("slug"),
        max_length=64,
        help_text=_(
            "Machine identifier used in URLs and permission checks. "
            "Snake_case, never renamed after creation."
        ),
    )
    name = models.CharField(_("name"), max_length=150)
    description = models.TextField(_("description"), blank=True, default="")
    is_system = models.BooleanField(
        _("is system"),
        default=False,
        help_text=_(
            "System catalogues are seeded automatically and referenced "
            "from business logic by slug. They cannot be deleted."
        ),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("catalogue")
        verbose_name_plural = _("catalogues")
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "slug"),
                name="catalogues_catalogue_unique_slug_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=("organization", "slug")),
        ]

    def __str__(self) -> str:
        return f"{self.organization.name} / {self.slug}"


class Item(models.Model):
    """A row inside a :class:`Catalogue`.

    The fixed column set is deliberately tight — only the fields every
    catalogue entry needs regardless of what the catalogue represents.
    Everything else lives on the dynamic ``attributes`` map, whose
    schema is defined by :class:`apps.attributes.models.AttributeDefinition`
    rows scoped to the same catalogue.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    catalogue = models.ForeignKey(
        Catalogue,
        on_delete=models.PROTECT,
        related_name="items",
    )
    name = models.CharField(_("name"), max_length=200)
    internal_code = models.CharField(
        _("internal code"),
        max_length=64,
        blank=True,
        help_text=_(
            "Short SKU or part number. Optional, unique per catalogue."
        ),
    )
    unit = models.CharField(
        _("unit"),
        max_length=32,
        blank=True,
        help_text=_("Physical unit the price is quoted in (e.g. g, mL, capsule)."),
    )
    base_price = models.DecimalField(
        _("base price"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    is_archived = models.BooleanField(_("archived"), default=False)

    attributes: models.JSONField = models.JSONField(
        _("attributes"),
        default=dict,
        blank=True,
        help_text=_(
            "Dynamic attribute map keyed by AttributeDefinition.key. "
            "Validated against the active definitions for this "
            "catalogue on every write."
        ),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_items",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_items",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("item")
        verbose_name_plural = _("items")
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=("catalogue", "internal_code"),
                condition=~Q(internal_code=""),
                name="catalogues_item_unique_internal_code_per_catalogue",
            ),
        ]
        indexes = [
            models.Index(fields=("catalogue", "name")),
            models.Index(fields=("catalogue", "is_archived")),
        ]

    def __str__(self) -> str:
        return self.name
