"""Django admin registration for the specifications app."""

from django.contrib import admin

from apps.specifications.models import SpecificationSheet


@admin.register(SpecificationSheet)
class SpecificationSheetAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "client_company",
        "client_name",
        "status",
        "organization",
        "updated_at",
    )
    list_filter = ("status", "organization")
    search_fields = ("code", "client_name", "client_company", "client_email")
    readonly_fields = ("id", "created_at", "updated_at", "created_by", "updated_by")
    raw_id_fields = (
        "organization",
        "formulation_version",
        "created_by",
        "updated_by",
    )
