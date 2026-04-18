"""Domain models for the AI app.

Everything the AI layer persists sits here. Today that's a single
:class:`AIUsage` row per provider call — enough to power the owner-
facing usage dashboard and the future Stripe-based billing layer.
Request / response bodies themselves are **not** stored; only
metadata the billing and ops code needs.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.organizations.models import Organization


class AIProviderChoices(models.TextChoices):
    """Registered AI providers. Grows as new adapters ship."""

    OLLAMA = "ollama", _("Ollama")
    OPENAI = "openai", _("OpenAI")
    ANTHROPIC = "anthropic", _("Anthropic")


class AIUsagePurpose(models.TextChoices):
    """High-level reason a provider call ran.

    Distinct from ``model`` so the dashboard can group "all formulation
    drafts" even when the underlying model changes over time.
    """

    FORMULATION_DRAFT = "formulation_draft", _("Formulation draft")


class AIUsage(models.Model):
    """A single provider call's metadata.

    One row is written per ``provider.generate_*`` invocation — whether
    successful or not — so the owner dashboard can see errors alongside
    successful runs, and the future billing integration has a complete
    audit trail of what each organization consumed.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="ai_usages",
    )
    #: ``SET_NULL`` so deleting a user doesn't blow away the
    #: organization-level accounting history they generated.
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ai_usages",
    )
    provider = models.CharField(
        _("provider"),
        max_length=32,
        choices=AIProviderChoices.choices,
    )
    model = models.CharField(_("model"), max_length=128)
    purpose = models.CharField(
        _("purpose"),
        max_length=64,
        choices=AIUsagePurpose.choices,
    )
    prompt_tokens = models.IntegerField(
        _("prompt tokens"),
        null=True,
        blank=True,
        help_text=_("Tokens counted by the provider, if reported."),
    )
    completion_tokens = models.IntegerField(
        _("completion tokens"),
        null=True,
        blank=True,
    )
    #: Wall-clock latency of the provider call. Bounded by
    #: ``AI_PROVIDER_TIMEOUT_SECONDS``; on timeout this is the
    #: elapsed time at the point we gave up.
    latency_ms = models.IntegerField(_("latency (ms)"), default=0)
    success = models.BooleanField(_("success"), default=True)
    #: Machine-readable error code when ``success`` is ``False``. Kept
    #: short so aggregations by code are cheap (e.g. ``"timeout"``,
    #: ``"invalid_json"``, ``"provider_unreachable"``).
    error_code = models.CharField(
        _("error code"), max_length=64, blank=True, default=""
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("AI usage")
        verbose_name_plural = _("AI usage entries")
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("organization", "-created_at")),
            models.Index(fields=("provider", "model")),
            models.Index(fields=("purpose",)),
        ]

    def __str__(self) -> str:
        return (
            f"{self.provider}:{self.model} "
            f"({self.purpose}) @ {self.organization_id}"
        )
