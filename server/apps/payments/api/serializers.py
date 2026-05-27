"""Serializers for the payments API."""

from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from apps.payments.constants import PaymentMethod, PaymentStatus
from apps.payments.models import Payment


class PaymentReadSerializer(serializers.ModelSerializer):
    formulation_code = serializers.CharField(
        source="formulation.code", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation.name", read_only=True
    )
    recorded_by_email = serializers.CharField(
        source="recorded_by.email", read_only=True, default=""
    )
    approved_by_email = serializers.CharField(
        source="approved_by.email", read_only=True, default=""
    )

    class Meta:
        model = Payment
        fields = (
            "id",
            "formulation",
            "formulation_code",
            "formulation_name",
            "label_design",
            "amount",
            "currency",
            "method",
            "external_reference",
            "invoice_number",
            "paid_at",
            "recorded_by",
            "recorded_by_email",
            "approved_by",
            "approved_by_email",
            "approved_at",
            "status",
            "notes",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class PaymentCreateSerializer(serializers.Serializer):
    formulation = serializers.UUIDField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    currency = serializers.CharField(max_length=3, default="GBP")
    method = serializers.ChoiceField(
        choices=PaymentMethod.choices, default=PaymentMethod.BANK_TRANSFER
    )
    external_reference = serializers.CharField(
        max_length=160, allow_blank=True, default=""
    )
    invoice_number = serializers.CharField(
        max_length=64, allow_blank=True, default=""
    )
    paid_at = serializers.DateTimeField()
    notes = serializers.CharField(allow_blank=True, default="")

    def validate_amount(self, value: Decimal) -> Decimal:
        if value <= 0:
            raise serializers.ValidationError("amount must be positive")
        return value


class PaymentVoidSerializer(serializers.Serializer):
    notes = serializers.CharField(allow_blank=True, default="")
