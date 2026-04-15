"""Serializers for the catalogues API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.attributes.services import validate_values
from apps.catalogues.models import Catalogue, Item


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


# ---------------------------------------------------------------------------
# Catalogue metadata
# ---------------------------------------------------------------------------


class CatalogueReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = Catalogue
        fields = (
            "id",
            "slug",
            "name",
            "description",
            "is_system",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class CatalogueCreateSerializer(serializers.Serializer):
    slug = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=150)
    description = serializers.CharField(
        max_length=2000, required=False, allow_blank=True, default=""
    )

    def validate_slug(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class CatalogueUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, required=False)
    description = serializers.CharField(
        max_length=2000, required=False, allow_blank=True
    )

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------


class ItemReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = Item
        fields = (
            "id",
            "name",
            "internal_code",
            "unit",
            "base_price",
            "is_archived",
            "attributes",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class ItemWriteSerializer(serializers.ModelSerializer):
    """Input shape for both item create and update.

    ``catalogue`` is never accepted from the body — it comes from the
    URL. ``created_by`` / ``updated_by`` are set by the view based on
    the authenticated caller, never trusted from input.
    """

    attributes = serializers.DictField(
        child=serializers.JSONField(),
        required=False,
    )

    class Meta:
        model = Item
        fields = (
            "name",
            "internal_code",
            "unit",
            "base_price",
            "is_archived",
            "attributes",
        )
        extra_kwargs = {
            "name": {"required": True, "allow_blank": False},
            "internal_code": {"required": False, "allow_blank": True},
            "unit": {"required": False, "allow_blank": True},
            "base_price": {"required": False, "allow_null": True},
            "is_archived": {"required": False},
        }

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        if len(trimmed) > 200:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate_internal_code(self, value: str) -> str:
        trimmed = (value or "").strip()
        if len(trimmed) > 64:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate_unit(self, value: str) -> str:
        trimmed = (value or "").strip()
        if len(trimmed) > 32:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if "attributes" not in attrs:
            return attrs

        catalogue = self.context.get("catalogue")
        if catalogue is None:
            raise serializers.ValidationError(
                {"attributes": [_code("invalid")]}
            )

        incoming = dict(attrs["attributes"] or {})
        instance = getattr(self, "instance", None)
        if self.partial and instance is not None:
            merged = dict(instance.attributes or {})
            merged.update(incoming)
            incoming = merged

        coerced, errors = validate_values(
            catalogue=catalogue,
            incoming=incoming,
        )
        if errors:
            codified = {
                key: [_code(c) for c in codes]
                for key, codes in errors.items()
            }
            raise serializers.ValidationError({"attributes": codified})

        attrs["attributes"] = coerced
        return attrs
