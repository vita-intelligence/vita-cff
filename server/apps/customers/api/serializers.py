"""Serializers for the customers API."""

from __future__ import annotations

from rest_framework import serializers

from apps.customers.models import Customer


class CustomerReadSerializer(serializers.ModelSerializer):
    # Portal-account presence flags. Sourced from the annotation
    # added by :func:`apps.customers.services._with_portal_account_annotation`,
    # so every call site that ships a Customer to the FE goes
    # through ``list_customers`` / ``get_customer``. The FE renders
    # a "Portal login" badge from ``has_portal_account`` and gates
    # the delete affordance on the same flag.
    has_portal_account = serializers.BooleanField(
        source="_has_portal_account",
        read_only=True,
        default=False,
    )
    portal_account_activated = serializers.BooleanField(
        source="_portal_account_activated",
        read_only=True,
        default=False,
    )

    class Meta:
        model = Customer
        fields = (
            "id",
            "name",
            "company",
            "email",
            "phone",
            "invoice_address",
            "delivery_address",
            "notes",
            # ``dynamics_id`` exposed (no secret data) so the
            # customer picker can render a "From Dynamics" chip on
            # rows that mirror a Dataverse record. ``None`` for
            # locally-created customers.
            "dynamics_id",
            "dynamics_synced_at",
            "has_portal_account",
            "portal_account_activated",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class CustomerWriteSerializer(serializers.Serializer):
    name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    email = serializers.CharField(required=False, allow_blank=True, default="")
    phone = serializers.CharField(
        max_length=60, required=False, allow_blank=True, default=""
    )
    invoice_address = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    delivery_address = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    notes = serializers.CharField(required=False, allow_blank=True, default="")
