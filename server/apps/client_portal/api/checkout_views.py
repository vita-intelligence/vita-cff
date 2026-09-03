"""Portal cart checkout endpoint.

``POST /api/portal/checkout/`` accepts the cart lines + customer-
detail overrides captured in the storefront's checkout modal.
Product lines each become their own draft :class:`Proposal` (one
per cart line so a customer picking two combos of the same SKU
gets two independent quotes); sample lines each drop a PENDING
:class:`Payment` in the finance queue.

Success payload:

.. code-block:: json

   {
     "proposal_ids": ["…", "…"],  // one id per product line
     "payment_ids":  ["…", "…"]   // one id per sample line
   }

Errors surface as ``{"detail": "<code>", "message": "<human>"}``
so the FE can either map the code (rare) or fall back to the
human message (default).

Anti-abuse layer (belt AND suspenders — real cart flows spend
money, so we defend early):

* **Idempotency** — the client sends an ``Idempotency-Key`` header
  (uuid, persisted to sessionStorage so a reload keeps the same
  key). First success is cached per (account, key) for 24 hours;
  repeat POSTs with the same key return the ORIGINAL response
  instead of creating a second proposal / another sample payment.
* **Honeypot** — two hidden inputs (``website``, ``hp_url``) that
  humans can't see (off-screen, ``tabIndex=-1``, ``aria-hidden``).
  Any value ⇒ silent fake success so the bot moves on without
  learning it was blocked. Nothing is written to the DB.
* **Rate limit** — 6 successful attempts / 60 seconds / account.
  Counter lives in the Django cache (Redis in prod). Over-limit
  returns 429.
* **Min elapsed time** — the client reports how long the modal was
  open before submit; anything under 1.5 s reads as automation and
  returns 400. Trivial to bypass by a determined attacker but
  filters out unsophisticated form-fillers for free.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.core.cache import cache
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

# --- Anti-abuse tunables --------------------------------------------------
# Kept as module constants — small enough to inline, but pulling them out
# keeps future tweaks (e.g. bumping rate limit after Redis lands) in one
# place. NOT in Django settings on purpose: these values are checkout-
# specific, not org-wide policy.

_IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24  # 24h — quotes span workdays.
_RATE_LIMIT_MAX_HITS = 6
_RATE_LIMIT_WINDOW_SECONDS = 60
_MIN_ELAPSED_MS = 1_500  # Sub-1.5s submits are almost always bots.


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
    """Mirror of :class:`CheckoutInput` plus anti-abuse fields."""

    lines = _LineSerializer(many=True)
    name = serializers.CharField(max_length=200, allow_blank=True, default="")
    company = serializers.CharField(max_length=200, allow_blank=True, default="")
    phone = serializers.CharField(max_length=60, allow_blank=True, default="")
    invoice_address = serializers.CharField(allow_blank=True, default="")
    delivery_address = serializers.CharField(allow_blank=True, default="")

    # Anti-abuse fields — hidden inputs on the client, humans never
    # see them. Any non-empty value is a positive bot signal.
    website = serializers.CharField(max_length=200, allow_blank=True, default="", required=False)
    hp_url = serializers.CharField(max_length=200, allow_blank=True, default="", required=False)

    # How long the modal was open before submit. Client-clock so
    # not tamper-proof, but bots rarely bother spoofing it.
    elapsed_ms = serializers.IntegerField(min_value=0, default=0, required=False)

    def validate_lines(self, lines):
        if not lines:
            raise serializers.ValidationError("At least one line is required.")
        return lines


def _honeypot_tripped(data: dict) -> bool:
    """Any hidden field with content ⇒ automated agent."""
    return bool(
        (data.get("website") or "").strip()
        or (data.get("hp_url") or "").strip()
    )


def _rate_limit_key(account_id) -> str:
    return f"portal_checkout_rate:{account_id}"


def _idempotency_cache_key(account_id, idempotency_key: str) -> str:
    return f"portal_checkout_idem:{account_id}:{idempotency_key}"


class PortalCheckoutView(PortalAPIView):
    """POST /api/portal/checkout/ — drain the cart into NPD."""

    def post(self, request: Request) -> Response:
        serializer = _CheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # 1. Honeypot — silent fake-success so bots don't retry with
        #    different values. NO side effects. NO log noise, since
        #    the caller expects the shape of a real result.
        if _honeypot_tripped(data):
            return Response(
                {"proposal_ids": [], "payment_ids": []},
                status=status.HTTP_201_CREATED,
            )

        account_pk = request.user.pk

        # 2. Idempotency — same key ⇒ replay cached response. Guards
        #    double-clicks, network retries, back-button resubmits,
        #    and reload-in-flight (client persists the key to
        #    sessionStorage across reloads).
        idempotency_key = (request.headers.get("Idempotency-Key") or "").strip()
        if idempotency_key:
            cached = cache.get(_idempotency_cache_key(account_pk, idempotency_key))
            if cached is not None:
                return Response(cached, status=status.HTTP_201_CREATED)

        # 3. Rate limit — cheap counter to burn spam. Not atomic
        #    across processes but LocMemCache / Redis are close
        #    enough for a per-user 6/min cap.
        rate_key = _rate_limit_key(account_pk)
        hits = cache.get(rate_key, 0)
        if hits >= _RATE_LIMIT_MAX_HITS:
            return Response(
                {
                    "detail": "rate_limited",
                    "message": (
                        "Too many attempts. Take a minute, then try again."
                    ),
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )
        cache.set(rate_key, hits + 1, timeout=_RATE_LIMIT_WINDOW_SECONDS)

        # 4. Min elapsed — reject sub-1.5s submits. Cheap bot filter.
        if int(data.get("elapsed_ms") or 0) < _MIN_ELAPSED_MS:
            return Response(
                {
                    "detail": "too_fast",
                    "message": "Please review your details before submitting.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

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
            result = place_portal_checkout(
                account=request.user, payload=payload, request=request
            )
        except CheckoutError as exc:
            return Response(
                {"detail": exc.code, "message": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        body = {
            "proposal_ids": result.proposal_ids,
            "payment_ids": result.payment_ids,
        }
        # Only cache actual writes so a stale response never blocks
        # a customer with no key from retrying legitimately.
        if idempotency_key:
            cache.set(
                _idempotency_cache_key(account_pk, idempotency_key),
                body,
                timeout=_IDEMPOTENCY_TTL_SECONDS,
            )

        return Response(body, status=status.HTTP_201_CREATED)
