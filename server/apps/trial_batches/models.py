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

    #: PSP Manufacturing Order uuid this batch spawned. Nullable —
    #: blank until the scientist clicks "Create MO on PSP". Populated
    #: on that action + used as the idempotency handle for retry-safe
    #: creates (PSP's ``manufacturing_orders_npd_trial_batch_uuid``
    #: unique partial index enforces one MO per trial). We store the
    #: raw uuid rather than an FK because PSP lives in its own
    #: database — the uuid is the cross-system reference.
    psp_manufacturing_order_uuid = models.UUIDField(
        null=True,
        blank=True,
        help_text=_(
            "Cross-system handle for the PSP Manufacturing Order this "
            "trial batch spawned."
        ),
    )

    #: Cached "every stage MO in the linked chain has status =
    #: completed" flag. Kept locally so the QC-tab wizard gate on the
    #: project overview doesn't have to make an HTTP hop to PSP on
    #: every render. Refreshed:
    #:
    #: * whenever the trial-batch detail page fetches the MO chain
    #:   (the panel polls at 20s), or
    #: * by the overview endpoint itself when it notices a linked
    #:   batch is still ``False`` — silent-degrade on any PSP error.
    #:
    #: Once ``True`` the shop floor has finished producing the batch
    #: and QC / validation is fair game. Default ``False`` because a
    #: brand-new batch (with or without a linked MO) has never been
    #: manufactured.
    psp_all_stages_completed = models.BooleanField(
        default=False,
        help_text=_(
            "Cached: every stage MO in the PSP chain has "
            "``status = completed``. Drives the QC tab gate."
        ),
    )

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
