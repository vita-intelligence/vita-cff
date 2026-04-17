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
        _("batch size (units)"),
        help_text=_(
            "Number of finished product units (capsules, tablets, bottles, "
            "pouches...) the batch will produce. Drives the scale-up math."
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
