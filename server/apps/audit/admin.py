"""Django admin registration for the audit log.

Kept read-only on purpose: audit rows are immutable by contract —
editing them from the admin would undermine the whole point of the
table. The list view lets ops drill into action/target quickly
while a dedicated Phase C UI is being built.
"""

from django.contrib import admin

from apps.audit.models import AuditLog


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "organization",
        "actor",
        "action",
        "target_type",
        "target_id",
    )
    list_filter = ("action", "target_type", "organization")
    search_fields = ("action", "target_id", "actor__email")
    readonly_fields = (
        "id",
        "organization",
        "actor",
        "action",
        "target_type",
        "target_id",
        "before",
        "after",
        "created_at",
    )

    def has_add_permission(self, request):  # type: ignore[override]
        return False

    def has_change_permission(self, request, obj=None):  # type: ignore[override]
        return False

    def has_delete_permission(self, request, obj=None):  # type: ignore[override]
        return False
