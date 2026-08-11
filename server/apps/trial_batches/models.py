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


class BatchKind(models.TextChoices):
    """Two flavours of R&D manufacturing run — chosen once at
    creation, drives everything downstream.

    ``TRIAL`` is a **bench-scale test**: the entered ``batch_size_units``
    is the raw count of finished individual capsules / tablets /
    scoops the scientist wants to produce (typically 10-50 to prove
    the recipe blends, encapsulates, tastes right, etc). No pack
    multiplier. On PSP the linked MO gets ``project_type = "trial"``,
    which bypasses Final Release and short-circuits the R&D chain
    back to the R&D warehouse after Output QC passes.

    ``SAMPLE`` is a **customer-sample production run**: the entered
    ``batch_size_units`` is a number of finished packs and the BOM
    scales by the formulation's ``servings_per_pack`` snapshot
    ("plan 1 000 bottles of 60 capsules"). On PSP the linked MO
    gets ``project_type = "sample"``, which follows the full
    commercial release path — put-away to quarantine, Final Release
    signed off, then available for dispatch. Same procedure a real
    order would follow so ops can practice the flow end-to-end.
    """

    TRIAL = "trial", _("Trial")
    SAMPLE = "sample", _("Sample")


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
            "Numeric input; interpretation depends on ``kind``. "
            "For ``sample`` this is the number of finished packs "
            "(bottles/pouches/tubs) and scales by servings_per_pack; "
            "for ``trial`` it is the raw count of individual "
            "capsules/tablets/scoops (no pack multiplier)."
        ),
    )
    kind = models.CharField(
        _("kind"),
        max_length=8,
        choices=BatchKind.choices,
        default=BatchKind.SAMPLE,
        help_text=_(
            "``trial`` = bench-scale test, raw unit count, PSP MO "
            "runs as project_type=trial (bypasses Final Release). "
            "``sample`` = customer-sample production, entered number "
            "× servings_per_pack, PSP MO runs as project_type=sample "
            "(follows the commercial release path)."
        ),
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    #: Optional packaging overlay for ``sample``-kind batches. Null
    #: everywhere else (``trial``-kind bench runs never have
    #: packaging). When set, the linked PSP MO's packaging BOM lines
    #: are replaced by this combo's items at MO-create time — the
    #: same mechanism the proposal → CO flow will use, so a sample MO
    #: rehearses the exact packaging cascade a real customer order
    #: would trigger. When null on a sample batch, the MO runs
    #: without any packaging (loose-bulk output).
    #:
    #: SET_NULL on delete so removing a formulation-level combo
    #: doesn't wipe the batch's audit trail — the row survives with
    #: a null pointer, and the PSP MO already has its own copy of
    #: the combo items baked in.
    packaging_combo = models.ForeignKey(
        "formulations.PackagingCombo",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trial_batches",
        help_text=_(
            "Optional packaging overlay for sample batches. NULL = no "
            "combo picked (loose-bulk output or trial-kind bench run); "
            "populated = the PSP MO's packaging BOM lines are replaced "
            "by the combo's items at MO-create time."
        ),
    )

    #: The customer-sample Payment this batch is fulfilling, if any.
    #: Populated when a scientist creates the batch from the R&D
    #: Samples page (:module:`apps.trial_batches.api.samples_views`)
    #: so the fulfilment queue can filter it out — "which sample
    #: requests have I not yet turned into a batch?" is a
    #: ``Payment WHERE NOT EXISTS (…source_payment=payment.id)``
    #: query rather than fuzzy matching on customer + formulation.
    #:
    #: SET_NULL on payment delete so voiding / rewriting a Payment
    #: row doesn't cascade the batch away — the fulfilled work
    #: survives with a null pointer, and the audit trail already
    #: records who / when the batch was created.
    source_payment = models.ForeignKey(
        "payments.Payment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="fulfilled_by_trial_batches",
        help_text=_(
            "Sample Payment this batch fulfils. NULL for batches "
            "started from the per-project trial-batches tab (no "
            "payment context); populated when the batch is created "
            "from the R&D Samples fulfilment queue."
        ),
    )

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
