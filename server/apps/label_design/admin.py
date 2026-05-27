"""Minimal admin surface for the label-design workflow.

The user-facing surface lives in the API + Next.js client; admin is
mostly an internal debugging tool, so we only register read-only
list views with the essential columns.
"""

from __future__ import annotations

from django.contrib import admin

from apps.label_design.models import (
    LabelDesign,
    LabelDesignPreferenceFile,
    LabelDesignPreferences,
    LabelDesignReview,
    LabelDesignRevision,
    LabelDesignTransition,
)


@admin.register(LabelDesign)
class LabelDesignAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "organization",
        "formulation",
        "status",
        "design_path",
        "assigned_designer",
        "rejection_count",
        "updated_at",
    )
    list_filter = ("status", "design_path", "organization")
    search_fields = ("formulation__code", "formulation__name")
    readonly_fields = ("created_at", "updated_at")


@admin.register(LabelDesignRevision)
class LabelDesignRevisionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "label_design",
        "revision_number",
        "source",
        "submitted_at",
        "customer_approved_own_design",
    )
    list_filter = ("source",)
    search_fields = ("label_design__formulation__code",)
    readonly_fields = ("submitted_at",)


@admin.register(LabelDesignReview)
class LabelDesignReviewAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "revision",
        "kind",
        "reviewer",
        "outcome",
        "created_at",
    )
    list_filter = ("kind", "outcome")
    readonly_fields = ("created_at",)


@admin.register(LabelDesignPreferences)
class LabelDesignPreferencesAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "submitted_by_client",
        "design_style",
        "material_type",
        "submitted_at",
    )
    list_filter = ("design_style", "material_type")
    readonly_fields = ("submitted_at",)


@admin.register(LabelDesignPreferenceFile)
class LabelDesignPreferenceFileAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "preferences",
        "original_name",
        "size_bytes",
        "uploaded_at",
    )
    readonly_fields = ("uploaded_at",)


@admin.register(LabelDesignTransition)
class LabelDesignTransitionAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "label_design",
        "from_status",
        "to_status",
        "actor",
        "actor_client_account",
        "created_at",
    )
    list_filter = ("from_status", "to_status")
    readonly_fields = ("created_at",)
