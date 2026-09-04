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

from rest_framework import status as http_status
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
            .only("id", "organization_id", "name", "delivery_address")
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
        # Guard against a malformed payload — the FE expects the
        # summary + lots keys unconditionally so an empty envelope
        # with the missing pieces filled in is safer than trusting
        # PSP to send a complete shape.
        envelope = _normalise(snapshot) if isinstance(snapshot, dict) else empty
        # Stamp the customer's default ship-to snapshot so the
        # portal ``Request dispatch`` dialog can prefill without a
        # second round-trip. Free-text ``delivery_address`` from
        # the Customer record covers most cases; the FE lets the
        # customer amend before submit.
        envelope["default_ship_to"] = {
            "name": (customer.name or "").strip() or None,
            "address": (customer.delivery_address or "").strip() or None,
            "country": None,
        }
        return Response(envelope)


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
        "default_ship_to": {"name": None, "address": None, "country": None},
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


# ---------------------------------------------------------------------------
# Phase 2 — customer-triggered dispatch requests
# ---------------------------------------------------------------------------


# PSP `detail` code → customer-facing message. Everything falls back to
# the generic "psp_error" bucket when we can't map. Keys mirror
# ``apps.psp.services._KNOWN_DISPATCH_ERROR_CODES``.
_DISPATCH_ERROR_COPY: dict[str, str] = {
    "lot_not_found": "That lot isn't held for you any more — refresh the page.",
    "bad_qty": "Enter a positive quantity.",
    "no_bailee_placement": "That lot has no stock on our shelves right now.",
    "insufficient_qty": "That's more than we currently have on our shelves for this lot (net of any pending requests).",
    "missing_key": "Missing required field — refresh and try again.",
    "validation_error": "Couldn't queue that request — please check the values and try again.",
    "psp_unavailable": "Our warehouse system is temporarily unreachable. Please try again in a moment.",
    "psp_error": "Couldn't queue that dispatch request. Please try again or ping us in the project chat.",
}


class PortalWarehouseDispatchRequestView(PortalAPIView):
    """``POST /api/portal/warehouse/dispatch-requests/`` — customer
    clicks "Request dispatch" on their /portal/warehouse page.

    ``GET`` on the same URL returns the caller's dispatch-request
    history (any status). See :meth:`get` for the response shape and
    query params.

    Body:

        {
          "lot_uuid": "…",
          "qty": "150",
          "notes": "…" (optional),
          "reference": "…" (optional — the customer's own reference)
        }

    Ownership + qty validation happen on PSP (which we trust as the
    authoritative source for who owns which bailee lot). This view
    only:

    1. Resolves the caller's canonical Customer id via
       :func:`customer_ids_for_account` — no logged-in account, no
       dispatch (401 by the PortalAPIView permission chain).
    2. Passes the customer's uuid + the body through to PSP as-is.
       Phase 2 hard-codes ``source="portal"``; Phase 3 will let the
       webhook layer override.

    On success we return 201 + PSP's dispatch snapshot (uuid, status,
    qty, requested_at). On validation failure the response body
    carries ``{"detail": "<psp_code>", "message": "<customer copy>"}``
    so the FE can inline the error next to the qty input.
    """

    def get(self, request: Request) -> Response:
        return _list_dispatch_requests(request)

    def post(self, request: Request) -> Response:
        from apps.psp.services import create_psp_customer_fulfilment_request

        lot_uuid = (request.data.get("lot_uuid") or "").strip()
        qty_raw = request.data.get("qty")
        notes = _strip_or_none(request.data.get("notes"))
        reference = _strip_or_none(request.data.get("reference"))
        # Customer's ship-to snapshot from the portal dialog. All
        # three are optional — a customer can leave them blank and
        # the CO / customer defaults on PSP take over. When set,
        # they land on the outbound Shipment as its initial
        # recipient / address / country.
        ship_to_name = _strip_or_none(request.data.get("ship_to_name"))
        ship_to_address = _strip_or_none(request.data.get("ship_to_address"))
        ship_to_country_raw = _strip_or_none(request.data.get("ship_to_country"))
        ship_to_country = (
            ship_to_country_raw.upper() if isinstance(ship_to_country_raw, str) else None
        )

        if not lot_uuid:
            return _dispatch_error("missing_key", http_status.HTTP_400_BAD_REQUEST)
        if qty_raw in (None, ""):
            return _dispatch_error("bad_qty", http_status.HTTP_400_BAD_REQUEST)

        customer_ids = customer_ids_for_account(request.user)
        if not customer_ids:
            return _dispatch_error("psp_error", http_status.HTTP_400_BAD_REQUEST)

        canonical_id = getattr(request.user, "customer_id", None) or customer_ids[0]
        customer = (
            Customer.objects
            .filter(pk=canonical_id)
            .only("id", "organization_id")
            .first()
        )
        if customer is None:
            return _dispatch_error("psp_error", http_status.HTTP_400_BAD_REQUEST)

        organization = getattr(customer, "organization", None) or _org_from_id(
            customer.organization_id
        )
        if organization is None:
            return _dispatch_error("psp_unavailable", http_status.HTTP_503_SERVICE_UNAVAILABLE)

        payload, err = create_psp_customer_fulfilment_request(
            organization=organization,
            customer_uuid=str(customer.id),
            lot_uuid=lot_uuid,
            qty=qty_raw,
            reference=reference,
            notes=notes,
            source="portal",
            ship_to_name=ship_to_name,
            ship_to_address=ship_to_address,
            ship_to_country=ship_to_country,
        )
        if err is not None:
            # Preserve PSP's HTTP semantics: transport / config errors
            # land as 503; anything else is a validation error the
            # customer can act on.
            code = (
                http_status.HTTP_503_SERVICE_UNAVAILABLE
                if err == "psp_unavailable"
                else http_status.HTTP_400_BAD_REQUEST
            )
            return _dispatch_error(err, code)

        return Response(payload, status=http_status.HTTP_201_CREATED)


def _list_dispatch_requests(request: Request) -> Response:
    """GET side of ``dispatch-requests/`` — history of the caller's
    dispatch requests, any status. Called by
    :meth:`PortalWarehouseDispatchRequestView.get`.

    Query params (all optional):
      * ``status`` — ``pending`` / ``completed`` / ``cancelled``.
      * ``lot_uuid`` — narrow to a single lot.
      * ``limit`` — cap the row count (PSP caps at 500).

    Silent-degrade posture: PSP off / decrypt failure / unreachable
    all collapse to the empty envelope so the portal renders "no
    dispatch requests yet" instead of an error banner.
    """
    from apps.psp.services import list_psp_customer_dispatch_requests

    empty = _empty_dispatch_request_envelope()
    customer_ids = customer_ids_for_account(request.user)
    if not customer_ids:
        return Response(empty)

    canonical_id = (
        getattr(request.user, "customer_id", None) or customer_ids[0]
    )
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

    status_param = _strip_or_none(request.query_params.get("status"))
    lot_uuid_param = _strip_or_none(request.query_params.get("lot_uuid"))
    limit_param_raw = request.query_params.get("limit")
    limit_param: int | None = None
    if limit_param_raw:
        try:
            limit_param = max(1, int(limit_param_raw))
        except (TypeError, ValueError):
            limit_param = None

    snapshot = list_psp_customer_dispatch_requests(
        organization=organization,
        customer_uuid=str(customer.id),
        status=status_param,
        lot_uuid=lot_uuid_param,
        limit=limit_param,
    )
    if not isinstance(snapshot, dict):
        return Response(empty)

    return Response(_normalise_dispatch_request_envelope(snapshot))


def _empty_dispatch_request_envelope() -> dict[str, Any]:
    return {
        "customer": {"uuid": None, "name": None},
        "summary": {"total": 0, "pending": 0, "completed": 0, "cancelled": 0},
        "requests": [],
    }


def _normalise_dispatch_request_envelope(snapshot: dict[str, Any]) -> dict[str, Any]:
    envelope = _empty_dispatch_request_envelope()
    customer = snapshot.get("customer")
    if isinstance(customer, dict):
        envelope["customer"] = {
            "uuid": customer.get("uuid"),
            "name": customer.get("name"),
        }
    summary = snapshot.get("summary")
    if isinstance(summary, dict):
        envelope["summary"] = {
            "total": summary.get("total", 0) or 0,
            "pending": summary.get("pending", 0) or 0,
            "completed": summary.get("completed", 0) or 0,
            "cancelled": summary.get("cancelled", 0) or 0,
        }
    requests_list = snapshot.get("requests")
    if isinstance(requests_list, list):
        envelope["requests"] = requests_list
    return envelope


def _dispatch_error(code: str, status_code: int) -> Response:
    return Response(
        {
            "detail": code,
            "message": _DISPATCH_ERROR_COPY.get(code, _DISPATCH_ERROR_COPY["psp_error"]),
        },
        status=status_code,
    )


def _strip_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
