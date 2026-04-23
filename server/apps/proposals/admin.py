from django.contrib import admin

from apps.proposals.models import Proposal, ProposalStatusTransition


@admin.register(Proposal)
class ProposalAdmin(admin.ModelAdmin):
    list_display = (
        "code",
        "organization",
        "template_type",
        "status",
        "customer_name",
        "updated_at",
    )
    list_filter = ("status", "template_type", "organization")
    search_fields = ("code", "customer_name", "customer_email", "customer_company")
    readonly_fields = ("created_at", "updated_at")


@admin.register(ProposalStatusTransition)
class ProposalStatusTransitionAdmin(admin.ModelAdmin):
    list_display = ("proposal", "from_status", "to_status", "actor", "created_at")
    list_filter = ("to_status",)
    readonly_fields = ("created_at",)
