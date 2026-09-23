"""MRPEasy REST API client.

Two implementations behind a single :class:`MrpeasyClient` shape so
every consumer (the price-hint surface on spec approval + proposal
pages, the owner-only "Test connection" button on the Integrations
settings tab) can stay agnostic of which backend it's talking to:

* :class:`MockMrpeasyClient` — canned responses, used in tests and
  whenever ``MRPEASY_MOCK`` is set. Lets the price-hint UI render an
  end-to-end flow during development without burning real MRPEasy
  API quota.

* :class:`HttpMrpeasyClient` — HTTP Basic auth (``Authorization:
  Basic base64(api_key:api_secret)``) against
  ``https://app.mrpeasy.com/rest/v1/``. Used in production once an
  org has stored credentials.

Both raise typed exceptions
(:class:`MrpeasyAuthFailed`, :class:`MrpeasyUnreachable`,
:class:`MrpeasyRateLimited`, :class:`MrpeasyInvalidConfig`) so the
service layer maps them onto user-facing UI states without
catching bare urllib exceptions. The price-hint endpoint silently
degrades to "no MRPEasy match" on every failure mode so an MRPEasy
outage never blocks the rest of the app — operators can still
type a price by hand.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import urllib.parse
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.error import HTTPError, URLError


logger = logging.getLogger(__name__)
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MrpeasyItem:
    """One ``Item`` row returned by an MRPEasy lookup.

    Only the fields the price-hint + deep-link surfaces need —
    the MRPEasy response carries dozens of columns (cost, stock,
    vendor, …) but we deliberately project to the minimum so a
    future renaming on their side doesn't break unrelated callers.

    ``selling_price`` is the customer-facing list price MRPEasy
    stores against the item; we surface it as the director's
    "MRPEasy suggested price" hint. ``None`` when MRPEasy stored
    the item but left ``selling_price`` blank — the UI treats it
    the same as "no MRPEasy match".

    ``product_id`` is MRPEasy's internal numeric ID for the row.
    Powers the deep link into the MRPEasy admin UI
    (``/articles/view/<product_id>``). ``None`` when the row
    didn't carry one (defensive — every real row has it, but
    keeping it optional means the dataclass survives a partial
    or older API response).
    """

    code: str
    title: str
    selling_price: Decimal | None
    product_id: int | None = None
    #: Average unit cost across recent POs (``avg_cost``). Distinct
    #: from ``selling_price`` (outbound list) and from the per-vendor
    #: ``purchase_terms[].price`` (the real "next PO" price). Kept
    #: because the price-hint UI likes a single number for the
    #: fallback case where an item has no active purchase terms.
    avg_cost: Decimal | None = None
    #: Every purchase term MRPEasy has on file for this item — one
    #: entry per approved vendor + tier. Populated from the item
    #: row's embedded ``purchase_terms`` array. Empty list when the
    #: item is either self-manufactured or has no vendor set up.
    purchase_terms: tuple[MrpeasyPurchaseTerm, ...] = ()


@dataclass(frozen=True)
class MrpeasyPurchaseTerm:
    """One row inside an item's embedded ``purchase_terms`` list.

    MRPEasy stores multiple purchase terms per item (one per
    vendor + tier) inline on the item row itself — there is no
    separate ``/purchase-terms`` endpoint. The list is what the
    UI shows on the item's Purchase tab and what the sync into
    PSP writes into ``vendors``, ``vendor_item_prices``, and
    ``vendor_item_purchase_terms``.

    ``currency`` arrives as the vendor's ISO currency SYMBOL
    (``£``, ``$``, ``€``, …), not the ISO code — the sync layer
    is responsible for normalising to ``GBP`` / ``USD`` / ``EUR``
    before writing to PSP.
    """

    vendor_id: int | None
    vendor_code: str
    vendor_title: str
    vendor_product_code: str | None
    price: Decimal | None
    currency_symbol: str | None
    lead_time_days: int | None
    min_quantity: Decimal | None
    unit: str | None
    priority: int | None


@dataclass(frozen=True)
class MrpeasyVendor:
    """One ``Vendor`` row returned by ``GET /vendors``.

    Slim projection — MRPEasy exposes dozens of contact and
    address columns but the purchase-terms sync only needs the
    matching key (``code``), the human name, and the numeric
    ``vendor_id`` (target of any future deep link).

    Approval status is smuggled inside the vendor ``title`` in
    MRPEasy — vendors NOT approved to trade with have their
    display name suffixed with ``(UnApproved)`` /
    ``(Unapproved)``. :attr:`approved` unpacks that suffix so the
    sync layer doesn't have to re-parse the title downstream.
    :attr:`clean_title` is the same title with the suffix
    stripped, ready to use as the human name in PSP.
    """

    code: str
    title: str
    vendor_id: int | None = None

    @property
    def approved(self) -> bool:
        # MRPEasy has two typographic variants of the unapproved
        # tag in the wild — normalise before comparing.
        haystack = self.title.lower()
        return "(unapproved)" not in haystack

    @property
    def clean_title(self) -> str:
        # Strip the trailing ``(Approved)`` / ``(Unapproved)`` /
        # ``(UnApproved)`` suffix + surrounding whitespace so the
        # PSP display name doesn't carry MRPEasy's workflow flag.
        import re

        return re.sub(
            r"\s*\((approved|unapproved)\)\s*$",
            "",
            self.title,
            flags=re.IGNORECASE,
        ).strip()


@dataclass(frozen=True)
class MrpeasyPurchaseOrderLine:
    """One line inside :class:`MrpeasyPurchaseOrder`.``lines``.

    Sourced from the ``products`` array on the PO row — MRPEasy
    inlines line items on every ``/purchase-orders`` response so
    the client doesn't need a per-PO detail call.
    """

    item_code: str
    item_title: str
    quantity: Decimal | None
    unit_price: Decimal | None
    unit: str | None


@dataclass(frozen=True)
class MrpeasyPurchaseOrder:
    """One ``Purchase Order`` row returned by
    ``GET /purchase-orders``. Only carries the fields the
    history-backfill sync uses — enough to attribute qty +
    price to a (vendor, item) pair with a plausible
    ``last_paid_at``.
    """

    code: str
    po_id: int | None
    vendor_code: str | None
    vendor_title: str | None
    arrival_date: str | None
    created_at: str | None
    currency_symbol: str | None
    lines: tuple[MrpeasyPurchaseOrderLine, ...]


@dataclass(frozen=True)
class MrpeasyConfig:
    """In-memory shape of an org's MRPEasy integration config.

    Source of truth lives on :attr:`Organization.mrpeasy_config`
    (JSONField) — this dataclass is a typed view for the service +
    client layers so callers don't sprinkle ``dict.get`` everywhere.
    """

    enabled: bool
    api_key: str
    #: Plaintext secret — only present in-memory inside the service
    #: layer after a fresh ``decrypt_secret`` call. NEVER serialised
    #: back to the wire — the API surfaces a ``has_secret`` flag
    #: instead so the form can show "●●●●●●●" without leaking.
    api_secret: str

    @property
    def is_complete(self) -> bool:
        """True when every required field has a non-empty value.

        Mirrors :class:`DynamicsConfig.is_complete` — the settings
        UI gates "Test Connection" and the price-hint surfaces on
        this. The base URL is fixed (no per-org subdomain) so the
        check is purely about the key / secret pair.
        """

        return bool(self.enabled and self.api_key and self.api_secret)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class MrpeasyError(Exception):
    """Base class for every MRPEasy-side failure.

    The service layer catches the base class to silently degrade
    the price hint to "no MRPEasy match"; the API layer catches
    specific subclasses to map onto distinct settings-page UI
    states ("Bad credentials" vs "Unreachable").
    """


class MrpeasyAuthFailed(MrpeasyError):
    code = "mrpeasy_auth_failed"


class MrpeasyUnreachable(MrpeasyError):
    code = "mrpeasy_unreachable"


class MrpeasyRateLimited(MrpeasyError):
    code = "mrpeasy_rate_limited"


class MrpeasyInvalidConfig(MrpeasyError):
    code = "mrpeasy_invalid_config"


# ---------------------------------------------------------------------------
# Mock client — every test + every dev runs this
# ---------------------------------------------------------------------------


# Canned dataset for the mock. Keyed by ``code`` so a lookup feels
# realistic — match the project codes that already seed in dev
# fixtures so the price hint actually renders during a demo.
_MOCK_ITEMS: dict[str, MrpeasyItem] = {
    "MA210367": MrpeasyItem(
        code="MA210367",
        title="Valley Low Fat Burner Capsules (60s)",
        selling_price=Decimal("14.99"),
        product_id=4205,
    ),
    "MA512342": MrpeasyItem(
        code="MA512342",
        title="Super Puper Capsules",
        selling_price=Decimal("18.50"),
        product_id=4207,
    ),
}


class MockMrpeasyClient:
    """Canned in-memory MRPEasy stand-in for tests + dev.

    ``test_connection()`` returns success unless the config is
    obviously broken (empty key) — that lets us exercise the
    settings page's success state without a real MRPEasy tenant.
    ``lookup_by_code()`` returns a fixture row for the codes baked
    into :data:`_MOCK_ITEMS` and ``None`` otherwise so the
    "no MRPEasy match" chip surfaces on unknown codes too.
    """

    def __init__(self, config: MrpeasyConfig) -> None:
        if not config.is_complete:
            raise MrpeasyInvalidConfig(
                "MRPEasy mock client requires a complete config."
            )
        self._config = config

    def test_connection(self) -> None:
        # No-op in the mock — the dataclass already validated
        # completeness on construction.
        return None

    def lookup_by_code(self, code: str) -> MrpeasyItem | None:
        return _MOCK_ITEMS.get(code.strip())

    def list_items(
        self,
        limit: int = 100,
        search: str | None = None,
    ) -> list[MrpeasyItem]:
        """Return up to ``limit`` items, optionally filtered by ``search``.

        Mirrors the HTTP client's contract so dev/test code paths
        exercise the same shape as production. The mock filter is
        deliberately simple — substring match against ``code`` or
        ``title`` (case-insensitive) — because the real MRPEasy
        backend does the filtering server-side; this stand-in
        just needs to behave plausibly for tests and the dev UI.
        """

        cleaned = (search or "").strip().lower()
        rows = list(_MOCK_ITEMS.values())
        if cleaned:
            rows = [
                row
                for row in rows
                if cleaned in row.code.lower() or cleaned in row.title.lower()
            ]
        return rows[:limit]

    def iter_all_items(self, page_size: int = 100):
        """Yield every fixture item — the mock equivalent of the real
        client's paginated crawl."""
        for row in _MOCK_ITEMS.values():
            yield row

    def list_all_vendors(self, page_size: int = 100) -> list["MrpeasyVendor"]:
        """Empty by default — tests that need vendor rows can patch
        this method or push fixtures into a subclass. Keeps the mock
        deterministic without carrying a global vendor registry."""
        return []

    def iter_all_purchase_orders(self, page_size: int = 100):
        """Empty by default — tests that need PO history push
        fixtures into a subclass. Same rationale as
        :meth:`list_all_vendors`."""
        return iter(())


# ---------------------------------------------------------------------------
# Real HTTP client — runs in production when ``MRPEASY_MOCK`` is unset
# ---------------------------------------------------------------------------


_MRPEASY_BASE_URL = "https://app.mrpeasy.com/rest/v1/"
#: Hard ceiling on a single MRPEasy round-trip. The price hint is
#: rendered inline during a page load — anything longer than this
#: stalls the operator's modal more than they can tolerate, and we
#: prefer "no MRPEasy match" to "loading forever". 4 seconds matches
#: the proxy refresh timeout for consistency.
_MRPEASY_TIMEOUT_SECONDS = 4.0


class HttpMrpeasyClient:
    """Real-tenant MRPEasy client.

    Uses stdlib ``urllib`` (no third-party HTTP dependency) since
    we already pull in stdlib for the Dataverse client and the
    request shape is trivially small. HTTP Basic via
    ``Authorization: Basic base64(api_key:api_secret)`` matches
    the MRPEasy docs exactly.
    """

    def __init__(self, config: MrpeasyConfig) -> None:
        if not config.is_complete:
            raise MrpeasyInvalidConfig(
                "MRPEasy HTTP client requires a complete config."
            )
        self._config = config
        token = base64.b64encode(
            f"{config.api_key}:{config.api_secret}".encode("utf-8")
        ).decode("ascii")
        self._auth_header = f"Basic {token}"

    def _request(
        self,
        path: str,
        query: dict[str, str] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        url = f"{_MRPEASY_BASE_URL}{path.lstrip('/')}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {
            "Authorization": self._auth_header,
            "Accept": "application/json",
            "User-Agent": "VitaNPD/1.0",
        }
        if extra_headers:
            headers.update(extra_headers)
        req = Request(
            url,
            method="GET",
            headers=headers,
        )
        try:
            with urlopen(req, timeout=_MRPEASY_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except HTTPError as exc:
            # Map HTTP status onto our typed exceptions so the
            # settings page can render a precise error chip.
            if exc.code in (401, 403):
                raise MrpeasyAuthFailed(
                    f"MRPEasy rejected the credentials (HTTP {exc.code})."
                ) from exc
            if exc.code == 429:
                raise MrpeasyRateLimited(
                    "MRPEasy rate limit reached. Retry shortly."
                ) from exc
            raise MrpeasyUnreachable(
                f"MRPEasy returned HTTP {exc.code}."
            ) from exc
        except URLError as exc:
            raise MrpeasyUnreachable(
                f"Couldn't reach MRPEasy: {exc.reason}"
            ) from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            # Malformed JSON from a 2xx response — treat as
            # unreachable rather than letting a parse error bubble
            # up as a 500 to the operator.
            raise MrpeasyUnreachable(
                "MRPEasy returned a non-JSON response body."
            ) from exc

    def test_connection(self) -> None:
        """Validate credentials by fetching the first page of items.

        MRPEasy has no dedicated ``/whoami`` endpoint, so we hit
        ``/items`` with a 1-row limit — minimum-cost call that's
        gated behind the same auth as the rest of the surface. A
        2xx means the credentials are good; anything else surfaces
        as a typed exception.
        """

        self._request("items", query={"limit": "1"})

    def lookup_by_code(self, code: str) -> MrpeasyItem | None:
        """Look up a single item by its MRPEasy ``code`` (part number).

        The MRPEasy ``GET /items?code=<code>`` endpoint accepts an
        exact part-number filter — confirmed via their reference
        docs. Returns an array; we take the first match (codes are
        unique in MRPEasy) or ``None`` when nothing matched.
        """

        cleaned = (code or "").strip()
        if not cleaned:
            return None
        payload = self._request("items", query={"code": cleaned})
        if not isinstance(payload, list) or not payload:
            return None
        first = payload[0]
        if not isinstance(first, dict):
            return None
        return _build_item(first)

    def list_items(
        self,
        limit: int = 100,
        search: str | None = None,
    ) -> list[MrpeasyItem]:
        """List MRPEasy items, optionally filtered by ``search``.

        When ``search`` is set, we delegate filtering to MRPEasy
        itself instead of paging through every row — tenants run
        8k+ SKUs, so client-side filtering is a non-starter. Two
        round-trips at most:

        1. ``?code=<search>`` — exact-match on part number. Picks
           up the common case where the operator pastes a SKU.
        2. ``?title=<search>`` — partial match on the human-
           readable product name. Returns the first matches for
           a name fragment like "Morning".

        Empty ``search`` falls back to the legacy first-page
        browse, capped at ``limit`` rows. The picker doesn't use
        this path anymore (search is required there) but other
        callers may.
        """

        cleaned = (search or "").strip()
        if cleaned:
            return self._search_items(cleaned)

        # Legacy "browse first N rows" path. MRPEasy caps a single
        # request at 100, so this stays one round-trip.
        capped = max(1, min(int(limit), 100))
        payload = self._request("items", query={"limit": str(capped)})
        if not isinstance(payload, list):
            return []
        if payload and isinstance(payload[0], dict):
            logger.info(
                "MRPEasy /items first-row keys: %s",
                sorted(payload[0].keys()),
            )
        return [
            _build_item(row) for row in payload if isinstance(row, dict)
        ]

    def _search_items(self, query: str) -> list[MrpeasyItem]:
        """Filter MRPEasy items by code (exact) then title (partial).

        Splits the heuristic out of :meth:`list_items` so the read
        path stays linear. Returns the union without duplicates —
        the same item can appear in both filter results if the
        title happens to contain its own code, so we dedupe on
        ``code``.
        """

        seen: set[str] = set()
        collected: list[MrpeasyItem] = []

        # ``code`` is an exact-match filter — at most one row back.
        # Try it first because it short-circuits the common "I
        # know the part number" case.
        code_payload = self._request("items", query={"code": query})
        if isinstance(code_payload, list):
            for row in code_payload:
                if not isinstance(row, dict):
                    continue
                item = _build_item(row)
                if item.code and item.code not in seen:
                    seen.add(item.code)
                    collected.append(item)

        # ``title`` is partial-match; the operator typing a name
        # fragment ("Morning") lands here. We always run this leg
        # too so the picker shows related rows even when the code
        # leg already hit — useful for "did I get the SKU right?"
        # disambiguation.
        title_payload = self._request("items", query={"title": query})
        if isinstance(title_payload, list):
            if title_payload and isinstance(title_payload[0], dict):
                logger.info(
                    "MRPEasy /items first-row keys: %s",
                    sorted(title_payload[0].keys()),
                )
            for row in title_payload:
                if not isinstance(row, dict):
                    continue
                item = _build_item(row)
                if item.code and item.code not in seen:
                    seen.add(item.code)
                    collected.append(item)

        return collected

    # ---------------------------------------------------------------
    # Bulk read paths — used by mrpeasy_pull_purchase_terms to hydrate
    # PSP's vendor / vendor_item_prices tables from the MRPEasy tenant.
    # Kept off the per-request price-hint code path (which stays a
    # single filtered lookup); these methods knowingly page through
    # the entire tenant catalogue.
    # ---------------------------------------------------------------

    def iter_all_items(self, page_size: int = 100):
        """Yield every :class:`MrpeasyItem` in the tenant catalogue.

        Pagination uses ``Range: items=<start>-<end>`` — probed
        against a real tenant, MRPEasy silently ignores ``?limit=``
        + ``?offset=`` and always returns the first page. The Range
        header, however, cleanly walks the catalogue. Confusingly
        the *unit* is always ``items`` regardless of endpoint —
        both ``/items`` and ``/vendors`` respond to
        ``Range: items=100-199`` with the second page.

        The generator shape keeps memory flat for tenants with
        thousands of SKUs — the caller decides whether to buffer
        into a list or stream straight into the DB writer.
        """

        capped = max(1, min(int(page_size), 100))
        start = 0
        while True:
            end = start + capped - 1
            payload = self._request(
                "items",
                extra_headers={"Range": f"items={start}-{end}"},
            )
            if not isinstance(payload, list) or not payload:
                return
            for row in payload:
                if isinstance(row, dict):
                    yield _build_item(row)
            # Short page = end of catalogue, no need to prove-it-empty
            # with another round trip.
            if len(payload) < capped:
                return
            start += capped

    def iter_all_purchase_orders(self, page_size: int = 100):
        """Yield every :class:`MrpeasyPurchaseOrder` in the tenant.

        Same ``Range: items=<a>-<b>`` pagination as the other
        iterators. MRPEasy inlines the PO ``products`` array on
        the listing response, so a single crawl gives us both the
        header + all line rows without a per-PO detail call.
        """

        capped = max(1, min(int(page_size), 100))
        start = 0
        while True:
            end = start + capped - 1
            payload = self._request(
                "purchase-orders",
                extra_headers={"Range": f"items={start}-{end}"},
            )
            if not isinstance(payload, list) or not payload:
                return
            for row in payload:
                if isinstance(row, dict):
                    yield _build_purchase_order(row)
            if len(payload) < capped:
                return
            start += capped

    def list_all_vendors(self, page_size: int = 100) -> list["MrpeasyVendor"]:
        """Return every vendor in the tenant catalogue.

        Same ``Range: items=<start>-<end>`` pagination as
        :meth:`iter_all_items` — the unit stays ``items`` even on
        ``/vendors``, which was one of the surprises when wiring
        the sync. Vendors are almost always a small set (<1k rows)
        so a materialised list is fine — callers zip it against
        the items iterator to resolve ``item.vendor_code`` into a
        full vendor row.
        """

        capped = max(1, min(int(page_size), 100))
        collected: list[MrpeasyVendor] = []
        start = 0
        while True:
            end = start + capped - 1
            payload = self._request(
                "vendors",
                extra_headers={"Range": f"items={start}-{end}"},
            )
            if not isinstance(payload, list) or not payload:
                return collected
            for row in payload:
                if isinstance(row, dict):
                    collected.append(_build_vendor(row))
            if len(payload) < capped:
                return collected
            start += capped


def _build_item(row: dict[str, Any]) -> MrpeasyItem:
    """Project an MRPEasy item dict down to the
    :class:`MrpeasyItem` slice the app actually uses.

    The human-readable product name lives in different keys
    depending on which MRPEasy endpoint / API version answered.
    Real-tenant ``/items`` responses use ``description``; older
    docs sometimes show ``title``; and a few endpoints return
    ``part_description`` instead. We try them in order so the
    picker's search always has SOMETHING to match against —
    otherwise a tenant whose response uses ``description`` would
    show only code matches (the bug that hid every name-based
    search for items beyond the typed part-number).

    Defensive type coercion — MRPEasy occasionally returns numbers
    as JSON numbers and occasionally as strings depending on the
    field; ``Decimal`` from either path. ``InvalidOperation`` on a
    parsable-but-non-numeric value (e.g. ``"N/A"``) surfaces as
    ``None`` so the hint just hides instead of crashing the modal.
    """

    raw_price = row.get("selling_price")
    selling_price: Decimal | None = None
    if raw_price is not None and raw_price != "":
        try:
            selling_price = Decimal(str(raw_price))
        except (InvalidOperation, ValueError):
            selling_price = None
    name = (
        row.get("description")
        or row.get("title")
        or row.get("part_description")
        or row.get("name")
        or ""
    )
    # ``product_id`` is the integer MRPEasy uses in its admin URL
    # (``/articles/view/<product_id>``). Coerce defensively — the
    # field has always come back as an int in observed responses,
    # but a string-typed value (or a missing field on a future
    # endpoint variant) should degrade to ``None`` rather than
    # crashing the projector.
    raw_product_id = row.get("product_id")
    product_id: int | None = None
    if isinstance(raw_product_id, int):
        product_id = raw_product_id
    elif isinstance(raw_product_id, str) and raw_product_id.strip().isdigit():
        product_id = int(raw_product_id.strip())
    # Vendor + cost data for the purchase-terms sync. Cost lives
    # on ``avg_cost`` (recent-PO average) — MRPEasy has no
    # single-value ``cost`` field on the item row. Per-vendor
    # pricing / lead time / MOQ arrives embedded on the item as
    # ``purchase_terms: list[{...}]`` — one entry per active
    # supplier. Legacy items with no vendor set up return an
    # empty list, which the sync should treat as "leave alone".
    raw_avg = row.get("avg_cost")
    avg_cost: Decimal | None = None
    if raw_avg is not None and raw_avg != "":
        try:
            avg_cost = Decimal(str(raw_avg))
        except (InvalidOperation, ValueError):
            avg_cost = None

    terms: list[MrpeasyPurchaseTerm] = []
    raw_terms = row.get("purchase_terms")
    if isinstance(raw_terms, list):
        for term in raw_terms:
            if not isinstance(term, dict):
                continue
            terms.append(_build_purchase_term(term))
    return MrpeasyItem(
        code=str(row.get("code") or row.get("part_number") or ""),
        title=str(name),
        selling_price=selling_price,
        product_id=product_id,
        avg_cost=avg_cost,
        purchase_terms=tuple(terms),
    )


def _build_purchase_term(term: dict[str, Any]) -> MrpeasyPurchaseTerm:
    """Coerce one MRPEasy ``purchase_terms[]`` row into
    :class:`MrpeasyPurchaseTerm`. Numeric fields land as
    ``Decimal`` where present so the DB writer never has to
    stringify-then-parse; string-typed values that fail to
    parse degrade to ``None`` rather than raising.
    """

    def _to_decimal(raw: Any) -> Decimal | None:
        if raw is None or raw == "":
            return None
        try:
            return Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return None

    def _to_int(raw: Any) -> int | None:
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str) and raw.strip().isdigit():
            return int(raw.strip())
        return None

    vendor_code = str(term.get("vendor_code") or "").strip()
    return MrpeasyPurchaseTerm(
        vendor_id=_to_int(term.get("vendor_id")),
        vendor_code=vendor_code,
        vendor_title=str(term.get("vendor_title") or "").strip(),
        vendor_product_code=(
            str(term.get("vendor_product_code")).strip()
            if term.get("vendor_product_code")
            else None
        ),
        price=_to_decimal(term.get("price")),
        currency_symbol=(
            str(term.get("currency")).strip()
            if term.get("currency")
            else None
        ),
        lead_time_days=_to_int(term.get("lead_time")),
        min_quantity=_to_decimal(term.get("min_quantity")),
        unit=(
            str(term.get("unit")).strip() if term.get("unit") else None
        ),
        priority=_to_int(term.get("priority")),
    )


def _build_vendor(row: dict[str, Any]) -> MrpeasyVendor:
    """Project an MRPEasy vendor row down to
    :class:`MrpeasyVendor`. Matching key is ``code``.
    """

    raw_vendor_id = row.get("vendor_id")
    vendor_id: int | None = None
    if isinstance(raw_vendor_id, int):
        vendor_id = raw_vendor_id
    elif isinstance(raw_vendor_id, str) and raw_vendor_id.strip().isdigit():
        vendor_id = int(raw_vendor_id.strip())
    return MrpeasyVendor(
        code=str(row.get("code") or ""),
        title=str(row.get("title") or row.get("name") or ""),
        vendor_id=vendor_id,
    )


def _build_purchase_order(row: dict[str, Any]) -> MrpeasyPurchaseOrder:
    """Project an MRPEasy PO row + inlined ``products`` array
    down to :class:`MrpeasyPurchaseOrder`.

    Date fields need special care — ``created`` arrives as a
    Unix epoch integer (or string of one) on this tenant's REST
    v1 response, while ``arrival_date`` uses ISO ``YYYY-MM-DD``.
    Both land normalised to ISO strings so the SQL layer can
    cast to ``timestamp`` / ``date`` without shape-matching.
    """
    import datetime as _dt

    def _to_decimal(raw: Any) -> Decimal | None:
        if raw is None or raw == "":
            return None
        try:
            return Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return None

    def _to_int(raw: Any) -> int | None:
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str) and raw.strip().isdigit():
            return int(raw.strip())
        return None

    def _to_iso_date(raw: Any) -> str | None:
        # Accept: unix epoch int, epoch as digit-string, or an
        # already-formatted ISO date. Anything else degrades to
        # None so the aggregation just skips this signal instead
        # of raising.
        if raw is None or raw == "":
            return None
        if isinstance(raw, int) or (
            isinstance(raw, str) and raw.strip().lstrip("-").isdigit()
        ):
            try:
                epoch = int(raw)
                return (
                    _dt.datetime.fromtimestamp(epoch, tz=_dt.timezone.utc)
                    .date()
                    .isoformat()
                )
            except (OverflowError, ValueError, OSError):
                return None
        if isinstance(raw, str):
            return raw.strip() or None
        return None

    lines: list[MrpeasyPurchaseOrderLine] = []
    for prod in row.get("products") or []:
        if not isinstance(prod, dict):
            continue
        lines.append(
            MrpeasyPurchaseOrderLine(
                item_code=str(prod.get("item_code") or ""),
                item_title=str(prod.get("item_title") or ""),
                quantity=_to_decimal(prod.get("quantity")),
                unit_price=_to_decimal(prod.get("item_price")),
                unit=(
                    str(prod.get("unit")).strip()
                    if prod.get("unit")
                    else None
                ),
            )
        )
    return MrpeasyPurchaseOrder(
        code=str(row.get("code") or ""),
        po_id=_to_int(row.get("po_id") or row.get("id")),
        vendor_code=(
            str(row.get("vendor_code")).strip()
            if row.get("vendor_code")
            else None
        ),
        vendor_title=(
            str(row.get("vendor_title")).strip()
            if row.get("vendor_title")
            else None
        ),
        arrival_date=_to_iso_date(row.get("arrival_date")),
        created_at=_to_iso_date(row.get("created")),
        currency_symbol=(
            str(row.get("currency")).strip()
            if row.get("currency")
            else None
        ),
        lines=tuple(lines),
    )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_client(config: MrpeasyConfig) -> MockMrpeasyClient | HttpMrpeasyClient:
    """Return the right MRPEasy client for the current environment.

    Tests set ``MRPEASY_MOCK=true`` (or call ``with_mock()`` via the
    pytest fixture) so the entire suite never reaches out to a real
    tenant. Production runs ``HttpMrpeasyClient`` because the env
    var is unset.
    """

    if os.environ.get("MRPEASY_MOCK", "").lower() in {"true", "1", "yes"}:
        return MockMrpeasyClient(config)
    return HttpMrpeasyClient(config)


# ---------------------------------------------------------------------------
# Service layer — settings CRUD + suggested-price lookup
# ---------------------------------------------------------------------------
#
# Kept in this module (rather than ``proposals/services.py``) so the
# MRPEasy subsystem is a single self-contained file. ``services.py``
# is already past 2,400 lines and bolting another integration onto
# it makes the proposal lifecycle harder to scan. The boundary is
# clean: anything outside this file imports ``mrpeasy.{service_fn}``
# and never touches the dataclass / client types directly.


class MrpeasyNotConfigured(Exception):
    """The org has no usable MRPEasy config (missing fields, or
    integration disabled). The API layer maps this to a 400 so the
    settings page can surface a 'set up MRPEasy first' hint."""

    code = "mrpeasy_not_configured"


class MrpeasyDecryptionFailed(Exception):
    """Stored ciphertext could not be decrypted (typically because
    the ``DYNAMICS_SECRET_KEY`` env var was rotated without
    re-encrypting). API layer surfaces this as a 500 with a
    codified error so the operator re-enters the credentials."""

    code = "mrpeasy_decryption_failed"


def is_mrpeasy_live(organization: Any) -> bool:
    """Return True when the org has an actually-usable MRPEasy
    integration (``enabled`` AND credentials stored).

    Single source of truth for every "is MRPEasy on?" branch — the
    organization serializer's ``mrpeasy_live`` flag and the
    suggested-price service both read from here. ``last_tested_at``
    is deliberately NOT part of the gate so a re-keyed integration
    doesn't silently lock out the price hint until someone clicks
    Test.
    """

    raw = (organization.mrpeasy_config or {}) if organization else {}
    return bool(
        raw.get("enabled") and raw.get("api_secret_ciphertext")
    )


def _decode_config(raw: dict) -> MrpeasyConfig:
    """Hydrate the JSONField dict into a typed config (plaintext
    secret).

    Lazy import of the encryption helpers so a test that only
    exercises the dataclass / client mock doesn't pay the cost of
    loading ``cryptography``.
    """

    from apps.organizations.encryption import (
        DecryptionFailed,
        decrypt_secret,
    )

    ciphertext = str(raw.get("api_secret_ciphertext") or "")
    try:
        plaintext = decrypt_secret(ciphertext) if ciphertext else ""
    except DecryptionFailed as exc:
        raise MrpeasyDecryptionFailed(str(exc)) from exc
    return MrpeasyConfig(
        enabled=bool(raw.get("enabled")),
        api_key=str(raw.get("api_key") or ""),
        api_secret=plaintext,
    )


def get_mrpeasy_config(*, organization: Any) -> MrpeasyConfig:
    """Decode and return the org's MRPEasy config — plaintext
    secret. Used internally for the lookup / test calls. Do NOT
    return this directly from an API endpoint — the wire shape
    uses :func:`serialize_mrpeasy_config_for_api` which redacts
    the secret.
    """

    return _decode_config(organization.mrpeasy_config or {})


def serialize_mrpeasy_config_for_api(organization: Any) -> dict[str, Any]:
    """Wire shape for ``GET /integrations/mrpeasy/``. Mirrors the
    Dynamics serializer's contract: every field EXCEPT the plaintext
    secret, which becomes a boolean ``has_secret`` so the form can
    render a placeholder password input without leaking the value.
    """

    raw = organization.mrpeasy_config or {}
    return {
        "enabled": bool(raw.get("enabled")),
        "api_key": str(raw.get("api_key") or ""),
        "has_secret": bool(raw.get("api_secret_ciphertext")),
        "last_tested_at": raw.get("last_tested_at") or None,
    }


def set_mrpeasy_config(
    *,
    organization: Any,
    actor: Any,
    enabled: bool,
    api_key: str,
    api_secret: str | None,
) -> dict[str, Any]:
    """Persist the org's MRPEasy config.

    ``api_secret`` is ``None`` when the operator left the password
    field blank (the form's "keep existing secret" sentinel — same
    UX as the Dynamics config form). In that case we preserve the
    stored ciphertext and only update the other fields.

    Returns the API wire shape so the caller can hand the response
    straight back to the frontend without re-serializing.
    """

    from django.db import transaction
    from django.utils import timezone

    from apps.audit.services import record as record_audit, snapshot
    from apps.organizations.encryption import encrypt_secret

    with transaction.atomic():
        before = snapshot(organization)
        existing = organization.mrpeasy_config or {}
        ciphertext: str
        if api_secret is None or api_secret == "":
            ciphertext = str(existing.get("api_secret_ciphertext") or "")
        else:
            ciphertext = encrypt_secret(api_secret)
        organization.mrpeasy_config = {
            "enabled": bool(enabled),
            "api_key": (api_key or "").strip(),
            "api_secret_ciphertext": ciphertext,
            # Rotated credentials invalidate any prior test — the
            # operator must re-test before the green "Connected"
            # state returns. Carrying ``last_tested_at`` forward
            # would let a stale success label hang on a broken
            # integration.
            "last_tested_at": (
                existing.get("last_tested_at")
                if api_secret is None or api_secret == ""
                else None
            ),
        }
        organization.save(update_fields=["mrpeasy_config", "updated_at"])
        # Mutual exclusion with PSP — enabling MRPEasy clears any
        # live PSP config on the same org. The pair share consumer
        # paths (item picker, price hint) and both live at once
        # would produce ambiguous "which source wins" behaviour.
        # The inverse guard lives on the PSP setter symmetrically.
        if bool(enabled) and ciphertext:
            from apps.psp.services import clear_psp_config, is_psp_live

            if is_psp_live(organization):
                clear_psp_config(organization=organization, actor=actor)
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.mrpeasy.configure",
            target=organization,
            before=before,
            after=snapshot(organization),
        )
        # Side-effect: invalidate any cached suggested prices for
        # this org. A new key/secret pair likely points at a
        # different MRPEasy tenant, and serving cached values
        # would mix tenants. The cache helper lives below.
        _invalidate_price_cache(organization)
    return serialize_mrpeasy_config_for_api(organization)


def clear_mrpeasy_config(*, organization: Any, actor: Any) -> dict[str, Any]:
    """Wipe the org's MRPEasy config (DELETE endpoint).

    Imported price data isn't materialised in our DB (the hint is
    rendered live), so disabling the integration only affects
    future lookups — there's nothing to delete from elsewhere in
    the app. Audited so an admin reviewing the trail can see when
    the integration was turned off.
    """

    from django.db import transaction

    from apps.audit.services import record as record_audit, snapshot

    with transaction.atomic():
        before = snapshot(organization)
        organization.mrpeasy_config = {}
        organization.save(update_fields=["mrpeasy_config", "updated_at"])
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.mrpeasy.clear",
            target=organization,
            before=before,
            after=snapshot(organization),
        )
        _invalidate_price_cache(organization)
    return serialize_mrpeasy_config_for_api(organization)


def verify_mrpeasy_connection(*, organization: Any, actor: Any) -> dict[str, Any]:
    """Validate the stored credentials against MRPEasy.

    Stamps ``last_tested_at`` on success so the settings page can
    render "Connected" instead of the amber "Credentials saved —
    test" state. The settings page disables the button until a
    secret has been stored (mirrors the Dynamics card) — this
    helper assumes the gate was honoured and surfaces
    :class:`MrpeasyNotConfigured` defensively when it wasn't.

    Raises the typed exceptions from :mod:`mrpeasy` (auth /
    unreachable / rate-limited) so the API layer can map onto
    distinct UI states; the caller is expected to catch them and
    return the right HTTP status.
    """

    from django.db import transaction
    from django.utils import timezone

    config = _decode_config(organization.mrpeasy_config or {})
    if not config.is_complete:
        raise MrpeasyNotConfigured(
            "MRPEasy isn't fully configured for this workspace."
        )
    client = get_client(config)
    client.test_connection()
    with transaction.atomic():
        raw = dict(organization.mrpeasy_config or {})
        raw["last_tested_at"] = timezone.now().isoformat()
        organization.mrpeasy_config = raw
        organization.save(update_fields=["mrpeasy_config", "updated_at"])
    return serialize_mrpeasy_config_for_api(organization)


# Suggested-price cache — keyed on ``(org_id, code)`` so two orgs
# with different MRPEasy tenants don't share results. 5-minute TTL
# matches the product decision: long enough to make the price hint
# feel snappy across a session of approving spec sheets, short
# enough that a price change in MRPEasy lands in NPD within a
# coffee break. Backed by Django's default cache (LocMemCache in
# dev, Redis once ``CHANNEL_LAYER_URL`` / a Redis CACHE backend is
# wired in production).
_CACHE_TTL_SECONDS = 5 * 60


def _cache_key(organization: Any, code: str) -> str:
    return f"mrpeasy:price:{organization.id}:{code.strip()}"


def _cache_key_pattern(organization: Any) -> str:
    return f"mrpeasy:price:{organization.id}:"


def _invalidate_price_cache(organization: Any) -> None:
    """Drop every cached price for an org.

    Django's default cache backend doesn't expose a key-pattern
    delete (LocMemCache has no scan API; Redis does but isn't
    necessarily wired yet). Best we can do generically is iterate
    the known keys — but we don't track them. So we accept the
    trade-off: the TTL is short (5 minutes), so a config change
    that wasn't strictly necessary to invalidate immediately just
    serves slightly-stale prices for at most the cache window.
    For dedicated invalidation we'd need a per-org epoch counter
    in the cache key — overkill for the current scale.
    """

    return None


def get_mrpeasy_suggested_price(
    *, organization: Any, code: str
) -> MrpeasyItem | None:
    """Return the MRPEasy suggested-price row for a product code, or
    ``None`` when the integration isn't live / the code isn't in
    MRPEasy / the lookup failed.

    Silent degradation is by design — the price hint is a
    convenience, not a correctness gate. An MRPEasy outage must
    never block the operator from saving a unit price they typed
    themselves. The API layer catches the same typed exceptions
    and surfaces them via the settings page (where the operator
    can read the diagnosis) rather than here.

    Cache is checked first via the Django cache backend; misses
    issue one MRPEasy lookup and write the result back. A
    sentinel ``None`` value is cached too so a known-missing code
    doesn't re-fetch on every modal open during a working day.
    """

    from django.core.cache import cache

    cleaned = (code or "").strip()
    if not cleaned:
        return None
    if not is_mrpeasy_live(organization):
        return None
    cache_key = _cache_key(organization, cleaned)
    cached = cache.get(cache_key, _CACHE_MISS_SENTINEL)
    if cached is not _CACHE_MISS_SENTINEL:
        return cached  # type: ignore[return-value]

    try:
        config = _decode_config(organization.mrpeasy_config or {})
        client = get_client(config)
        item = client.lookup_by_code(cleaned)
    except (
        MrpeasyAuthFailed,
        MrpeasyUnreachable,
        MrpeasyRateLimited,
        MrpeasyInvalidConfig,
        MrpeasyDecryptionFailed,
    ):
        # Cache the failure briefly so a broken integration doesn't
        # hammer MRPEasy on every modal open. 30s — short enough
        # that the operator can fix the credentials and see the
        # hint recover, long enough to absorb a tight burst.
        cache.set(cache_key, None, timeout=30)
        return None

    cache.set(cache_key, item, timeout=_CACHE_TTL_SECONDS)
    return item


# Sentinel used to distinguish "cache miss" from "cached as None"
# (the negative-result memoization above). Module-level singleton
# so identity comparison via ``is`` works.
_CACHE_MISS_SENTINEL = object()


# Backend cache for the item list — the new-project picker reads
# this on every modal open, so even a 60s window saves a wave of
# MRPEasy calls when sales/R&D start their day clicking through
# the catalogue. Per-org because each tenant has its own item
# universe.
_LIST_CACHE_TTL_SECONDS = 60


def _list_cache_key(organization: Any, search: str = "") -> str:
    # Include the search string so different queries don't trash
    # each other's cached results. Empty string for the no-search
    # browse path keeps that cache slot stable.
    suffix = f":{search.lower()}" if search else ""
    return f"mrpeasy:items:{organization.id}{suffix}"


def list_mrpeasy_items(
    *,
    organization: Any,
    limit: int = 100,
    search: str | None = None,
) -> list[MrpeasyItem]:
    """Return MRPEasy items for the org, optionally filtered by ``search``.

    Backs the new-project item picker. The picker requires the
    operator to type a query and click Search — at 8k+ SKUs per
    tenant, full-list fetching is not viable. Filtering happens
    on MRPEasy's side via the ``code`` (exact) and ``title``
    (partial) query filters; this service threads ``search``
    through to the client and caches each search separately.

    When ``search`` is empty we fall back to a 100-row browse —
    kept for callers other than the picker.

    Silent degradation: every failure mode (integration off,
    auth fail, unreachable, malformed response) returns an empty
    list so the picker just renders a "no results" state instead
    of crashing the new-project form. The diagnosis surfaces on
    the settings page.
    """

    from django.core.cache import cache

    if not is_mrpeasy_live(organization):
        return []
    cleaned = (search or "").strip()
    cache_key = _list_cache_key(organization, cleaned)
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        config = _decode_config(organization.mrpeasy_config or {})
        client = get_client(config)
        items = client.list_items(limit=limit, search=cleaned or None)
    except (
        MrpeasyAuthFailed,
        MrpeasyUnreachable,
        MrpeasyRateLimited,
        MrpeasyInvalidConfig,
        MrpeasyDecryptionFailed,
    ):
        cache.set(cache_key, [], timeout=30)
        return []
    cache.set(cache_key, items, timeout=_LIST_CACHE_TTL_SECONDS)
    return items
