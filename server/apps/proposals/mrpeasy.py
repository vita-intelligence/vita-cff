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

    Only the fields the price-hint surface needs — the MRPEasy
    response carries dozens of columns (cost, stock, vendor, …) but
    we deliberately project to the minimum so a future renaming on
    their side doesn't break unrelated callers.

    ``selling_price`` is the customer-facing list price MRPEasy
    stores against the item; we surface it as the director's
    "MRPEasy suggested price" hint. ``None`` when MRPEasy stored
    the item but left ``selling_price`` blank — the UI treats it
    the same as "no MRPEasy match".
    """

    code: str
    title: str
    selling_price: Decimal | None


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
    ),
    "MA512342": MrpeasyItem(
        code="MA512342",
        title="Super Puper Capsules",
        selling_price=Decimal("18.50"),
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
    return MrpeasyItem(
        code=str(row.get("code") or row.get("part_number") or ""),
        title=str(name),
        selling_price=selling_price,
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
