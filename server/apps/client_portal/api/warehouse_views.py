"""Portal warehouse-visibility endpoints.

Phase 1 of the 3PL portal integration. The customer sees the
finished-goods stock we're holding in bailee custody on their
behalf, the storage-cost meter ticking against it, and each lot's
current location + qty.

The heavy lifting is on PSP — the ``Backend.ThreePL`` context owns
the bailee data model, storage-rate config, and the accrued-charge
math. This view resolves the caller's :class:`~apps.customers.models.Customer`
id union, picks a canonical customer uuid, then proxies to PSP's
``/api/integration/customer-bailee-inventory/:uuid`` endpoint via
:func:`apps.psp.services.get_psp_customer_bailee_inventory`.

Silent-degrade posture — mirrors the rest of the portal:

* PSP integration off / config decryption failed → return an empty
  envelope so the FE renders the empty-state ("nothing held")
  instead of an error banner.
* PSP unreachable / 5xx → same treatment.
* PSP returns 404 for the customer uuid (unknown to PSP) → empty
  envelope.

Any customer whose PSP-side row exists but has zero held lots also
gets the empty envelope — the FE reads "no held stock" and
"customer isn't known to PSP" the same way (nothing to show).
"""

from __future__ import annotations

from typing import Any

from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import customer_ids_for_account
from apps.customers.models import Customer


class PortalWarehouseStockView(PortalAPIView):
    """``GET /api/portal/warehouse/stock/`` — bailee inventory
    snapshot for the caller's customer.

    Wire shape mirrors PSP's response (see the Elixir controller's
    docstring) so the FE can render whatever PSP sends without a
    normalisation pass. Empty envelope on any degrade path:

        {
          "customer": {"uuid": null, "name": null},
          "currency": "GBP",
          "rate_per_m3_per_day": null,
          "summary": {"lot_count": 0, "total_qty_on_hand": "0",
                      "total_held_volume_m3": "0",
                      "total_accrued_charge": "0"},
          "lots": []
        }
    """

    def get(self, request: Request) -> Response:
        from apps.psp.services import get_psp_customer_bailee_inventory

        empty = _empty_envelope()
        customer_ids = customer_ids_for_account(request.user)
        if not customer_ids:
            return Response(empty)

        # Pick the canonical Customer for the PSP lookup. In practice
        # every id in the union belongs to the same organization + the
        # same person — PSP dedupes on ``npd_source_uuid`` so any one
        # of them lands on the same PSP customer row. Prefer the
        # account's own ``customer_id`` (the row the login is FK'd to)
        # over aggregated dupes so the ``customer.name`` echoed back
        # is the one the caller expects to see.
        canonical_id = getattr(request.user, "customer_id", None) or customer_ids[0]
        customer = (
            Customer.objects
            .filter(pk=canonical_id)
            .only("id", "organization_id")
            .first()
        )
        if customer is None:
            return Response(empty)

        organization = getattr(customer, "organization", None) or _org_from_id(
            customer.organization_id
        )
        if organization is None:
            return Response(empty)

        # ``Customer.id`` IS the UUID (Django uuid-typed PK, no separate
        # ``uuid`` field), so this is the identity PSP knows the customer
        # by via the ``resolve_customer`` helper on the CO sync path.
        snapshot = get_psp_customer_bailee_inventory(
            organization=organization, customer_uuid=str(customer.id)
        )
        if not isinstance(snapshot, dict):
            return Response(empty)

        # Guard against a malformed payload — the FE expects the
        # summary + lots keys unconditionally so an empty envelope
        # with the missing pieces filled in is safer than trusting
        # PSP to send a complete shape.
        return Response(_normalise(snapshot))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _empty_envelope() -> dict[str, Any]:
    return {
        "customer": {"uuid": None, "name": None},
        "currency": "GBP",
        "rate_per_m3_per_day": None,
        "summary": {
            "lot_count": 0,
            "total_qty_on_hand": "0",
            "total_held_volume_m3": "0",
            "total_accrued_charge": "0",
        },
        "lots": [],
    }


def _normalise(snapshot: dict[str, Any]) -> dict[str, Any]:
    envelope = _empty_envelope()
    customer = snapshot.get("customer")
    if isinstance(customer, dict):
        envelope["customer"] = {
            "uuid": customer.get("uuid"),
            "name": customer.get("name"),
        }
    if isinstance(snapshot.get("currency"), str):
        envelope["currency"] = snapshot["currency"]
    if snapshot.get("rate_per_m3_per_day") is not None:
        envelope["rate_per_m3_per_day"] = snapshot["rate_per_m3_per_day"]
    summary = snapshot.get("summary")
    if isinstance(summary, dict):
        envelope["summary"] = {
            "lot_count": summary.get("lot_count", 0) or 0,
            "total_qty_on_hand": summary.get("total_qty_on_hand", "0"),
            "total_held_volume_m3": summary.get("total_held_volume_m3", "0"),
            "total_accrued_charge": summary.get("total_accrued_charge", "0"),
        }
    lots = snapshot.get("lots")
    if isinstance(lots, list):
        envelope["lots"] = lots
    return envelope


def _org_from_id(organization_id: Any) -> Any | None:
    if organization_id is None:
        return None
    from apps.organizations.models import Organization

    return Organization.objects.filter(pk=organization_id).first()
