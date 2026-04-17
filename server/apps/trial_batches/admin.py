from django.contrib import admin

from apps.trial_batches.models import TrialBatch


@admin.register(TrialBatch)
class TrialBatchAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "label",
        "organization",
        "formulation_version",
        "batch_size_units",
        "updated_at",
    )
    list_filter = ("organization",)
    search_fields = ("label", "notes")
    readonly_fields = ("id", "created_at", "updated_at")
