"""Django admin registration for the CFF intake.

The admin is the operator's emergency hatch — manually triggering an
import via the Celery task, spot-checking field labels, reassigning
a CFF to a different project. Read-only on most fields because the
Wix-side payload is the source of truth and we don't want to drift
the cache by hand.
"""

from __future__ import annotations

from django.contrib import admin

from .models import CFFSubmission, WixFormSchemaCache


@admin.register(CFFSubmission)
class CFFSubmissionAdmin(admin.ModelAdmin):
    list_display = (
        "wix_submission_id",
        "organization",
        "wix_status",
        "project",
        "wix_created_date",
        "imported_at",
    )
    list_filter = ("wix_status", "organization", "project")
    search_fields = (
        "wix_submission_id",
        "wix_form_id",
        "project__name",
        "project__code",
    )
    readonly_fields = (
        "id",
        "wix_submission_id",
        "wix_form_id",
        "wix_namespace",
        "wix_status",
        "wix_created_date",
        "wix_updated_date",
        "raw_payload",
        "imported_at",
        "last_synced_at",
    )
    autocomplete_fields = ("project", "assigned_by")
    ordering = ("-wix_created_date",)


@admin.register(WixFormSchemaCache)
class WixFormSchemaCacheAdmin(admin.ModelAdmin):
    list_display = ("wix_form_id", "wix_namespace", "fetched_at")
    readonly_fields = (
        "wix_form_id",
        "wix_namespace",
        "field_labels",
        "raw_schema",
        "fetched_at",
    )
