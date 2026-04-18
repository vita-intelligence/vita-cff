"""Serializers for the formulations API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.formulations.models import (
    DosageFormChoices,
    Formulation,
    FormulationLine,
    FormulationVersion,
    ProjectStatus,
)


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class FormulationLineReadSerializer(serializers.ModelSerializer):
    item_name = serializers.CharField(source="item.name", read_only=True)
    item_internal_code = serializers.CharField(
        source="item.internal_code", read_only=True
    )
    item_attributes = serializers.SerializerMethodField()

    class Meta:
        model = FormulationLine
        fields = (
            "id",
            "item",
            "item_name",
            "item_internal_code",
            "item_attributes",
            "display_order",
            "label_claim_mg",
            "serving_size_override",
            "mg_per_serving_cached",
            "notes",
        )
        read_only_fields = fields

    def get_item_attributes(self, obj: FormulationLine) -> dict[str, object]:
        """Return the attributes the formulation math + label copy need.

        The full ``item.attributes`` JSON blob can be dozens of fields
        wide (nutrition, risk scores, allergens). Here we surface the
        subset the client uses to run its live cascade — math inputs
        (``type``, ``purity``, ``extract_ratio``, ``overage``), label
        copy (``ingredient_list_name``, ``nutrition_information_name``),
        and the four compliance flags — so the response payload stays
        small while still letting the builder render totals,
        compliance chips, and the ingredient declaration without an
        extra round-trip per line.
        """

        attributes = obj.item.attributes or {}
        return {
            "type": attributes.get("type"),
            "purity": attributes.get("purity"),
            "extract_ratio": attributes.get("extract_ratio"),
            "overage": attributes.get("overage"),
            "ingredient_list_name": attributes.get("ingredient_list_name"),
            "nutrition_information_name": attributes.get(
                "nutrition_information_name"
            ),
            "vegan": attributes.get("vegan"),
            "organic": attributes.get("organic"),
            "halal": attributes.get("halal"),
            "kosher": attributes.get("kosher"),
            # Allergen data — drives the builder's live allergen row
            # in the Compliance panel + bolded entries in the live
            # ingredient declaration. Stored as the same ``Yes/No``
            # + free-text strings the spec sheet snapshot uses.
            "allergen": attributes.get("allergen"),
            "allergen_source": attributes.get("allergen_source"),
        }


class FormulationReadSerializer(serializers.ModelSerializer):
    lines = FormulationLineReadSerializer(many=True, read_only=True)

    class Meta:
        model = Formulation
        fields = (
            "id",
            "code",
            "name",
            "description",
            "dosage_form",
            "capsule_size",
            "tablet_size",
            "serving_size",
            "servings_per_pack",
            "directions_of_use",
            "suggested_dosage",
            "appearance",
            "disintegration_spec",
            "project_status",
            "lines",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class FormulationWriteSerializer(serializers.Serializer):
    """Input shape for create + update.

    Every metadata field except lines lives here. Lines are managed
    via a dedicated ``PUT`` endpoint on the nested resource so the
    "save metadata" and "save ingredients" flows stay independent —
    that's how the scientist's spreadsheet workflow splits them too.
    """

    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    name = serializers.CharField(max_length=200)
    description = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    dosage_form = serializers.ChoiceField(
        choices=DosageFormChoices.choices, required=False
    )
    capsule_size = serializers.CharField(
        max_length=32, required=False, allow_blank=True
    )
    tablet_size = serializers.CharField(
        max_length=32, required=False, allow_blank=True
    )
    serving_size = serializers.IntegerField(min_value=1, required=False)
    servings_per_pack = serializers.IntegerField(min_value=1, required=False)
    directions_of_use = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    suggested_dosage = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    appearance = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    disintegration_spec = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    project_status = serializers.ChoiceField(
        choices=ProjectStatus.choices, required=False
    )

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_code(self, value: str) -> str:
        return (value or "").strip()


class FormulationLineWriteSerializer(serializers.Serializer):
    item_id = serializers.UUIDField()
    label_claim_mg = serializers.DecimalField(max_digits=12, decimal_places=4)
    serving_size_override = serializers.IntegerField(
        min_value=1, required=False, allow_null=True
    )
    display_order = serializers.IntegerField(min_value=0, required=False)
    notes = serializers.CharField(required=False, allow_blank=True, default="")


class ReplaceLinesSerializer(serializers.Serializer):
    lines = serializers.ListField(
        child=FormulationLineWriteSerializer(), allow_empty=True
    )


class FormulationVersionReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = FormulationVersion
        fields = (
            "id",
            "version_number",
            "label",
            "snapshot_metadata",
            "snapshot_lines",
            "snapshot_totals",
            "created_at",
        )
        read_only_fields = fields


class SaveVersionSerializer(serializers.Serializer):
    label = serializers.CharField(
        max_length=150, required=False, allow_blank=True, default=""
    )


class RollbackVersionSerializer(serializers.Serializer):
    version_number = serializers.IntegerField(min_value=1)
