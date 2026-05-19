"""Database models for the CFF (Custom Formulation Request Form) intake surface.

Customers fill in a public Wix-hosted form at vitamanufacture.co.uk. The
Celery beat task in this app polls Wix every few minutes and upserts
each submission into :class:`CFFSubmission`. A team member with the
``cff_submissions.assign_project`` capability later attaches a
submission to a :class:`apps.formulations.Formulation` (project), at
which point the actual product workspace gets created or wired up.

Schema is denormalised on purpose — the full Wix payload lives in
``raw_payload`` JSONB so the UI can render arbitrary form fields
without us shipping a migration every time a question is added or
renamed in Wix. Field labels (Wix gives us ugly slugs like
``email_fc7d``) are resolved through :class:`WixFormSchemaCache`.
"""

from __future__ import annotations

import uuid

from django.db import models
from django.utils.translation import gettext_lazy as _


class CFFSubmissionStatus(models.TextChoices):
    """Mirror of Wix's ``status`` field on a Submission object.

    Wix's enum is open-ended — "UNKNOWN" catches any future status
    the API returns that we haven't taught the codebase about yet so
    a single bad row never breaks the import.
    """

    CONFIRMED = "CONFIRMED", _("Confirmed")
    PENDING = "PENDING", _("Pending")
    PAYMENT_REQUIRED = "PAYMENT_REQUIRED", _("Payment required")
    PAYMENT_PENDING = "PAYMENT_PENDING", _("Payment pending")
    PAYMENT_CANCELED = "PAYMENT_CANCELED", _("Payment canceled")
    UNKNOWN = "UNKNOWN", _("Unknown")


class CFFSubmission(models.Model):
    """One CFF submission, mirrored from Wix.

    ``wix_submission_id`` is the idempotency key — re-imports update
    the existing row in place. ``raw_payload`` is the source of truth
    for what the customer answered; everything else on the row is
    either denormalised lookup data (for filtering / ordering) or
    workspace state we've added on top (assignment, audit).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.PROTECT,
        related_name="cff_submissions",
        help_text=_(
            "Org that owns this CFF intake stream. Populated at import "
            "time from settings.WIX_CFF_TARGET_ORGANIZATION_ID."
        ),
    )

    #: Wix-side identifiers. ``wix_submission_id`` is unique so the
    #: importer can ``update_or_create`` safely; ``wix_form_id`` and
    #: ``wix_namespace`` are kept on the row (rather than derived
    #: from a config table) so a future migration to a multi-form
    #: intake is a config change, not a schema change.
    wix_submission_id = models.UUIDField(
        unique=True,
        help_text=_("Wix's id for the submission. Idempotency key."),
    )
    wix_form_id = models.UUIDField(db_index=True)
    wix_namespace = models.CharField(max_length=64, default="wix.form_app.form")

    wix_status = models.CharField(
        max_length=32,
        choices=CFFSubmissionStatus.choices,
        default=CFFSubmissionStatus.UNKNOWN,
    )

    wix_created_date = models.DateTimeField()
    wix_updated_date = models.DateTimeField()

    raw_payload = models.JSONField(
        help_text=_(
            "Full submission object from Wix. Rendered field-by-field "
            "in the UI; never re-shape into columns or we lose the "
            "ability to handle form-schema drift."
        ),
    )

    project = models.ForeignKey(
        "formulations.Formulation",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="cff_submissions",
        help_text=_(
            "Project this CFF was assigned to. Null = unassigned, "
            "which is the headline state surfaced by the UI."
        ),
    )
    assigned_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text=_("User who attached this CFF to its project."),
    )
    assigned_at = models.DateTimeField(null=True, blank=True)

    imported_at = models.DateTimeField(auto_now_add=True)
    last_synced_at = models.DateTimeField(
        auto_now=True,
        help_text=_("Stamped on every successful re-pull from Wix."),
    )

    class Meta:
        verbose_name = _("CFF submission")
        verbose_name_plural = _("CFF submissions")
        ordering = ("-wix_created_date",)
        indexes = [
            # Primary list view: org + assigned/unassigned + recency.
            # Composite indexes on (org, project) and (org, created)
            # cover the "unassigned in my org, newest first" filter
            # which is the default UI view.
            models.Index(fields=["organization", "project"]),
            models.Index(fields=["organization", "-wix_created_date"]),
            models.Index(fields=["organization", "-wix_updated_date"]),
        ]

    def __str__(self) -> str:
        return f"CFF {self.wix_submission_id} ({self.wix_status})"

    @property
    def is_assigned(self) -> bool:
        return self.project_id is not None


class WixFormSchemaCache(models.Model):
    """Cached form schema fetched from Wix's Get Form endpoint.

    Lets the UI display human labels ("Email", "Company") instead of
    the Wix-internal slugs ("email_fc7d", "company_name_3ab2"). One
    row per ``(wix_form_id, wix_namespace)``. Refreshed by the
    importer whenever it encounters an unknown field key, or by a
    24h TTL when the importer next runs.
    """

    wix_form_id = models.UUIDField()
    wix_namespace = models.CharField(max_length=64)

    field_labels = models.JSONField(
        help_text=_(
            "Mapping {field_key: human_label}. Looked up by the UI "
            "every time a submission is rendered, so keep it flat."
        ),
    )
    raw_schema = models.JSONField(
        help_text=_("Full schema response — kept for debugging only."),
    )
    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("Wix form schema cache")
        verbose_name_plural = _("Wix form schema caches")
        constraints = [
            models.UniqueConstraint(
                fields=["wix_form_id", "wix_namespace"],
                name="cff_wix_form_schema_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"Schema for {self.wix_form_id}"
