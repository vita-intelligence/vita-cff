"""Models for the product-validation app.

A :class:`ProductValidation` is the QC paperwork attached to a
:class:`~apps.trial_batches.models.TrialBatch` — five physical tests
(weight, hardness, thickness, disintegration, organoleptic) plus the
MRPeasy readiness checklist, plus the scientist + R&D manager
sign-off stamps.

Every test's raw sample measurements live inside a JSON blob. Storing
the samples as JSON (rather than as a separate row-per-sample table)
lets the whole validation render from a single ``SELECT`` and keeps
the admin UX trivial — the scientist fills a form, the form posts a
list of floats, we keep it as a list of floats. Computed summary
statistics (mean, standard deviation, pass/fail flags) are never
persisted on the JSON — they are derived on every read via the pure
:func:`~apps.product_validation.services.compute_validation_stats`
function. Persisting derived values would be redundant and would
drift the moment the tolerance rules change.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class ValidationStatus(models.TextChoices):
    """Lifecycle of a :class:`ProductValidation`.

    Separate from the trial batch's own state — a batch can be
    physically produced long before its validation is drafted, and
    two batches can share a formulation while one passes QC and the
    other fails.
    """

    DRAFT = "draft", _("Draft")
    IN_PROGRESS = "in_progress", _("In progress")
    PASSED = "passed", _("Passed")
    FAILED = "failed", _("Failed")


class ProductValidation(models.Model):
    """QC record for one manufacturing run."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="product_validations",
    )
    trial_batch = models.OneToOneField(
        "trial_batches.TrialBatch",
        on_delete=models.CASCADE,
        related_name="validation",
        help_text=_(
            "One validation per batch. Deleting the batch cascades — "
            "the QC record is meaningless once the physical run it "
            "documents is gone."
        ),
    )

    # ------------------------------------------------------------------
    # Test payloads — see ``services._empty_<test>()`` for the expected
    # shape of each JSON blob. Storing blanks with a known shape means
    # every validation renders the full form the first time it opens,
    # rather than surfacing a tangle of ``None`` branches on the
    # frontend.
    # ------------------------------------------------------------------
    weight_test = models.JSONField(
        _("weight test"),
        default=dict,
        blank=True,
        help_text=_(
            "``{target_mg, tolerance_pct, samples: [mg, ...], notes}``. "
            "Stats (mean, stdev, pass/fail) are computed on read."
        ),
    )
    hardness_test = models.JSONField(
        _("hardness test"),
        default=dict,
        blank=True,
        help_text=_(
            "``{target_min_n, target_max_n, samples: [N, ...], notes}``. "
            "Tablet-only; capsules leave this untouched."
        ),
    )
    thickness_test = models.JSONField(
        _("thickness test"),
        default=dict,
        blank=True,
        help_text=_(
            "``{target_mm, tolerance_mm, samples: [mm, ...], notes}``. "
            "Tablet-only; capsules leave this untouched."
        ),
    )
    disintegration_test = models.JSONField(
        _("disintegration test"),
        default=dict,
        blank=True,
        help_text=_(
            "``{limit_minutes, temperature_c, samples: [minutes, ...], "
            "notes}``. The worst-case sample drives pass/fail."
        ),
    )
    organoleptic_test = models.JSONField(
        _("organoleptic test"),
        default=dict,
        blank=True,
        help_text=_(
            "``{target: {colour, taste, odour}, actual: {colour, taste, "
            "odour}, passed, notes}``. Subjective, so pass/fail is "
            "recorded by the scientist rather than derived."
        ),
    )
    mrpeasy_checklist = models.JSONField(
        _("MRPeasy checklist"),
        default=dict,
        blank=True,
        help_text=_(
            "``{raw_materials_created, finished_product_created, "
            "boms_verified}``. Booleans the scientist ticks once the "
            "batch's BOM has been wired into the ERP."
        ),
    )

    # ------------------------------------------------------------------
    # Lifecycle + signatures
    # ------------------------------------------------------------------
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=ValidationStatus.choices,
        default=ValidationStatus.DRAFT,
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    scientist_signature = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="signed_validations_as_scientist",
        help_text=_(
            "Stamped when the validation moves past ``draft``. "
            "Records *who* ran the QC, not just that QC ran."
        ),
    )
    scientist_signed_at = models.DateTimeField(
        _("scientist signed at"), null=True, blank=True
    )
    scientist_signature_image = models.TextField(
        _("scientist signature image"),
        blank=True,
        default="",
        help_text=_(
            "Base64 PNG data URL captured on the signature pad at "
            "transition time. Required to move ``draft → in_progress``."
        ),
    )
    rd_manager_signature = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="signed_validations_as_rd_manager",
        help_text=_(
            "Stamped when the validation reaches ``passed`` or "
            "``failed`` — the manager's sign-off is what releases or "
            "rejects the batch."
        ),
    )
    rd_manager_signed_at = models.DateTimeField(
        _("R&D manager signed at"), null=True, blank=True
    )
    rd_manager_signature_image = models.TextField(
        _("R&D manager signature image"),
        blank=True,
        default="",
        help_text=_(
            "Base64 PNG data URL captured on the signature pad at "
            "transition time. Required to reach ``passed`` / ``failed``."
        ),
    )

    # ------------------------------------------------------------------
    # Audit
    # ------------------------------------------------------------------
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_product_validations",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_product_validations",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("product validation")
        verbose_name_plural = _("product validations")
        ordering = ("-updated_at",)
        indexes = [
            models.Index(fields=("organization", "status")),
            models.Index(fields=("organization", "-updated_at")),
        ]

    def __str__(self) -> str:
        return f"Validation for {self.trial_batch_id}"
