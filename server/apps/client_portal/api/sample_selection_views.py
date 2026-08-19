"""Portal endpoints for the customer-facing sample-selection step.

Sits between "proposal signed" and "deposit paid" in the pipeline
(see ``_build_pipeline`` in :mod:`.product_detail_views`). Two
operations:

* ``GET /api/portal/projects/<formulation_id>/sample-selection/`` —
  returns the org's :class:`SamplePricingConfig` (free allowance +
  per-extra price + discount tiers) plus the current
  :class:`SampleAllocation` (may be a fresh zero-quantity draft
  row created on first fetch). Everything the FE needs to render
  the picker in one round-trip.

* ``POST /api/portal/projects/<formulation_id>/sample-selection/
  confirm/`` — locks the customer's chosen ``quantity_ordered``
  and snapshots the price breakdown onto the allocation. FSM is
  one-way; re-confirming an already-confirmed row returns 409.

Ownership resolution matches the rest of the portal — the caller
must own the formulation via
:func:`apps.client_portal.queries.customer_owns_formulation`
(direct FK OR any proposal / proposal-line path). Bad ids collapse
to 404 without leaking whether the row exists on another tenant.

Reads the payload shape from the payments service layer directly
so the FE + finance side + this portal endpoint all render the
same numbers.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import (
    customer_ids_for_account,
    customer_owns_formulation,
)
from apps.formulations.models import Formulation
from apps.payments.models import (
    SampleAllocation,
    SampleAllocationStatus,
    SamplePricingConfig,
)
from apps.payments.services import (
    SampleAllocationLocked,
    compute_sample_extras_cost,
    confirm_sample_allocation,
    get_or_create_sample_allocation,
    get_or_create_sample_pricing_config,
)


def _serialise_config(config: SamplePricingConfig) -> dict[str, Any]:
    """Portal-side shape of the pricing config — a subset of the
    settings-page payload (no ``updated_at`` / no audit fields, no
    ``id`` on tiers because the customer never edits individual
    rows)."""

    return {
        "free_samples_included": config.free_samples_included,
        "price_per_extra_sample": str(config.price_per_extra_sample),
        "currency_code": (config.currency_code or "GBP").upper(),
        "discount_tiers": [
            {
                "quantity_threshold": t.quantity_threshold,
                "discount_percent": str(t.discount_percent),
            }
            for t in config.discount_tiers.order_by(
                "sort_order", "quantity_threshold"
            )
        ],
    }


def _serialise_allocation(allocation: SampleAllocation) -> dict[str, Any]:
    """Portal-side shape of the customer's saved / confirmed pick."""

    return {
        "status": allocation.status,
        "quantity_ordered": allocation.quantity_ordered,
        "free_samples_included_snapshot": allocation.free_samples_included_snapshot,
        "extras_count": allocation.extras_count,
        "unit_price": str(allocation.unit_price),
        "subtotal": str(allocation.subtotal),
        "discount_percent": str(allocation.discount_percent),
        "discount_amount": str(allocation.discount_amount),
        "total_extras_cost": str(allocation.total_extras_cost),
        "currency_code": allocation.currency_code,
        "tier_threshold": allocation.tier_threshold,
        "confirmed_at": (
            allocation.confirmed_at.isoformat()
            if allocation.confirmed_at is not None
            else None
        ),
    }


class PortalSampleSelectionView(PortalAPIView):
    """``GET /api/portal/projects/<formulation_id>/sample-selection/``.

    Returns the pricing config the picker renders against + the
    current allocation. Lazily materialises both on first hit so the
    FE never has to distinguish "config missing" from "no allocation
    yet" — the shape is always populated.
    """

    def get(self, request: Request, formulation_id) -> Response:
        owner_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=owner_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = Formulation.objects.filter(id=formulation_id).first()
        if formulation is None:
            raise NotFound()

        config = get_or_create_sample_pricing_config(formulation.organization)
        allocation = get_or_create_sample_allocation(formulation=formulation)

        # Compute what the customer would owe RIGHT NOW at the last-
        # seen quantity — for a fresh row that's the free-allowance
        # baseline (£0). Lets the FE render the "you'd pay X" preview
        # without duplicating the tier math on the client.
        preview = compute_sample_extras_cost(
            config=config,
            ordered_quantity=allocation.quantity_ordered
            or config.free_samples_included,
        )

        return Response(
            {
                "pricing": _serialise_config(config),
                "allocation": _serialise_allocation(allocation),
                "preview_at_current_quantity": preview,
            }
        )


class PortalSampleSelectionConfirmView(PortalAPIView):
    """``POST /api/portal/projects/<formulation_id>/sample-selection/
    confirm/`` — lock the customer's chosen quantity.

    Body: ``{ "quantity_ordered": int }``. Refuses re-confirmation
    with 409; refuses a quantity below the free allowance with 400
    (the picker should not allow it, but defence-in-depth).
    """

    def post(self, request: Request, formulation_id) -> Response:
        owner_ids = customer_ids_for_account(request.user)
        if not customer_owns_formulation(
            customer_ids=owner_ids, formulation_id=formulation_id,
        ):
            raise NotFound()

        formulation = Formulation.objects.filter(id=formulation_id).first()
        if formulation is None:
            raise NotFound()

        raw = request.data if isinstance(request.data, dict) else {}
        try:
            quantity = int(raw.get("quantity_ordered") or 0)
        except (TypeError, ValueError):
            return Response(
                {
                    "code": "invalid_quantity",
                    "detail": "quantity_ordered must be a positive integer",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if quantity <= 0:
            return Response(
                {
                    "code": "invalid_quantity",
                    "detail": "quantity_ordered must be a positive integer",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Guard against below-free-allowance picks — makes the intent
        # explicit and prevents accidental "0 samples" confirmations.
        config = get_or_create_sample_pricing_config(formulation.organization)
        if quantity < config.free_samples_included:
            return Response(
                {
                    "code": "below_free_allowance",
                    "detail": (
                        "quantity_ordered cannot be less than the free "
                        "allowance included with the deposit."
                    ),
                    "free_samples_included": config.free_samples_included,
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            allocation = confirm_sample_allocation(
                formulation=formulation,
                actor=request.user,
                quantity_ordered=quantity,
            )
        except SampleAllocationLocked:
            return Response(
                {
                    "code": "allocation_locked",
                    "detail": (
                        "This sample allocation has already been "
                        "confirmed and can't be changed here. Ping us "
                        "in the project chat if you need to adjust."
                    ),
                },
                status=status.HTTP_409_CONFLICT,
            )

        return Response(
            {
                "pricing": _serialise_config(config),
                "allocation": _serialise_allocation(allocation),
            }
        )
