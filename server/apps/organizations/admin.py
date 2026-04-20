"""Django admin registration for the organizations app."""

from django.contrib import admin

from apps.organizations.models import Invitation, Membership, Organization


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ("name", "is_active", "created_by", "created_at")
    list_filter = ("is_active",)
    list_editable = ("is_active",)
    search_fields = ("name", "created_by__email")
    readonly_fields = ("id", "created_at", "updated_at")
    ordering = ("name",)
    actions = ("activate_selected", "deactivate_selected")

    @admin.action(description="Activate selected organizations")
    def activate_selected(self, request, queryset) -> None:  # noqa: ANN001
        updated = queryset.update(is_active=True)
        self.message_user(request, f"Activated {updated} organization(s).")

    @admin.action(description="Deactivate selected organizations")
    def deactivate_selected(self, request, queryset) -> None:  # noqa: ANN001
        updated = queryset.update(is_active=False)
        self.message_user(request, f"Deactivated {updated} organization(s).")


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "organization", "is_owner", "created_at")
    list_filter = ("is_owner", "organization")
    search_fields = ("user__email", "organization__name")
    readonly_fields = ("id", "created_at", "updated_at")
    raw_id_fields = ("user", "organization")
    ordering = ("-is_owner", "user__email")


@admin.register(Invitation)
class InvitationAdmin(admin.ModelAdmin):
    list_display = (
        "email",
        "organization",
        "invited_by",
        "accepted_at",
        "expires_at",
        "created_at",
    )
    list_filter = ("organization",)
    search_fields = ("email", "organization__name", "invited_by__email")
    readonly_fields = ("id", "token", "created_at", "updated_at", "accepted_at")
    raw_id_fields = ("organization", "invited_by")
    ordering = ("-created_at",)
