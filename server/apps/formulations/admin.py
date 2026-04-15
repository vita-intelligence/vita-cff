"""Django admin registration for the formulations app."""

from django.contrib import admin

from apps.formulations.models import (
    Formulation,
    FormulationLine,
    FormulationVersion,
)


class FormulationLineInline(admin.TabularInline):
    model = FormulationLine
    extra = 0
    raw_id_fields = ("item",)
    fields = (
        "display_order",
        "item",
        "label_claim_mg",
        "serving_size_override",
        "mg_per_serving_cached",
        "notes",
    )


@admin.register(Formulation)
class FormulationAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "code",
        "dosage_form",
        "status",
        "organization",
        "updated_at",
    )
    list_filter = ("status", "dosage_form", "organization")
    search_fields = ("name", "code")
    readonly_fields = ("id", "created_at", "updated_at", "created_by", "updated_by")
    raw_id_fields = ("organization", "created_by", "updated_by")
    inlines = (FormulationLineInline,)


@admin.register(FormulationVersion)
class FormulationVersionAdmin(admin.ModelAdmin):
    list_display = ("formulation", "version_number", "label", "created_at")
    list_filter = ("formulation__organization",)
    search_fields = ("formulation__name", "label")
    readonly_fields = (
        "id",
        "formulation",
        "version_number",
        "snapshot_metadata",
        "snapshot_lines",
        "snapshot_totals",
        "created_by",
        "created_at",
    )
