from __future__ import annotations

from django.contrib import admin

from apps.payments.models import Payment


@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "organization",
        "formulation",
        "amount",
        "currency",
        "method",
        "status",
        "paid_at",
        "approved_at",
    )
    list_filter = ("status", "method", "currency")
    search_fields = (
        "formulation__code",
        "formulation__name",
        "invoice_number",
        "external_reference",
    )
    readonly_fields = ("created_at", "updated_at")
