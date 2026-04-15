"""Domain models for the typed attribute registry.

An :class:`AttributeDefinition` describes a single dynamic field on
items inside a given :class:`apps.catalogues.models.Catalogue`. The
set of active definitions for a catalogue is the authoritative
"schema" for the JSONB ``attributes`` column on every item in that
catalogue, enforced on every write by
:func:`apps.attributes.services.validate_values`.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class DataType(models.TextChoices):
    TEXT = "text", _("Text")
    NUMBER = "number", _("Number")
    BOOLEAN = "boolean", _("Boolean")
    DATE = "date", _("Date")
    SINGLE_SELECT = "single_select", _("Single select")
    MULTI_SELECT = "multi_select", _("Multi select")


class AttributeDefinition(models.Model):
    """A per-catalogue typed field description.

    Deliberate design rules:

    * ``key`` is a stable machine identifier (``snake_case``) and is
      never renamed after creation — renaming would orphan every
      existing value on every row in the catalogue.
    * Archiving is the only form of removal. Hard delete would drop
      values from item rows without a trace; we keep the definition
      row but flip ``is_archived`` so the validator stops requiring
      it and the UI stops showing it.
    * ``options`` is an ordered list of ``{"value": ..., "label": ...}``
      dicts for the select data types; empty for every other type.
    * Definitions are scoped to a :class:`Catalogue`, not directly to
      an :class:`Organization`, so raw materials and packaging can
      carry entirely different schemas inside the same org.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    catalogue = models.ForeignKey(
        "catalogues.Catalogue",
        on_delete=models.CASCADE,
        related_name="attribute_definitions",
    )
    key = models.CharField(
        _("key"),
        max_length=64,
        help_text=_("Machine identifier. Snake_case, never renamed after creation."),
    )
    label = models.CharField(
        _("label"),
        max_length=150,
    )
    data_type = models.CharField(
        _("data type"),
        max_length=32,
        choices=DataType.choices,
    )
    required = models.BooleanField(_("required"), default=False)
    options: models.JSONField = models.JSONField(
        _("options"),
        default=list,
        blank=True,
        help_text=_("Ordered list of {value, label} pairs for select types."),
    )
    display_order = models.IntegerField(_("display order"), default=0)
    is_archived = models.BooleanField(_("archived"), default=False)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_attribute_definitions",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_attribute_definitions",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("attribute definition")
        verbose_name_plural = _("attribute definitions")
        ordering = ("display_order", "label")
        constraints = [
            models.UniqueConstraint(
                fields=("catalogue", "key"),
                name="attributes_definition_unique_key_per_catalogue",
            ),
        ]
        indexes = [
            models.Index(fields=("catalogue", "is_archived")),
        ]

    def __str__(self) -> str:
        return f"{self.catalogue.slug}.{self.key}"
