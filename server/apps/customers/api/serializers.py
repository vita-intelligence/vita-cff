"""Serializers for the customers API."""

from __future__ import annotations

from rest_framework import serializers

from apps.customers.models import Customer


class CustomerReadSerializer(serializers.ModelSerializer):
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
