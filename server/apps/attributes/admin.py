"""Django admin registration for the attributes app."""

from django.contrib import admin

from apps.attributes.models import AttributeDefinition


@admin.register(AttributeDefinition)
class AttributeDefinitionAdmin(admin.ModelAdmin):
    list_display = (
        "label",
        "key",
        "catalogue",
        "data_type",
        "required",
        "is_archived",
        "updated_at",
    )
    list_filter = ("catalogue", "data_type", "is_archived")
    search_fields = ("key", "label", "catalogue__slug", "catalogue__organization__name")
    readonly_fields = ("id", "created_at", "updated_at", "created_by", "updated_by")
    raw_id_fields = ("catalogue", "created_by", "updated_by")
    ordering = ("catalogue__slug", "display_order", "label")
