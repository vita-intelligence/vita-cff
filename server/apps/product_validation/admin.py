from django.contrib import admin

from apps.product_validation.models import ProductValidation


@admin.register(ProductValidation)
class ProductValidationAdmin(admin.ModelAdmin):
    list_display = ("id", "trial_batch", "status", "organization", "updated_at")
    list_filter = ("organization", "status")
    readonly_fields = (
        "id",
        "created_at",
        "updated_at",
        "scientist_signed_at",
        "rd_manager_signed_at",
    )
