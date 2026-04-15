"""Serializers for the attributes API."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.attributes.models import AttributeDefinition, DataType


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class AttributeDefinitionReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = AttributeDefinition
        fields = (
            "id",
            "key",
            "label",
            "data_type",
            "required",
            "options",
            "display_order",
            "is_archived",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class AttributeDefinitionCreateSerializer(serializers.Serializer):
    """Input shape for ``POST /api/.../catalogues/<slug>/attributes/``.

    ``key`` and ``data_type`` are only accepted here — they are
    immutable on update because changing either would silently orphan
    stored values on every item row in the catalogue.
    """

    key = serializers.CharField(max_length=64)
    label = serializers.CharField(max_length=150)
    data_type = serializers.ChoiceField(choices=DataType.choices)
    required = serializers.BooleanField(required=False, default=False)
    options = serializers.ListField(
        child=serializers.DictField(),
        required=False,
        default=list,
    )
    display_order = serializers.IntegerField(required=False, default=0)

    def validate_label(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_key(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class AttributeDefinitionUpdateSerializer(serializers.Serializer):
    """Input shape for ``PATCH /api/.../attributes/<id>/``.

    Only mutable fields are accepted. See :func:`apps.attributes.services.
    update_definition` for the rationale behind the key / data_type
    exclusion.
    """

    label = serializers.CharField(max_length=150, required=False)
    required = serializers.BooleanField(required=False)
    options = serializers.ListField(
        child=serializers.DictField(),
        required=False,
    )
    display_order = serializers.IntegerField(required=False)
    is_archived = serializers.BooleanField(required=False)

    def validate_label(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed
