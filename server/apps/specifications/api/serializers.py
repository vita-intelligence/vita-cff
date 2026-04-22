"""Serializers for the specifications API."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.specifications.models import SpecificationSheet, SpecificationStatus


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


def _packaging_summary(item) -> dict | None:
    """Shape a selected packaging ``Item`` into the compact display
    payload the frontend picker reads — ``None`` when the slot is
    empty. Keeping this alongside the serializer (rather than on the
    model) keeps the model free of DRF-shaped render logic."""

    if item is None:
        return None
    return {
        "id": str(item.id),
        "name": item.name,
        "internal_code": item.internal_code,
    }


class SpecificationSheetReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name", read_only=True
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number", read_only=True
    )
    # Nested display metadata for the currently-selected packaging
    # items. Ships the code + name alongside the raw FK UUID so the
    # picker can render the preselected label without a second
    # round-trip, even when the item is outside the search page the
    # ComboBox most recently loaded.
    packaging_details = serializers.SerializerMethodField()

    def get_packaging_details(self, obj) -> dict:
        return {
            "lid": _packaging_summary(obj.packaging_lid),
            "container": _packaging_summary(obj.packaging_container),
            "label": _packaging_summary(obj.packaging_label),
            "antitemper": _packaging_summary(obj.packaging_antitemper),
        }

    class Meta:
        model = SpecificationSheet
        fields = (
            "id",
            "code",
            "client_name",
            "client_email",
            "client_company",
            "margin_percent",
            "final_price",
            "cover_notes",
            "total_weight_label",
            "unit_quantity",
            "food_contact_status",
            "shelf_life",
            "storage_conditions",
            "weight_uniformity",
            "public_token",
            "packaging_lid",
            "packaging_container",
            "packaging_label",
            "packaging_antitemper",
            "packaging_details",
            "status",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class SpecificationSheetCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )
    client_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    client_email = serializers.EmailField(
        required=False, allow_blank=True, default=""
    )
    client_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    final_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    cover_notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    total_weight_label = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )


class SpecificationSheetUpdateSerializer(serializers.Serializer):
    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    client_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    client_email = serializers.EmailField(required=False, allow_blank=True)
    client_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    final_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    cover_notes = serializers.CharField(required=False, allow_blank=True)
    total_weight_label = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    unit_quantity = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    food_contact_status = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    shelf_life = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    storage_conditions = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    weight_uniformity = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    # Per-sheet ``{slug: value}`` override for the microbial / heavy
    # metal block. Free-form strings — the UI surfaces a form so the
    # admin does not have to memorise slug names; this field just
    # enforces shape.
    limits_override = serializers.DictField(
        child=serializers.CharField(
            max_length=120, allow_blank=True, trim_whitespace=False
        ),
        required=False,
    )


class SpecificationStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=SpecificationStatus.choices)
    notes = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=2000
    )


class SpecificationPackagingSerializer(serializers.Serializer):
    """Payload for partial updates of the four packaging FK slots.

    Every field is optional — the caller can update one slot and leave
    the others untouched. Passing ``null`` clears the slot. The UUIDs
    are validated downstream in the service against the org packaging
    catalogue + ``packaging_type`` attribute, so this serializer only
    enforces shape.
    """

    packaging_lid = serializers.UUIDField(required=False, allow_null=True)
    packaging_container = serializers.UUIDField(
        required=False, allow_null=True
    )
    packaging_label = serializers.UUIDField(required=False, allow_null=True)
    packaging_antitemper = serializers.UUIDField(
        required=False, allow_null=True
    )
