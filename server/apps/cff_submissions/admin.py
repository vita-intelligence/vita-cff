"""Django admin registration for the CFF intake.

The admin is the operator's emergency hatch — manually triggering an
import via the Celery task, spot-checking field labels, reassigning
a CFF to a different project. Read-only on most fields because the
Wix-side payload is the source of truth and we don't want to drift
the cache by hand.
"""

from __future__ import annotations

from django.contrib import admin

from .models import CFFProjectAssignment, CFFSubmission, WixFormSchemaCache


class CFFProjectAssignmentInline(admin.TabularInline):
    """Inline editor for the M2M ``CFFSubmission`` ↔ ``Formulation``
    link. Operators can attach a CFF to a fresh project from the
    detail view without leaving the admin — same UX as before the
    M2M migration, just collection-shaped now."""

    model = CFFProjectAssignment
    extra = 0
    autocomplete_fields = ("project", "assigned_by")
    readonly_fields = ("assigned_at",)


@admin.register(CFFSubmission)
class CFFSubmissionAdmin(admin.ModelAdmin):
    list_display = (
        "wix_submission_id",
        "organization",
        "wix_status",
        "project_codes",
        "wix_created_date",
        "imported_at",
    )
    list_filter = ("wix_status", "organization")
    search_fields = (
        "wix_submission_id",
        "wix_form_id",
        "projects__name",
        "projects__code",
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
    inlines = (CFFProjectAssignmentInline,)
    ordering = ("-wix_created_date",)

    @admin.display(description="Projects")
    def project_codes(self, obj: CFFSubmission) -> str:
        """Comma-separated project codes for the list view. Empty
        when the CFF is still in triage (no assignments yet)."""

        codes = list(
            obj.projects.values_list("code", flat=True).order_by("code")
        )
        return ", ".join(c for c in codes if c) or "—"


@admin.register(CFFProjectAssignment)
class CFFProjectAssignmentAdmin(admin.ModelAdmin):
    """Standalone admin for the through-table so an operator can audit
    the full history (re-attaches show as separate rows) and bulk-
    detach if the wrong project was chosen."""

    list_display = ("submission", "project", "assigned_by", "assigned_at")
    list_filter = ("project__organization",)
    search_fields = (
        "submission__wix_submission_id",
        "project__code",
        "project__name",
    )
    autocomplete_fields = ("submission", "project", "assigned_by")
    readonly_fields = ("assigned_at",)
    ordering = ("-assigned_at",)


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
