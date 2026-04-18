"""Serializers for the AI API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.ai.models import AIProviderChoices


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class FormulationDraftRequestSerializer(serializers.Serializer):
    """Input shape for ``POST /organizations/<org>/ai/formulation-draft/``.

    ``brief`` is the natural-language description the user typed.
    ``provider`` picks the backend (``ollama`` only for now); future
    adapters add themselves to :class:`AIProviderChoices` and become
    valid values automatically.
    """

    brief = serializers.CharField(
        required=True, allow_blank=False, max_length=4000
    )
    provider = serializers.ChoiceField(
        choices=AIProviderChoices.choices,
        required=False,
        default=AIProviderChoices.OLLAMA,
    )
    #: Optional override — lets power users pick e.g. ``llama3.1:70b``
    #: when the default ``llama3.1:8b`` isn't cutting it. Empty string
    #: means "use the server default", which the adapter picks up.
    model = serializers.CharField(
        required=False, allow_blank=True, default=""
    )

    def validate_brief(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class IngredientSuggestionSerializer(serializers.Serializer):
    name = serializers.CharField()
    label_claim_mg = serializers.FloatField()
    notes = serializers.CharField(allow_blank=True)


class FormulationDraftResponseSerializer(serializers.Serializer):
    """Mirrors :class:`apps.ai.services.FormulationDraft`."""

    name = serializers.CharField()
    code = serializers.CharField(allow_blank=True)
    description = serializers.CharField(allow_blank=True)
    dosage_form = serializers.CharField()
    capsule_size = serializers.CharField(allow_blank=True)
    tablet_size = serializers.CharField(allow_blank=True)
    serving_size = serializers.IntegerField()
    servings_per_pack = serializers.IntegerField()
    directions_of_use = serializers.CharField(allow_blank=True)
    suggested_dosage = serializers.CharField(allow_blank=True)
    appearance = serializers.CharField(allow_blank=True)
    disintegration_spec = serializers.CharField(allow_blank=True)
    ingredients = IngredientSuggestionSerializer(many=True)

    def to_representation(self, instance: Any) -> dict[str, Any]:
        # ``instance`` is a ``FormulationDraft`` dataclass — the parent
        # implementation expects a dict-like, so convert once here.
        from apps.ai.services import FormulationDraft, draft_to_dict

        if isinstance(instance, FormulationDraft):
            return super().to_representation(draft_to_dict(instance))
        return super().to_representation(instance)
