"""Django admin registration for the catalogues app."""

from django.contrib import admin

from apps.catalogues.models import Catalogue, Item


@admin.register(Catalogue)
class CatalogueAdmin(admin.ModelAdmin):
    list_display = (
        "slug",
        "name",
        "organization",
        "is_system",
        "updated_at",
    )
    list_filter = ("is_system", "organization")
    search_fields = ("slug", "name", "organization__name")
    readonly_fields = ("id", "created_at", "updated_at")
    raw_id_fields = ("organization",)
    ordering = ("organization__name", "slug")


@admin.register(Item)
class ItemAdmin(admin.ModelAdmin):
    list_display = (
        "name",
        "internal_code",
        "catalogue",
        "base_price",
        "unit",
        "is_archived",
        "updated_at",
    )
    list_filter = ("is_archived", "catalogue")
    search_fields = ("name", "internal_code")
    readonly_fields = ("id", "created_at", "updated_at", "created_by", "updated_by")
    raw_id_fields = ("catalogue", "created_by", "updated_by")
    ordering = ("catalogue__slug", "name")
