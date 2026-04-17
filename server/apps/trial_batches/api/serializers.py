"""Serializers for the trial-batches API."""

from __future__ import annotations

from rest_framework import serializers

from apps.trial_batches.models import TrialBatch


class TrialBatchReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name", read_only=True
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number", read_only=True
    )
    created_by_name = serializers.SerializerMethodField()

    def get_created_by_name(self, obj) -> str:
        user = obj.created_by
        return (user.get_full_name() or user.email or "").strip()

    class Meta:
        model = TrialBatch
        fields = (
            "id",
            "label",
            "batch_size_units",
            "notes",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "created_by_name",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class TrialBatchCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    batch_size_units = serializers.IntegerField(min_value=1)
    label = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )


class TrialBatchUpdateSerializer(serializers.Serializer):
    label = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    batch_size_units = serializers.IntegerField(required=False, min_value=1)
    notes = serializers.CharField(required=False, allow_blank=True)
