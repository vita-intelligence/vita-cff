"""Serializers for the trial-batches API."""

from __future__ import annotations

from rest_framework import serializers

from apps.trial_batches.models import BatchSizeMode, TrialBatch


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
    #: Terminal-or-in-progress validation status attached to this
    #: batch. Nullable — batches without a validation record return
    #: ``None``. FE uses this to gate the delete button (passed →
    #: delete refused with an audit-trail-integrity 409).
    validation_status = serializers.SerializerMethodField()

    def get_created_by_name(self, obj) -> str:
        user = obj.created_by
        return (user.get_full_name() or user.email or "").strip()

    def get_validation_status(self, obj) -> str | None:
        validation = getattr(obj, "validation", None)
        return validation.status if validation is not None else None

    class Meta:
        model = TrialBatch
        fields = (
            "id",
            "label",
            "batch_size_units",
            "batch_size_mode",
            "notes",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "psp_manufacturing_order_uuid",
            "validation_status",
            "created_by_name",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class TrialBatchCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    batch_size_units = serializers.IntegerField(min_value=1)
    batch_size_mode = serializers.ChoiceField(
        choices=BatchSizeMode.choices, required=False
    )
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
    batch_size_mode = serializers.ChoiceField(
        choices=BatchSizeMode.choices, required=False
    )
    notes = serializers.CharField(required=False, allow_blank=True)
