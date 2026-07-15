"""PSP integration client + config service.

PSP is Vita's own production platform (Phoenix + Elixir). NPD reads
items from it via a machine-to-machine bearer-token API at
``/api/integration/*``. Two consumer surfaces care about this
integration:

1. The formulation builder's ingredient pickers (raw materials,
   packaging, sub-categories via ``attributes.use_as``).
2. The proposal / spec-sheet price-hint UI (surfaces PSP's list
   price so sales doesn't have to type it by hand).

Both paths silently degrade on any failure: if PSP is unreachable,
mis-configured, or has no matching row, the caller renders "no PSP
price" / "no matches" the same way it would for MRPEasy. An outage
must never block the operator's ability to type a value manually.

The config lives on ``Organization.psp_config`` (JSONField):

.. code-block:: json

    {
      "enabled": true,
      "base_url": "https://psp.internal",
      "integration_token_ciphertext": "<fernet ciphertext>",
      "last_tested_at": "2026-07-14T12:00:00Z"
    }

Empty dict = integration disabled. The raw integration token is
minted on the PSP side and pasted into the NPD settings tab once —
Fernet-encrypted at rest, never round-tripped in the API read shape.
Callers touch this module through the typed ``PspConfig`` dataclass
rather than reaching into the JSON directly, so a future schema
tweak (e.g. optional per-env base URL, cached scopes) doesn't ripple
into every call site.

Mutual exclusion with MRPEasy is enforced here — enabling PSP
clears any live MRPEasy config, and vice versa. Both live at once
would create ambiguous "which price wins" behaviour on the shared
consumer paths, so the settings surface picks one lane.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.parse
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PspItem:
    """Projection of one PSP ``Item`` row over the fields NPD's
    consumers actually read.

    PSP's response carries more (compliance status, storage tags,
    default packaging JSON, etc.); we deliberately narrow to the
    picker + price-hint contract so a future PSP-side schema
    reshuffle stays a one-file update on the mapper.

    ``use_as`` mirrors the local-catalogues convention verbatim —
    NPD's ingredient pickers filter by this vocabulary
    (flavouring / colour / sweetener / gummy_base / …). Null when
    the PSP row has no such attribute set.

    ``selling_price`` is nullable because PSP returns null when the
    company has no active default pricelist OR the item has no row
    on it. NPD's price hint renders "no PSP match" in both cases
    identically.
    """

    uuid: str
    name: str
    description: str
    item_type: str
    external_sku: str
    #: System-generated display code (``MA00295``), rendered PSP-side
    #: from the item's integer PK against the company's numbering
    #: format. Every PSP item has one — this is what PSP's own UI
    #: prints as "Code" and what NPD's BOM shows for procurement.
    #: Empty string when PSP has no numbering format configured (the
    #: mirror falls back to ``external_sku`` in that case).
    code: str
    barcode: str
    is_active: bool
    use_as: str | None
    product_family_uuid: str | None
    product_family_name: str | None
    selling_price: Decimal | None
    currency_code: str | None
    #: Full PSP attributes map as returned on the wire. Carries the
    #: compute-critical keys the mirror needs (``purity``,
    #: ``overage``, ``extract_ratio``, allergen flags, country of
    #: origin, ...). ``use_as`` above is the load-bearing picker
    #: discriminator, so we keep it as its own field for backward-
    #: compat with early caller code — but every other attribute
    #: flows through this dict on the mirror path.
    attributes: dict


@dataclass(frozen=True)
class PspConfig:
    """In-memory view of an org's PSP integration config.

    Constructed by :func:`get_psp_config` from the JSON blob on
    ``Organization.psp_config``. The plaintext token lives on this
    dataclass and NEVER escapes the boundary — the API read shape
    projects to a ``has_token`` boolean instead.
    """

    enabled: bool
    base_url: str
    integration_token: str

    @property
    def is_complete(self) -> bool:
        """True when every required field has a non-empty value.

        Callers gate on this rather than eyeballing individual
        columns so a future addition (e.g. an optional scope list)
        stays a one-file update.
        """

        return bool(
            self.enabled and self.base_url and self.integration_token
        )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class PspError(Exception):
    """Base class for every PSP-side failure.

    The service layer catches the base class to silently degrade
    the picker / price hint; the API layer catches specific
    subclasses to map onto distinct settings-page UI states.
    """


class PspAuthFailed(PspError):
    code = "psp_auth_failed"


class PspUnreachable(PspError):
    code = "psp_unreachable"


class PspRateLimited(PspError):
    code = "psp_rate_limited"


class PspInvalidConfig(PspError):
    code = "psp_invalid_config"


class PspNotConfigured(Exception):
    """The org has no usable PSP config (missing fields, or the
    integration is disabled). The API layer maps this to a 400 so
    the settings page can render a "set up PSP first" hint."""

    code = "psp_not_configured"


class PspDecryptionFailed(Exception):
    """Stored ciphertext could not be decrypted (typically because
    the shared secret key was rotated without re-encrypting)."""

    code = "psp_decryption_failed"


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


#: Hard ceiling on a single PSP round-trip. The picker fires inline
#: during a modal open — anything longer than 4 seconds stalls the
#: operator more than the "no PSP match" fallback would. Matches the
#: MRPEasy ceiling for consistency.
_PSP_TIMEOUT_SECONDS = 4.0


class PspClient:
    """HTTP client for PSP's ``/api/integration/*`` surface.

    Stdlib ``urllib`` (no third-party HTTP dependency) — the request
    shape is small and matches the same pattern the MRPEasy client
    uses. Bearer auth via the ``X-Integration-Token`` header,
    matching PSP's :class:`RequireIntegrationAuth` plug.

    Every method raises typed exceptions on failure. Callers that
    want silent degradation catch :class:`PspError` and treat it
    as "no match".
    """

    def __init__(self, config: PspConfig) -> None:
        if not config.is_complete:
            raise PspInvalidConfig(
                "PspClient requires a complete config."
            )
        self._config = config
        self._auth_header = config.integration_token

    def _request(
        self,
        path: str,
        query: dict[str, str] | None = None,
        *,
        method: str = "GET",
        body: dict | None = None,
    ) -> Any:
        base = self._config.base_url.rstrip("/")
        url = f"{base}/{path.lstrip('/')}"
        if query:
            # Filter out None / empty-string values so URLs stay
            # tidy and PSP's own defensive trim on server-side
            # doesn't have to handle empty ``?search=`` strings.
            cleaned = {
                k: v for k, v in query.items() if v not in (None, "")
            }
            if cleaned:
                url = f"{url}?{urllib.parse.urlencode(cleaned)}"
        headers = {
            "Accept": "application/json",
            "X-Integration-Token": self._auth_header,
            "User-Agent": "VitaNPD/1.0",
        }
        data: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        req = Request(url, method=method, headers=headers, data=data)
        try:
            with urlopen(req, timeout=_PSP_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except HTTPError as exc:
            if exc.code in (401, 403):
                raise PspAuthFailed(
                    f"PSP rejected the credentials (HTTP {exc.code})."
                ) from exc
            if exc.code == 429:
                raise PspRateLimited(
                    "PSP rate limit reached. Retry shortly."
                ) from exc
            if exc.code == 404:
                # 404 from PSP on a picker path is data, not error —
                # the caller decides whether to surface "no match" or
                # re-raise (single-item lookup wants to distinguish).
                # Return None; callers that want the exception can
                # wrap with :meth:`get_item`.
                return None
            raise PspUnreachable(
                f"PSP returned HTTP {exc.code}."
            ) from exc
        except URLError as exc:
            raise PspUnreachable(
                f"Couldn't reach PSP: {exc.reason}"
            ) from exc
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise PspUnreachable(
                "PSP returned a non-JSON response body."
            ) from exc

    def test_connection(self) -> None:
        """Round-trip against the health endpoint. Any success
        response confirms auth. Any typed exception bubbles."""

        payload = self._request("api/integration/health")
        if not isinstance(payload, dict) or not payload.get("ok"):
            raise PspAuthFailed(
                "PSP health endpoint didn't confirm ok=true."
            )

    def list_items(
        self,
        *,
        search: str | None = None,
        item_types: list[str] | None = None,
        use_as: str | None = None,
    ) -> list[PspItem]:
        """List PSP items. Server-side filters via query string.

        Empty result set (any of "no PSP items", "search matched
        nothing", "typed exception") is normalised to an empty list
        — the caller renders "no matches" identically for every
        empty-list source.
        """

        query: dict[str, str] = {}
        if search:
            query["search"] = search
        if item_types:
            query["item_types"] = ",".join(item_types)
        if use_as:
            query["use_as"] = use_as
        payload = self._request("api/integration/items", query=query)
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [_project_item(row) for row in rows if isinstance(row, dict)]

    def get_item(self, uuid: Any) -> PspItem | None:
        """Look up a single PSP item by UUID. ``None`` when PSP has
        no such row (404 from the server, or unexpected shape).
        Errors still raise :class:`PspError` subclasses.

        Accepts a string OR a :class:`uuid.UUID`. Django's URL
        converters produce UUID objects from ``<uuid:...>`` path
        params, so the mirror view hands us one of those directly;
        the picker code path threads strings through. Coercing here
        (rather than at every caller) keeps the client's contract
        forgiving.
        """

        cleaned = str(uuid or "").strip()
        if not cleaned:
            return None
        payload = self._request(f"api/integration/items/{cleaned}")
        if not isinstance(payload, dict):
            return None
        row = payload.get("item")
        if not isinstance(row, dict):
            return None
        return _project_item(row)

    def put_bom(self, item_uuid: Any, payload: dict) -> dict | None:
        """Push a BOM snapshot onto a PSP finished-product item.

        Called by :func:`push_bom_to_psp` after every formulation
        save. PSP appends a new ``bom_version`` row so the version
        history stays intact — this endpoint is idempotent from a
        versioning POV, not from a "create vs update" POV.

        Returns PSP's response payload (``{"bom": {"uuid": ...,
        "version_no": N}}``) or ``None`` when the round-trip fails
        with a soft error (empty body, unexpected shape). Hard
        failures (auth, rate limit, network) bubble as
        :class:`PspError` subclasses so the caller can decide to
        log-and-continue vs surface.
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/items/{cleaned}/bom",
            method="PUT",
            body=payload,
        )
        if not isinstance(response, dict):
            return None
        return response


def _project_item(row: dict[str, Any]) -> PspItem:
    """Map a PSP JSON row onto the local :class:`PspItem` dataclass.

    Defensive against string vs numeric ``selling_price`` and
    against missing optional keys — a partial response mustn't
    crash the picker. Missing / unparseable fields degrade to their
    safe defaults.
    """

    raw_price = row.get("selling_price")
    selling_price: Decimal | None = None
    if raw_price is not None and raw_price != "":
        try:
            selling_price = Decimal(str(raw_price))
        except (InvalidOperation, ValueError):
            selling_price = None
    product_family = row.get("product_family") or {}
    if not isinstance(product_family, dict):
        product_family = {}
    return PspItem(
        uuid=str(row.get("uuid") or ""),
        name=str(row.get("name") or ""),
        description=str(row.get("description") or ""),
        item_type=str(row.get("item_type") or ""),
        external_sku=str(row.get("external_sku") or ""),
        # PSP started emitting ``code`` on the integration wire in
        # ``feat(integration): expose system code on /items``. Older
        # PSP builds don't send it — degrade to empty string so the
        # mirror falls back to ``external_sku`` (still preserves
        # legacy behaviour on stale servers).
        code=str(row.get("code") or ""),
        barcode=str(row.get("barcode") or ""),
        is_active=bool(row.get("is_active", True)),
        use_as=(
            str(row.get("use_as")) if row.get("use_as") else None
        ),
        product_family_uuid=(
            str(product_family.get("uuid"))
            if product_family.get("uuid")
            else None
        ),
        product_family_name=(
            str(product_family.get("name"))
            if product_family.get("name")
            else None
        ),
        selling_price=selling_price,
        currency_code=(
            str(row.get("currency_code"))
            if row.get("currency_code")
            else None
        ),
        # Full attributes map — PSP started returning this on
        # 2026-07 to unblock NPD's compute path. Missing / non-dict
        # payloads degrade to ``{}`` so an older PSP that predates
        # the addition (or a defensive test double) doesn't crash
        # the mapper.
        attributes=(
            dict(row["attributes"])
            if isinstance(row.get("attributes"), dict)
            else {}
        ),
    )


# ---------------------------------------------------------------------------
# Config service
# ---------------------------------------------------------------------------


def is_psp_live(organization: Any) -> bool:
    """Return True when the org has an actually-usable PSP config
    (``enabled`` AND base URL AND token stored).

    Single source of truth for every "is PSP on?" branch — the
    organization serializer's ``psp_live`` flag, the mutual-exclusion
    guard on the MRPEasy setter, and the eventual picker branches
    all read from here.
    """

    raw = (organization.psp_config or {}) if organization else {}
    return bool(
        raw.get("enabled")
        and raw.get("base_url")
        and raw.get("integration_token_ciphertext")
    )


def _decode_config(raw: dict) -> PspConfig:
    """Hydrate the JSONField dict into a typed config (plaintext
    token). Lazy-imports the encryption helpers so a test that
    exercises only the projection doesn't pay the ``cryptography``
    import cost."""

    from apps.organizations.encryption import (
        DecryptionFailed,
        decrypt_secret,
    )

    ciphertext = str(raw.get("integration_token_ciphertext") or "")
    try:
        plaintext = decrypt_secret(ciphertext) if ciphertext else ""
    except DecryptionFailed as exc:
        raise PspDecryptionFailed(str(exc)) from exc
    return PspConfig(
        enabled=bool(raw.get("enabled")),
        base_url=str(raw.get("base_url") or "").rstrip("/"),
        integration_token=plaintext,
    )


def get_psp_config(*, organization: Any) -> PspConfig:
    """Decode + return the org's PSP config (plaintext token).

    Used internally by the client factory. Do NOT return this
    directly from an API endpoint — the wire shape lives in
    :func:`serialize_psp_config_for_api` which redacts the token.
    """

    return _decode_config(organization.psp_config or {})


def serialize_psp_config_for_api(organization: Any) -> dict[str, Any]:
    """Wire shape for ``GET /integrations/psp/``. Mirrors the
    MRPEasy / Dynamics serializers: every field EXCEPT the plaintext
    token, which becomes a boolean ``has_token`` so the form can
    render a "●●●●●●●" placeholder without leaking the value."""

    raw = organization.psp_config or {}
    return {
        "enabled": bool(raw.get("enabled")),
        "base_url": str(raw.get("base_url") or ""),
        # Optional separate host for PSP's Next.js UI. In dev the
        # API (Phoenix) runs on ``:4000`` and the UI (Next.js) on
        # ``:3010``; NPD needs both — the API URL for integration
        # requests, the UI URL for deep-link chips ("Open on PSP").
        # In production the two live on the same origin behind a
        # single nginx reverse proxy, so the operator leaves this
        # blank and the FE falls back to ``base_url``.
        "ui_base_url": str(raw.get("ui_base_url") or ""),
        "has_token": bool(raw.get("integration_token_ciphertext")),
        "last_tested_at": raw.get("last_tested_at") or None,
    }


def set_psp_config(
    *,
    organization: Any,
    actor: Any,
    enabled: bool,
    base_url: str,
    integration_token: str | None,
    ui_base_url: str | None = None,
) -> dict[str, Any]:
    """Persist the org's PSP config.

    Mutual exclusion: enabling PSP with an active MRPEasy config
    on the same org clears the MRPEasy side. The two integrations
    share consumer paths (item pickers, price hints) and having
    both live at once would produce ambiguous "which source wins"
    behaviour. Owner picks one lane on the settings page.

    ``integration_token`` is ``None`` or empty string when the
    operator left the password field blank (the "keep existing
    token" sentinel). In that case we preserve the stored
    ciphertext.
    """

    from django.db import transaction

    from apps.audit.services import record as record_audit, snapshot
    from apps.organizations.encryption import encrypt_secret

    with transaction.atomic():
        before = snapshot(organization)
        existing = organization.psp_config or {}
        ciphertext: str
        if integration_token is None or integration_token == "":
            ciphertext = str(existing.get("integration_token_ciphertext") or "")
        else:
            ciphertext = encrypt_secret(integration_token)

        # ``last_tested_at`` clears whenever the token rotates. A
        # stale "Connected" badge on a rotated token would mislead
        # the operator.
        preserved_last_tested = (
            existing.get("last_tested_at")
            if integration_token is None or integration_token == ""
            else None
        )
        # ``ui_base_url`` is optional. ``None`` → preserve whatever
        # the org already has (matches the "keep existing" pattern
        # the integration_token uses). Empty string → explicit
        # clear. Non-empty → normalise + persist.
        if ui_base_url is None:
            resolved_ui_base_url = str(existing.get("ui_base_url") or "")
        else:
            resolved_ui_base_url = (ui_base_url or "").strip().rstrip("/")

        organization.psp_config = {
            "enabled": bool(enabled),
            "base_url": (base_url or "").strip().rstrip("/"),
            "ui_base_url": resolved_ui_base_url,
            "integration_token_ciphertext": ciphertext,
            "last_tested_at": preserved_last_tested,
        }
        organization.save(update_fields=["psp_config", "updated_at"])
        # Mutual exclusion — enabling PSP clears MRPEasy so the
        # shared consumer paths never see both live at once. The
        # inverse guard lives on the MRPEasy setter symmetrically.
        if bool(enabled) and ciphertext:
            from apps.proposals.mrpeasy import is_mrpeasy_live

            if is_mrpeasy_live(organization):
                from apps.proposals.mrpeasy import clear_mrpeasy_config

                clear_mrpeasy_config(organization=organization, actor=actor)
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.psp.configure",
            target=organization,
            before=before,
            after=snapshot(organization),
        )
    return serialize_psp_config_for_api(organization)


def clear_psp_config(*, organization: Any, actor: Any) -> dict[str, Any]:
    """Wipe the org's PSP config (DELETE endpoint)."""

    from django.db import transaction

    from apps.audit.services import record as record_audit, snapshot

    with transaction.atomic():
        before = snapshot(organization)
        organization.psp_config = {}
        organization.save(update_fields=["psp_config", "updated_at"])
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.psp.clear",
            target=organization,
            before=before,
            after=snapshot(organization),
        )
    return serialize_psp_config_for_api(organization)


def verify_psp_connection(*, organization: Any, actor: Any) -> dict[str, Any]:
    """Validate stored credentials against PSP. Stamps
    ``last_tested_at`` on success. Raises typed exceptions on
    failure so the API layer can map onto specific UI states."""

    from django.db import transaction
    from django.utils import timezone

    if not is_psp_live(organization):
        raise PspNotConfigured("PSP is not configured or is disabled.")

    config = get_psp_config(organization=organization)
    client = _client_factory(config)
    client.test_connection()

    with transaction.atomic():
        existing = organization.psp_config or {}
        existing["last_tested_at"] = (
            timezone.now().isoformat(timespec="seconds")
        )
        organization.psp_config = existing
        organization.save(update_fields=["psp_config", "updated_at"])
    return serialize_psp_config_for_api(organization)


# ---------------------------------------------------------------------------
# High-level consumer helpers (silent-degrading)
# ---------------------------------------------------------------------------


def list_psp_items(
    *,
    organization: Any,
    search: str | None = None,
    item_types: list[str] | None = None,
    use_as: str | None = None,
) -> list[PspItem]:
    """List PSP items for the org. Empty list on any failure —
    the picker's UX never blocks on an integration outage."""

    if not is_psp_live(organization):
        return []
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return []
    try:
        client = _client_factory(config)
        return client.list_items(
            search=search, item_types=item_types, use_as=use_as
        )
    except PspError:
        logger.exception(
            "PSP list_items failed for org %s", organization.pk
        )
        return []


def get_psp_item(*, organization: Any, uuid: str) -> PspItem | None:
    """Single-item lookup. ``None`` on any failure — same silent-
    degrade contract as :func:`list_psp_items`."""

    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    try:
        client = _client_factory(config)
        return client.get_item(uuid)
    except PspError:
        return None


# ---------------------------------------------------------------------------
# BOM push — NPD formulation → PSP finished-product BOM
# ---------------------------------------------------------------------------


def push_bom_to_psp(*, formulation: Any) -> dict | None:
    """Push a formulation's active lines to PSP as a BOM against the
    linked finished-product item. Called after every ``save_version``
    (see :func:`apps.formulations.services.save_version`).

    Silent-degradation contract — no exception ever bubbles to the
    caller. If PSP is down, mis-configured, or the formulation
    isn't linked (``psp_finished_product_uuid IS NULL``), the push
    is skipped and the return value is ``None``. The save flow
    stays functional; PSP-side data catches up on the next successful
    push.

    Scope (MVP):

    * ACTIVE lines only — each ``FormulationLine`` whose ``item`` is
      a mirrored PSP row (``item.psp_source_uuid IS NOT NULL``)
      contributes one BOM line. The line's ``qty`` is
      ``mg_per_serving_cached`` (mg per single serving), stringified
      as a Decimal so PSP's decimal parser accepts it.
    * Excipient picks (capsule shell, MCC carrier, anti-caking,
      etc.) are deferred to a follow-up — the band-level mg splits
      across multiple picks and needs the compute service to
      reproduce that split server-side.
    """

    if not formulation.psp_finished_product_uuid:
        return None

    organization = formulation.organization
    if not is_psp_live(organization):
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP push_bom: config decryption failed for org %s",
            organization.pk,
        )
        return None

    lines: list[dict[str, Any]] = []
    for index, line in enumerate(
        formulation.lines.select_related("item").order_by("display_order")
    ):
        item = line.item
        if not item.psp_source_uuid:
            # Line references a legacy local Item that predates PSP
            # mirror — skip. Without the source uuid PSP can't
            # resolve it to a part. The FE picker + mirror flow
            # guarantees new picks always have this set.
            continue
        qty = line.mg_per_serving_cached
        if qty is None or qty <= 0:
            continue
        lines.append(
            {
                "part_uuid": str(item.psp_source_uuid),
                "qty": str(qty),
                "sort_order": index,
            }
        )

    if not lines:
        # Empty payload — PSP's endpoint bounces with ``empty_lines``,
        # which would spam the logs. Short-circuit here instead.
        return None

    payload = {
        "name": f"{formulation.code} — {formulation.name}",
        "version_notes": f"NPD save at {formulation.updated_at.isoformat()}",
        "lines": lines,
    }

    try:
        client = _client_factory(config)
        response = client.put_bom(
            formulation.psp_finished_product_uuid, payload
        )
        return response
    except PspError:
        logger.exception(
            "PSP push_bom failed for formulation %s (org %s)",
            formulation.pk,
            organization.pk,
        )
        return None


# ---------------------------------------------------------------------------
# Mirror-on-pick — PSP items into local catalogues
# ---------------------------------------------------------------------------


class PspMirrorItemNotFound(Exception):
    """PSP returned no row for the requested UUID (either the item
    was deleted / archived on the PSP side, or the token's company
    scope doesn't include it). The mirror endpoint maps this to a
    404 so the FE picker can render a "picked item is gone —
    refresh the search" hint."""

    code = "psp_mirror_item_not_found"


def mirror_psp_item(
    *,
    organization: Any,
    actor: Any,
    psp_item_uuid: str,
) -> Any:
    """Upsert a PSP integration item into the local ``catalogues``
    table so the formulation builder can attach it to a
    :class:`FormulationLine` through the existing FK.

    Design intent — spelled out because this is the LOAD-BEARING
    piece of the "PSP powers the builder" change:

    * Existing local Items are NEVER touched. Legacy formulations
      that reference them keep working exactly as before.
    * PSP-sourced picks land in a **dedicated** catalogue keyed off
      :data:`PSP_MIRROR_SLUG`. Created lazily on first mirror call
      so orgs without an active PSP integration don't grow it.
    * :attr:`Item.psp_source_uuid` is the upsert key — a re-pick
      of the same PSP item finds the existing local mirror row
      instead of duplicating it. The FormulationLine FK stays
      stable across re-picks so downstream references (spec sheet
      snapshots, audit rows) keep resolving.
    * The mirror is a snapshot, not a live view. If PSP updates
      the item's name / attributes, the local mirror stays frozen
      until someone explicitly re-picks (a follow-up "refresh"
      action can be added when there's actual demand).

    Raises:

    * :class:`PspNotConfigured` — org has no live PSP integration.
      API layer maps to 400.
    * :class:`PspMirrorItemNotFound` — PSP returned no row for
      the UUID. API layer maps to 404.
    * :class:`PspError` subclasses — auth / rate limit / network.
      API layer maps to the same status codes as the picker.

    Returns the local :class:`catalogues.Item` — new or existing.
    The caller passes ``actor`` from ``request.user`` so the audit
    row + created_by / updated_by pointers reflect who triggered
    the mirror.
    """

    from django.db import transaction

    from apps.audit.services import record as record_audit, snapshot
    from apps.catalogues.models import PSP_MIRROR_SLUG, Catalogue, Item

    if not is_psp_live(organization):
        raise PspNotConfigured(
            "PSP is not configured or is disabled on this workspace."
        )

    psp_item = get_psp_item(organization=organization, uuid=psp_item_uuid)
    if psp_item is None:
        raise PspMirrorItemNotFound(
            f"PSP has no item matching UUID {psp_item_uuid}."
        )

    with transaction.atomic():
        catalogue = _get_or_create_mirror_catalogue(
            organization=organization, actor=actor
        )

        existing = Item.objects.filter(
            catalogue=catalogue, psp_source_uuid=psp_item.uuid
        ).first()

        # Attributes mapping — pull the compute-critical values off
        # the PSP row's attribute map. Missing keys stay missing on
        # our side, matching how a manually-authored local Item
        # would look for the same field. ``use_as`` is the crucial
        # discriminator for the builder's ingredient category
        # pickers — without it, downstream filters won't route the
        # item to the right slot.
        source_attrs = (
            psp_item.attributes if hasattr(psp_item, "attributes") else {}
        )
        # ``PspItem`` doesn't carry a nested attributes dict directly;
        # rebuild from the flat fields we captured on the wire.
        attributes = _flatten_psp_attributes(psp_item)

        if existing is not None:
            before = snapshot(existing)
            existing.name = psp_item.name or existing.name
            existing.internal_code = (
                psp_item.code or psp_item.external_sku or existing.internal_code
            )
            existing.attributes = attributes
            if psp_item.selling_price is not None:
                existing.base_price = psp_item.selling_price
            existing.updated_by = actor
            existing.save(
                update_fields=[
                    "name",
                    "internal_code",
                    "attributes",
                    "base_price",
                    "updated_by",
                    "updated_at",
                ]
            )
            record_audit(
                organization=organization,
                actor=actor,
                action="catalogue_item.psp_mirror_refresh",
                target=existing,
                before=before,
                after=snapshot(existing),
            )
            return existing

        item = Item.objects.create(
            catalogue=catalogue,
            psp_source_uuid=psp_item.uuid,
            name=psp_item.name or "",
            # System code (``MA00295``) wins over supplier SKU as
            # the local ``internal_code``, so the BOM's CODE column
            # matches what PSP's own UI prints. Fall back to
            # ``external_sku`` when PSP has no numbering format
            # configured (older backends before PR #48).
            internal_code=psp_item.code or psp_item.external_sku or "",
            unit="",
            base_price=psp_item.selling_price,
            attributes=attributes,
            created_by=actor,
            updated_by=actor,
        )
        record_audit(
            organization=organization,
            actor=actor,
            action="catalogue_item.psp_mirror_create",
            target=item,
            after=snapshot(item),
        )
        return item


def _flatten_psp_attributes(psp_item: PspItem) -> dict:
    """Build the ``Item.attributes`` map for a PSP-mirrored row.

    Base is the full attributes map PSP now returns on the wire —
    that's how compute-critical keys (``purity``, ``overage``,
    ``extract_ratio``, allergen flags, country of origin) reach the
    local mirror. On top of that we overlay:

    * ``use_as`` — kept explicit so its origin is unambiguous even
      if PSP one day drops it from the ``attributes`` payload.
    * ``psp_item_type`` — the PSP-side item type (raw_material /
      packaging / ...); useful for builder filters that already
      look at "is this a raw material" without needing to introspect
      the picker origin.
    * ``description`` / ``barcode`` — top-level fields on the wire,
      not part of ``attributes``. Overlaying keeps them accessible
      through the same map every consumer already reads from.

    Overlays are last-write-wins so a PSP-side ``attributes.barcode``
    (if it ever exists) loses to the top-level ``barcode`` field,
    which is the authoritative source.
    """

    attrs: dict = dict(psp_item.attributes or {})
    if psp_item.use_as:
        attrs["use_as"] = psp_item.use_as
    if psp_item.item_type:
        attrs["psp_item_type"] = psp_item.item_type
    if psp_item.description:
        attrs["description"] = psp_item.description
    if psp_item.barcode:
        attrs["barcode"] = psp_item.barcode
    return attrs


def _get_or_create_mirror_catalogue(*, organization: Any, actor: Any):
    """Return the org's PSP-mirror catalogue, creating it lazily on
    first use so an org without PSP live never grows one."""

    from apps.catalogues.models import PSP_MIRROR_SLUG, Catalogue

    existing = Catalogue.objects.filter(
        organization=organization, slug=PSP_MIRROR_SLUG
    ).first()
    if existing is not None:
        return existing

    return Catalogue.objects.create(
        organization=organization,
        slug=PSP_MIRROR_SLUG,
        name="PSP mirror",
        description=(
            "Auto-populated by the PSP integration. Every row here "
            "is a local snapshot of a PSP item that a scientist "
            "picked in the formulation builder. Do not edit "
            "directly — changes are overwritten on the next "
            "re-pick or refresh."
        ),
        is_system=True,
    )


# ---------------------------------------------------------------------------
# Client factory — swappable for tests
# ---------------------------------------------------------------------------


#: Test hook — when a test sets ``apps.psp.services._TEST_CLIENT``
#: to a callable returning a mock client, the factory routes there
#: instead of hitting the real HTTP path. Preferred over
#: ``unittest.mock.patch`` because it keeps the seam explicit and
#: survives conftest re-imports.
_TEST_CLIENT: Any = None


def _client_factory(config: PspConfig) -> Any:
    """Return the right client for the current environment. Tests
    can set ``_TEST_CLIENT`` to a factory callable to return a mock
    with the same shape."""

    if _TEST_CLIENT is not None:
        return _TEST_CLIENT(config)
    if os.environ.get("PSP_MOCK", "").lower() in {"true", "1", "yes"}:
        return _MockPspClient(config)
    return PspClient(config)


class _MockPspClient:
    """In-memory PSP stand-in for dev + tests. Returns an empty
    catalogue and a passing health check — enough to render the
    settings page + picker flows without hitting a real PSP
    instance."""

    def __init__(self, config: PspConfig) -> None:
        if not config.is_complete:
            raise PspInvalidConfig(
                "PSP mock client requires a complete config."
            )
        self._config = config

    def test_connection(self) -> None:
        return None

    def list_items(
        self,
        *,
        search: str | None = None,
        item_types: list[str] | None = None,
        use_as: str | None = None,
    ) -> list[PspItem]:
        return []

    def get_item(self, uuid: str) -> PspItem | None:
        return None
