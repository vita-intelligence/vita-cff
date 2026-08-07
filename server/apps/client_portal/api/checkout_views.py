"""Portal cart checkout endpoint.

``POST /api/portal/checkout/`` accepts the cart lines + customer-
detail overrides captured in the storefront's checkout modal.
Product lines merge into one draft :class:`Proposal`; sample lines
each drop a PENDING :class:`Payment` in the finance queue.

Success payload:

.. code-block:: json

   {
     "proposal_id": "…" | null,   // null when checkout was samples-only
     "payment_ids": ["…", "…"]     // one id per sample line
   }

Errors surface as ``{"detail": "<code>", "message": "<human>"}``
so the FE can either map the code (rare) or fall back to the
human message (default).
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.checkout_services import (
    CheckoutError,
    CheckoutInput,
    CheckoutLineInput,
    place_portal_checkout,
)


class _LineSerializer(serializers.Serializer):
    """Mirror of :class:`CheckoutLineInput`.

    ``unit_price`` comes in as a string on purpose — the storefront
    snapshots the number at add-time and JSON-serialises via
    ``String(price)`` so integer / decimal ambiguity never bites.
    """

    kind = serializers.ChoiceField(choices=[("product", "product"), ("sample", "sample")])
    formulation_id = serializers.CharField(max_length=64)
    quantity = serializers.IntegerField(min_value=1)
    unit_price = serializers.CharField(max_length=32)
    currency_code = serializers.CharField(max_length=3, allow_blank=True, default="GBP")
    packaging_combo_id = serializers.CharField(
        max_length=64, allow_null=True, allow_blank=True, default=None,
    )

    def validate_unit_price(self, value: str) -> Decimal:
        try:
            return Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise serializers.ValidationError("Invalid unit price.") from exc


class _CheckoutSerializer(serializers.Serializer):
    """Mirror of :class:`CheckoutInput`."""

    lines = _LineSerializer(many=True)
    name = serializers.CharField(max_length=200, allow_blank=True, default="")
    company = serializers.CharField(max_length=200, allow_blank=True, default="")
    phone = serializers.CharField(max_length=60, allow_blank=True, default="")
    invoice_address = serializers.CharField(allow_blank=True, default="")
    delivery_address = serializers.CharField(allow_blank=True, default="")

    def validate_lines(self, lines):
        if not lines:
            raise serializers.ValidationError("At least one line is required.")
        return lines


class PortalCheckoutView(PortalAPIView):
    """POST /api/portal/checkout/ — drain the cart into NPD."""

    def post(self, request: Request) -> Response:
        serializer = _CheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        payload = CheckoutInput(
            lines=[
                CheckoutLineInput(
                    kind=line["kind"],
                    formulation_id=str(line["formulation_id"]),
                    quantity=int(line["quantity"]),
                    unit_price=line["unit_price"],
                    currency_code=str(line.get("currency_code") or "GBP"),
                    packaging_combo_id=(
                        str(line.get("packaging_combo_id"))
                        if line.get("packaging_combo_id")
                        else None
                    ),
                )
                for line in data["lines"]
            ],
            name=data.get("name", ""),
            company=data.get("company", ""),
            phone=data.get("phone", ""),
            invoice_address=data.get("invoice_address", ""),
            delivery_address=data.get("delivery_address", ""),
        )

        try:
            result = place_portal_checkout(account=request.user, payload=payload)
        except CheckoutError as exc:
            return Response(
                {"detail": exc.code, "message": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "proposal_id": result.proposal_id,
                "payment_ids": result.payment_ids,
            },
            status=status.HTTP_201_CREATED,
        )
