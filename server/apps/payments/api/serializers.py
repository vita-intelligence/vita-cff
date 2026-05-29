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
    assigned_finance_officer_email = serializers.CharField(
        source="assigned_finance_officer.email", read_only=True, default=""
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
            "assigned_finance_officer",
            "assigned_finance_officer_email",
            "status",
            "notes",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class AssignPaymentFinanceOfficerSerializer(serializers.Serializer):
    finance_officer_id = serializers.UUIDField(required=False, allow_null=True)


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


class PaymentEditSerializer(serializers.Serializer):
    """Editable subset of a Payment row. Every field is optional so
    a PATCH can land just one column at a time. ``amount`` and
    ``paid_at`` are included because finance frequently mis-keys
    those at record time and needs to correct them before the
    approval gate; status / approved_at / approved_by / recorded_by
    are intentionally absent — those flip via the dedicated
    approve / void actions.
    """

    amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False
    )
    currency = serializers.CharField(max_length=3, required=False)
    method = serializers.ChoiceField(
        choices=PaymentMethod.choices, required=False
    )
    external_reference = serializers.CharField(
        max_length=160, allow_blank=True, required=False
    )
    invoice_number = serializers.CharField(
        max_length=64, allow_blank=True, required=False
    )
    paid_at = serializers.DateTimeField(required=False)
    notes = serializers.CharField(allow_blank=True, required=False)

    def validate_amount(self, value: Decimal) -> Decimal:
        if value <= 0:
            raise serializers.ValidationError("amount must be positive")
        return value
