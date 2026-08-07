"""Portal customer-order endpoints.

Two views:

* ``POST /api/portal/orders/`` — customer submits an order or paid
  sample request from the marketing site's RTG detail page.
* ``GET  /api/portal/orders/`` — customer sees their own orders
  (used by the portal orders list page).

Both are auth-gated: the customer must be signed in via the portal
JWT cookie. Ownership is enforced server-side against the
``ClientAccount.customer`` FK — nobody can order or list on behalf
of another customer.
"""

from __future__ import annotations

from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.formulations.models import CustomerOrder
from apps.formulations.order_services import (
    CustomerOrderError,
    CustomerOrderInput,
    create_customer_order,
)


class _CustomerOrderCreatePayload(serializers.Serializer):
    """Wire shape for a portal order submission. Strict — every
    field is validated before the service ever runs."""

    formulation_id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=("order", "sample"))
    quantity = serializers.IntegerField(min_value=1, required=False, default=1)
    packaging_combo_id = serializers.UUIDField(
        required=False, allow_null=True, default=None,
    )
    delivery_address = serializers.CharField(
        allow_blank=True, required=False, default="",
    )
    notes = serializers.CharField(
        allow_blank=True, required=False, default="",
    )


def _serialize_order(order: CustomerOrder) -> dict:
    """Wire shape for a customer-visible order row. Keep it lean —
    the portal orders list doesn't need staff-only metadata."""

    return {
        "id": str(order.id),
        "kind": order.kind,
        "status": order.status,
        "quantity": order.quantity,
        "unit_price": str(order.unit_price),
        "currency_code": order.currency_code,
        "delivery_address": order.delivery_address,
        "notes": order.notes,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "formulation": {
            "id": str(order.formulation_id),
            "name": (
                (order.formulation.rtg_display_name or "").strip()
                or order.formulation.name
            ),
            "slug": order.formulation.rtg_slug,
        },
    }


class PortalOrderListCreateView(PortalAPIView):
    """``GET / POST /api/portal/orders/``.

    * ``GET`` returns the signed-in customer's own orders, newest
      first. No pagination yet — a typical customer won't have more
      than a page or two, and we can add cursor pagination later
      without a wire-shape break.
    * ``POST`` creates a new order or sample request. Returns the
      minimal order payload on 201.
    """

    def get(self, request: Request) -> Response:
        customer = request.user.customer
        rows = list(
            CustomerOrder.objects
            .filter(customer=customer)
            .select_related("formulation")
            .order_by("-created_at")[:200]
        )
        return Response(
            {"results": [_serialize_order(row) for row in rows]},
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request) -> Response:
        serializer = _CustomerOrderCreatePayload(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        payload = CustomerOrderInput(
            formulation_id=str(data["formulation_id"]),
            kind=str(data["kind"]),
            quantity=int(data.get("quantity") or 1),
            packaging_combo_id=(
                str(data["packaging_combo_id"])
                if data.get("packaging_combo_id")
                else None
            ),
            delivery_address=str(data.get("delivery_address") or ""),
            notes=str(data.get("notes") or ""),
        )
        try:
            order = create_customer_order(
                client_account=request.user,
                payload=payload,
            )
        except CustomerOrderError as exc:
            return Response(
                {
                    "detail": exc.code,
                    "messages": [str(exc)],
                    "field_errors": getattr(exc, "field_errors", None) or {},
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {"order": _serialize_order(order)},
            status=status.HTTP_201_CREATED,
        )
