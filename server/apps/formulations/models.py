"""Domain models for the formulations app.

A :class:`Formulation` is the working workspace a scientist edits to
turn a customer brief into a production-ready formula. It holds all
the mutable state (metadata + ingredient lines) that the builder UI
drives directly. Every save snapshots the current state into an
immutable :class:`FormulationVersion` so the scientist can iterate
freely and roll back without losing history.

``FormulationLine`` holds the active ingredient rows in their editable
form (FK to the parent formulation). Versions stash the same data as
a denormalised JSON snapshot — versions are frozen history, not a
mirror of mutable rows, so we never have to join back through the
line table to reconstruct an older state.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.formulations.constants import DosageForm


class ProjectStatus(models.TextChoices):
    """Product-roadmap status of the project (==formulation).

    The single lifecycle chip surfaced on the project workspace.
    R&D sign-off (scientist + manager signatures) lives on version
    snapshots and validations rather than on the formulation
    header — separating "is the recipe done" from "where is the
    product going" had no real-world readers, so we collapsed to
    this one roadmap field.
    """

    CONCEPT = "concept", _("Concept")
    IN_DEVELOPMENT = "in_development", _("In development")
    PILOT = "pilot", _("Pilot")
    APPROVED = "approved", _("Approved")
    DISCONTINUED = "discontinued", _("Discontinued")


class DosageFormChoices(models.TextChoices):
    POWDER = DosageForm.POWDER.value, _("Powder")
    CAPSULE = DosageForm.CAPSULE.value, _("Capsule")
    TABLET = DosageForm.TABLET.value, _("Tablet")
    GUMMY = DosageForm.GUMMY.value, _("Gummy")
    LIQUID = DosageForm.LIQUID.value, _("Liquid")
    OTHER_SOLID = DosageForm.OTHER_SOLID.value, _("Other solid")


class Formulation(models.Model):
    """A single product workspace inside an organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="formulations",
    )
    code = models.CharField(
        _("code"),
        max_length=64,
        blank=True,
        help_text=_("Internal product code. Optional, unique per org when set."),
    )
    name = models.CharField(_("name"), max_length=200)
    description = models.TextField(_("description"), blank=True, default="")

    dosage_form = models.CharField(
        _("dosage form"),
        max_length=32,
        choices=DosageFormChoices.choices,
        default=DosageFormChoices.CAPSULE,
    )
    #: Key from :data:`apps.formulations.constants.CAPSULE_SIZES`. Null
    #: when the scientist has not picked one yet — the math falls back
    #: to :func:`auto_pick_capsule_size`.
    capsule_size = models.CharField(
        _("capsule size"), max_length=32, blank=True, default=""
    )
    #: Key from :data:`apps.formulations.constants.TABLET_SIZES`.
    tablet_size = models.CharField(
        _("tablet size"), max_length=32, blank=True, default=""
    )

    serving_size = models.PositiveIntegerField(
        _("serving size"),
        default=1,
        help_text=_("Units (capsules/tablets/scoops) the customer consumes per serving."),
    )
    servings_per_pack = models.PositiveIntegerField(
        _("servings per pack"), default=60
    )
    directions_of_use = models.TextField(
        _("directions of use"), blank=True, default=""
    )
    suggested_dosage = models.TextField(
        _("suggested dosage"), blank=True, default=""
    )
    appearance = models.CharField(
        _("appearance"), max_length=200, blank=True, default=""
    )
    disintegration_spec = models.CharField(
        _("disintegration spec"),
        max_length=200,
        blank=True,
        default="",
        help_text=_("Target disintegration time (e.g. 'within 60 minutes')."),
    )
    target_fill_weight_mg = models.DecimalField(
        _("target fill weight (mg)"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Target fill weight per serving unit — sachet mass for "
            "powders, single-gummy weight for gummies. Drives the "
            "fill-weight check (total ingredients should equal "
            "this target). Leave blank for capsule/tablet where "
            "the math uses the selected size instead."
        ),
    )

    project_status = models.CharField(
        _("project status"),
        max_length=16,
        choices=ProjectStatus.choices,
        default=ProjectStatus.CONCEPT,
        db_index=True,
        help_text=_(
            "Product-roadmap position. Drives the chip shown at the "
            "top of the project workspace and the project list filter."
        ),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_formulations",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_formulations",
    )
    # Commercial owner of the project. Pointer-only: being the sales
    # person does not unlock any capabilities on its own. Assignment
    # is gated on the dedicated ``formulations.assign_sales_person``
    # capability and the candidate must be a member of the same
    # organization. ``SET_NULL`` keeps the project alive if the person
    # later leaves — the field clears, history of who held it lives in
    # the audit log.
    sales_person = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="sales_formulations",
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("formulation")
        verbose_name_plural = _("formulations")
        ordering = ("-updated_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "code"),
                condition=~models.Q(code=""),
                name="formulations_unique_code_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=("organization", "-updated_at")),
        ]

    def __str__(self) -> str:
        return self.name


class FormulationLine(models.Model):
    """An active ingredient row on a formulation.

    ``mg_per_serving_cached`` is the service-computed raw powder weight
    (label_claim divided by purity or extract ratio, with overage).
    We persist it so downstream views don't re-run the cascade on
    every render, and so the viability totals stay consistent with
    whatever the scientist saw in the UI at save time.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="lines",
    )
    item = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        related_name="formulation_lines",
    )
    display_order = models.PositiveIntegerField(_("display order"), default=0)
    label_claim_mg = models.DecimalField(
        _("label claim (mg)"),
        max_digits=12,
        decimal_places=4,
    )
    serving_size_override = models.PositiveIntegerField(
        _("serving size override"),
        null=True,
        blank=True,
        help_text=_("Per-line override; falls back to the formulation's serving size."),
    )
    mg_per_serving_cached = models.DecimalField(
        _("mg per serving (cached)"),
        max_digits=14,
        decimal_places=4,
        null=True,
        blank=True,
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("formulation line")
        verbose_name_plural = _("formulation lines")
        ordering = ("display_order", "created_at")
        indexes = [
            models.Index(fields=("formulation", "display_order")),
        ]

    def __str__(self) -> str:
        return f"{self.item.name} ({self.label_claim_mg} mg)"


class FormulationVersion(models.Model):
    """Immutable snapshot of a formulation at save time.

    Snapshots intentionally denormalise into JSON rather than cloning
    line rows: versions are append-only history, rarely queried for
    analytics, and we avoid the foot-gun where rolling back "by FK"
    resurrects stale item references that no longer match the source
    catalogue.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="versions",
    )
    version_number = models.PositiveIntegerField(_("version number"))
    label = models.CharField(
        _("label"),
        max_length=150,
        blank=True,
        default="",
        help_text=_("Short scientist-written note (e.g. 'caffeine bumped to 200mg')."),
    )

    #: Denormalised snapshot of the formulation header at save time.
    snapshot_metadata: models.JSONField = models.JSONField(
        _("snapshot metadata"),
        default=dict,
        blank=True,
    )
    #: Denormalised snapshot of every line at save time. Each entry is
    #: ``{item_id, item_name, item_internal_code, label_claim_mg,
    #: serving_size_override, mg_per_serving, display_order, notes}``.
    snapshot_lines: models.JSONField = models.JSONField(
        _("snapshot lines"),
        default=list,
        blank=True,
    )
    #: Pre-computed totals block saved alongside the snapshot so
    #: history screens never re-run the math.
    snapshot_totals: models.JSONField = models.JSONField(
        _("snapshot totals"),
        default=dict,
        blank=True,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_formulation_versions",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("formulation version")
        verbose_name_plural = _("formulation versions")
        ordering = ("-version_number",)
        constraints = [
            models.UniqueConstraint(
                fields=("formulation", "version_number"),
                name="formulations_version_unique_number_per_formulation",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.formulation.name} v{self.version_number}"
