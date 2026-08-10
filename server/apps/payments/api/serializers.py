"""Serializers for the payments API."""

from __future__ import annotations

from decimal import Decimal

from rest_framework import serializers

from apps.payments.constants import PaymentKind, PaymentMethod, PaymentStatus
from apps.payments.models import Payment, PaymentFile


class PaymentFileReadSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    uploaded_by_email = serializers.CharField(
        source="uploaded_by.email", read_only=True, default=""
    )

    class Meta:
        model = PaymentFile
        fields = (
            "id",
            "url",
            "filename",
            "mime",
            "byte_size",
            "uploaded_by_email",
            "uploaded_at",
        )
        read_only_fields = fields

    def get_url(self, obj: PaymentFile) -> str | None:
        return obj.file.url if obj.file else None


class PaymentReadSerializer(serializers.ModelSerializer):
    #: For FINAL payments the CO has a formulation link; for DEPOSIT
    #: payments both are null (the deposit sits at proposal level).
    formulation_code = serializers.CharField(
        source="formulation.code", read_only=True, default=""
    )
    formulation_name = serializers.CharField(
        source="formulation.name", read_only=True, default=""
    )
    #: Populated on DEPOSIT payments only — walks up to the accepted
    #: proposal so the finance list can render "PROP-0009 · 50%
    #: deposit" alongside the amount.
    proposal_code = serializers.CharField(
        source="proposal.code", read_only=True, default=""
    )
    proposal_deposit_percent = serializers.DecimalField(
        source="proposal.deposit_percent",
        max_digits=5,
        decimal_places=2,
        read_only=True,
        default=None,
    )
    #: Denormalized customer identity. ``customer`` is the FK id;
    #: the three ``customer_*`` mirrors let the finance queue render
    #: "who ordered this" without walking the join client-side.
    customer_company = serializers.CharField(
        source="customer.company", read_only=True, default=""
    )
    customer_name = serializers.CharField(
        source="customer.name", read_only=True, default=""
    )
    customer_email = serializers.CharField(
        source="customer.email", read_only=True, default=""
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
    invoices = PaymentFileReadSerializer(many=True, read_only=True)

    class Meta:
        model = Payment
        fields = (
            "id",
            "kind",
            "formulation",
            "formulation_code",
            "formulation_name",
            "proposal",
            "proposal_code",
            "proposal_deposit_percent",
            "customer",
            "customer_company",
            "customer_name",
            "customer_email",
            "label_design",
            "amount",
            "currency",
            "method",
            "external_reference",
            "invoice_number",
            "invoices",
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
    #: ``FINAL`` requires ``formulation``; ``DEPOSIT`` requires
    #: ``proposal``. The service layer raises ``PaymentKindConflict``
    #: if the wrong target is supplied for the kind.
    kind = serializers.ChoiceField(
        choices=PaymentKind.choices, default=PaymentKind.FINAL
    )
    formulation = serializers.UUIDField(required=False, allow_null=True)
    proposal = serializers.UUIDField(required=False, allow_null=True)
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

    def validate(self, data: dict) -> dict:
        kind = data.get("kind", PaymentKind.FINAL)
        if kind == PaymentKind.DEPOSIT and not data.get("proposal"):
            raise serializers.ValidationError(
                {"proposal": "Required for deposit payments."}
            )
        if kind == PaymentKind.FINAL and not data.get("formulation"):
            raise serializers.ValidationError(
                {"formulation": "Required for final payments."}
            )
        return data


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
