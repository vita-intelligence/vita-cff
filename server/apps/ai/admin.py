from django.contrib import admin

from apps.ai.models import AIUsage


@admin.register(AIUsage)
class AIUsageAdmin(admin.ModelAdmin):
    list_display = (
        "created_at",
        "organization",
        "user",
        "provider",
        "model",
        "purpose",
        "success",
        "latency_ms",
        "prompt_tokens",
        "completion_tokens",
    )
    list_filter = ("provider", "purpose", "success")
    search_fields = ("organization__name", "user__email", "model")
    readonly_fields = tuple(
        f.name for f in AIUsage._meta.get_fields() if not f.many_to_many
    )
    ordering = ("-created_at",)
