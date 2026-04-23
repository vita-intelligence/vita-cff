"""Models for the trial-batches app.

A :class:`TrialBatch` is the scientist's scale-up worksheet: they take
a saved :class:`~apps.formulations.models.FormulationVersion` snapshot
and multiply every active, excipient and shell weight by the number of
finished units they plan to manufacture. Procurement then reads the
resulting kg-per-batch BOM straight into MRPeasy (or whichever ERP the
org uses) instead of the scientist copy-pasting cells out of the
``BOM Actives Calculation`` sheet in Excel.

Like :class:`~apps.specifications.models.SpecificationSheet`, the batch
pins against a *version* rather than the mutable formulation. Catalogue
edits or line tweaks made after the batch was planned must not silently
rewrite a procurement document that may have already left the building.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class BatchSizeMode(models.TextChoices):
    """Two ways the scientist can size a trial run.

    ``PACK`` multiplies the entered quantity by the formulation's
    ``servings_per_pack`` snapshot — useful for production-scale
    runs ("plan 1000 bottles of 60 capsules"). ``UNIT`` treats the
    quantity as the raw number of finished individual capsules /
    tablets / scoops — useful for bench-scale tests where the
    scientist only needs 10 capsules, not 10 × 360 = 3 600.
    """

    PACK = "pack", _("Pack")
    UNIT = "unit", _("Individual units")


class TrialBatch(models.Model):
    """A planned manufacturing run against a frozen formulation version."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="trial_batches",
    )
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="trial_batches",
        help_text=_(
            "Immutable snapshot the batch scales against. Editing the "
            "underlying formulation never rewrites this batch's BOM."
        ),
    )

    label = models.CharField(
        _("label"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Optional human-readable name — e.g. "
            "``Pilot run 2026-04-17`` or ``First production lot``."
        ),
    )
    batch_size_units = models.PositiveIntegerField(
        _("batch size"),
        help_text=_(
            "Numeric input; interpretation depends on ``batch_size_mode``. "
            "In ``pack`` mode this is the number of finished packs "
            "(bottles/pouches/tubs); in ``unit`` mode it is the raw "
            "count of individual capsules/tablets/scoops."
        ),
    )
    batch_size_mode = models.CharField(
        _("batch size mode"),
        max_length=8,
        choices=BatchSizeMode.choices,
        default=BatchSizeMode.PACK,
        help_text=_(
            "``pack`` multiplies by servings_per_pack; ``unit`` uses "
            "the entered number directly. Bench-scale QC tests "
            "usually want ``unit`` so a 10-capsule test does not get "
            "scaled up to 10 × 360 = 3 600."
        ),
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_trial_batches",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_trial_batches",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("trial batch")
        verbose_name_plural = _("trial batches")
        ordering = ("-updated_at",)
        indexes = [
            models.Index(fields=("organization", "-updated_at")),
            models.Index(fields=("formulation_version", "-created_at")),
        ]

    def __str__(self) -> str:
        return self.label or str(self.id)
