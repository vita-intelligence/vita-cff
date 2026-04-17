"""Serializers for the specifications API."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.specifications.models import SpecificationSheet, SpecificationStatus


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


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
            "public_token",
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


class SpecificationStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=SpecificationStatus.choices)
    notes = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=2000
    )
