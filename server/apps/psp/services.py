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
import mimetypes
import os
import secrets
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

    def list_workstation_users(self) -> list[dict[str, Any]]:
        """Fetch PSP's operator list for the stage builder's
        workers multi-picker. Returns the raw rows PSP emits —
        ``uuid``, ``name``, ``email``, ``is_admin``. Silent-degrade
        empty on any soft failure so the picker just shows "no
        operators picked yet" identically for a genuinely empty PSP
        catalog and a transient outage.
        """

        payload = self._request("api/integration/users")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def list_units_of_measurement(self) -> list[dict[str, Any]]:
        """PSP UOM catalogue for the org (kg, mg, capsules, bottles…).
        Same silent-degrade contract as ``list_workstation_groups``.
        """

        payload = self._request("api/integration/units-of-measurement")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def list_allergens(self) -> list[dict[str, Any]]:
        """EU 1169 Annex II allergen catalogue (global read-only).
        Silent-degrade contract."""

        payload = self._request("api/integration/allergens")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def list_storage_tags(self) -> list[dict[str, Any]]:
        """Storage tags for the caller's PSP company. Silent-degrade
        contract."""

        payload = self._request("api/integration/storage-tags")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def list_product_families(self) -> list[dict[str, Any]]:
        """PSP product-family catalogue. Same silent-degrade contract
        as ``list_workstation_groups``. Groups items in reports + BOM
        overviews on PSP.
        """

        payload = self._request("api/integration/product-families")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def list_workstation_groups(self) -> list[dict[str, Any]]:
        """Fetch PSP's workstation groups so the NPD stage builder
        can render the "run on" dropdown. Returns the raw rows PSP
        emits (``uuid``, ``name``, ``kind``, ``hourly_rate``,
        ``color``, ``default_operation_notes``). Empty list on any
        soft error — the FE renders "no workstations yet" the same
        way as a genuinely empty PSP catalog.
        """

        payload = self._request("api/integration/workstation-groups")
        if not isinstance(payload, dict):
            return []
        rows = payload.get("items")
        if not isinstance(rows, list):
            return []
        return [row for row in rows if isinstance(row, dict)]

    def create_item(
        self,
        *,
        name: str,
        item_type: str,
        external_sku: str,
        description: str = "",
        attributes: dict | None = None,
        barcode: str = "",
        stock_uom_uuid: str | None = None,
        product_family_uuid: str | None = None,
        finished_product_spec: dict | None = None,
        storage_tags: list[str] | None = None,
        min_stock_qty: Any = None,
        target_stock_qty: Any = None,
        allergen_uuids: list[str] | None = None,
    ) -> dict | None:
        """Idempotently create a catalog Item on PSP. Restricted to
        ``semi_finished`` + ``finished_product`` server-side. The
        push cascade uses this to auto-materialise one PSP semi-
        finished item per non-terminal stage — ``external_sku``
        (typically ``NPD-STAGE-<formulation_uuid>-<sort_order>``) is
        the load-bearing idempotency key, so a re-push after an
        interrupted save doesn't spawn a duplicate row.

        ``attributes`` is a JSON bag PSP stores on the row's
        ``attributes`` column (same shape scientists edit on PSP's own
        item form — ``use_as``, ``capsule_size``, etc.). ``barcode``
        lands on PSP's ``barcode`` column and drives goods-in
        scanning. Both are optional; empty falls back to whatever the
        existing PSP row carries.

        Returns PSP's ``{"uuid", "name", "item_type", "external_sku",
        "created", ...}`` payload on 200 / 201, or ``None`` on soft
        failure. Hard failures bubble as :class:`PspError` subclasses.
        """

        body: dict[str, Any] = {
            "name": name,
            "item_type": item_type,
            "external_sku": external_sku,
            "description": description,
        }
        if attributes:
            body["attributes"] = attributes
        if barcode:
            body["barcode"] = barcode
        if stock_uom_uuid:
            body["stock_uom_uuid"] = str(stock_uom_uuid)
        if product_family_uuid:
            body["product_family_uuid"] = str(product_family_uuid)
        if finished_product_spec:
            # Only meaningful when ``item_type == "finished_product"``;
            # PSP silently ignores the field on other types so it's
            # safe to send unconditionally from the client side.
            body["finished_product_spec"] = finished_product_spec
        # Phase 4a: warehouse identity + allergens. All nullable; empty
        # lists send explicitly so the operator can clear a value.
        if storage_tags is not None:
            body["storage_tags"] = storage_tags
        if min_stock_qty is not None:
            body["min_stock_qty"] = str(min_stock_qty)
        if target_stock_qty is not None:
            body["target_stock_qty"] = str(target_stock_qty)
        if allergen_uuids is not None:
            body["allergen_uuids"] = [str(u) for u in allergen_uuids]
        response = self._request(
            "api/integration/items",
            method="POST",
            body=body,
        )
        if not isinstance(response, dict):
            return None
        row = response.get("item")
        if not isinstance(row, dict):
            return None
        return row

    def upload_item_image(
        self,
        item_uuid: Any,
        *,
        content: bytes,
        filename: str,
        content_type: str | None = None,
    ) -> dict | None:
        """Push a photo onto a PSP catalog item. Returns the created
        image row (``{uuid, blob_path, caption, ...}``) or ``None`` on
        soft failure. Hard failures bubble as :class:`PspError`
        subclasses.

        NPD callers cache the returned ``uuid`` back onto the local
        ``FormulationPhoto.psp_uuid`` so re-syncs skip pushed rows.
        Requires ``item:files:write`` on the integration token.
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return None
        mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        response = self._multipart_request(
            f"api/integration/items/{cleaned}/images",
            fields=[],
            files=[("file", filename, mime, content)],
        )
        if not isinstance(response, dict):
            return None
        row = response.get("image")
        if not isinstance(row, dict):
            return None
        return row

    def upload_item_file(
        self,
        item_uuid: Any,
        *,
        content: bytes,
        filename: str,
        content_type: str | None = None,
        kind: str = "other",
    ) -> dict | None:
        """Push a compliance file onto a PSP catalog item. Same
        idempotency contract as :meth:`upload_item_image`.
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return None
        mime = content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        response = self._multipart_request(
            f"api/integration/items/{cleaned}/files",
            fields=[("kind", kind)],
            files=[("file", filename, mime, content)],
        )
        if not isinstance(response, dict):
            return None
        row = response.get("file")
        if not isinstance(row, dict):
            return None
        return row

    def delete_item_image(self, item_uuid: Any, image_uuid: Any) -> bool:
        """Best-effort delete on PSP's mirror image row. Returns True
        on 2xx; False (silent-degrade) on any soft failure so the FE
        delete on NPD isn't blocked by an unreachable PSP."""

        item = str(item_uuid or "").strip()
        image = str(image_uuid or "").strip()
        if not (item and image):
            return False
        try:
            self._request(
                f"api/integration/items/{item}/images/{image}",
                method="DELETE",
            )
            return True
        except PspError:
            return False

    def delete_item_file(self, item_uuid: Any, file_uuid: Any) -> bool:
        """Best-effort delete on PSP's mirror file row. Same contract
        as :meth:`delete_item_image`."""

        item = str(item_uuid or "").strip()
        file = str(file_uuid or "").strip()
        if not (item and file):
            return False
        try:
            self._request(
                f"api/integration/items/{item}/files/{file}",
                method="DELETE",
            )
            return True
        except PspError:
            return False

    def _multipart_request(
        self,
        path: str,
        *,
        fields: list[tuple[str, str]],
        files: list[tuple[str, str, str, bytes]],
    ) -> Any:
        """POST a multipart/form-data body via stdlib urllib.

        ``files`` entries are ``(part_name, filename, mime, bytes)``.
        Boundary is generated per request (``secrets.token_hex``) so
        collisions with binary bodies are astronomically unlikely.

        Error handling matches :meth:`_request` — same typed
        exceptions for auth / rate limit / network, same ``None``
        return on empty / malformed responses.
        """

        base = self._config.base_url.rstrip("/")
        url = f"{base}/{path.lstrip('/')}"
        boundary = "----NpdBoundary" + secrets.token_hex(16)
        body = _encode_multipart(boundary, fields, files)
        headers = {
            "Accept": "application/json",
            "X-Integration-Token": self._auth_header,
            "User-Agent": "VitaNPD/1.0",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        }
        req = Request(url, method="POST", headers=headers, data=body)
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

    def put_routing(
        self,
        item_uuid: Any,
        *,
        name: str,
        steps: list[dict[str, Any]],
        notes: str = "",
        other_fixed_cost: str | None = None,
        other_variable_cost: str | None = None,
        other_variable_cost_basis: str | None = None,
    ) -> dict | None:
        """Upsert a routing on a PSP item. PSP keys the upsert by
        ``(item_uuid, name)`` and wholesale-replaces the step list —
        one push carries the whole ordered set.

        Steps are dicts of ``{workstation_group_uuid, sort_order?,
        operation_description?, setup_time_min?, cycle_time_min?,
        fixed_cost?, variable_cost?, capacity?}``.

        The three ``other_*`` args are routing-header overhead —
        fixed + variable costs that aren't tied to a specific step.
        Nil values are dropped from the payload so a re-push that
        omits them doesn't clobber an operator-set value on PSP.

        Returns PSP's response (``{"routing": {"uuid": ...,
        "step_count": N}}``) or ``None`` on soft error.
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return None
        body: dict[str, Any] = {
            "name": name,
            "notes": notes,
            "steps": steps,
        }
        if other_fixed_cost is not None:
            body["other_fixed_cost"] = other_fixed_cost
        if other_variable_cost is not None:
            body["other_variable_cost"] = other_variable_cost
        if other_variable_cost_basis is not None:
            body["other_variable_cost_basis"] = other_variable_cost_basis
        response = self._request(
            f"api/integration/items/{cleaned}/routing",
            method="PUT",
            body=body,
        )
        if not isinstance(response, dict):
            return None
        return response


def _encode_multipart(
    boundary: str,
    fields: list[tuple[str, str]],
    files: list[tuple[str, str, str, bytes]],
) -> bytes:
    """Assemble a multipart/form-data body. Files listed after fields
    so the receiver sees the ``kind`` (for file uploads) before it
    starts streaming bytes — Phoenix's parser tolerates any order, but
    the fixture output stays deterministic for tests."""

    lines: list[bytes] = []
    bnd = boundary.encode("ascii")
    for name, value in fields:
        lines.append(b"--" + bnd)
        lines.append(
            f'Content-Disposition: form-data; name="{name}"'.encode("utf-8")
        )
        lines.append(b"")
        lines.append(str(value).encode("utf-8"))
    for name, filename, mime, content in files:
        lines.append(b"--" + bnd)
        lines.append(
            f'Content-Disposition: form-data; name="{name}"; '
            f'filename="{filename}"'.encode("utf-8")
        )
        lines.append(f"Content-Type: {mime}".encode("utf-8"))
        lines.append(b"")
        lines.append(content)
    lines.append(b"--" + bnd + b"--")
    lines.append(b"")
    return b"\r\n".join(lines)


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


def list_psp_workstation_users(*, organization: Any) -> list[dict[str, Any]]:
    """Fetch PSP's operator list for the stage builder's workers
    multi-picker. Empty on any soft failure — the FE renders "no
    workers on PSP" identically for a real outage and a truly
    empty PSP catalog."""

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
        return client.list_workstation_users()
    except PspError:
        logger.exception(
            "PSP list_workstation_users failed for org %s", organization.pk
        )
        return []


def list_psp_units_of_measurement(
    *, organization: Any
) -> list[dict[str, Any]]:
    """Fetch PSP's UOM catalogue. Empty list on any failure — same
    silent-degrade contract as :func:`list_psp_workstation_groups`."""

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
        return client.list_units_of_measurement()
    except PspError:
        logger.exception(
            "PSP list_units_of_measurement failed for org %s",
            organization.pk,
        )
        return []


def list_psp_allergens(*, organization: Any) -> list[dict[str, Any]]:
    """PSP allergen catalogue. Silent-degrade contract."""

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
        return client.list_allergens()
    except PspError:
        logger.exception(
            "PSP list_allergens failed for org %s", organization.pk
        )
        return []


def list_psp_storage_tags(*, organization: Any) -> list[dict[str, Any]]:
    """PSP storage-tag catalogue. Silent-degrade contract."""

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
        return client.list_storage_tags()
    except PspError:
        logger.exception(
            "PSP list_storage_tags failed for org %s", organization.pk
        )
        return []


def list_psp_product_families(*, organization: Any) -> list[dict[str, Any]]:
    """Fetch PSP's product-family catalogue. Same silent-degrade
    contract as :func:`list_psp_workstation_groups`."""

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
        return client.list_product_families()
    except PspError:
        logger.exception(
            "PSP list_product_families failed for org %s", organization.pk
        )
        return []


def list_psp_workstation_groups(*, organization: Any) -> list[dict[str, Any]]:
    """Fetch PSP's workstation groups for the org. Empty list on any
    failure — the FE stage builder renders "no workstations picked
    yet" the same way for a genuinely empty PSP catalog and a soft
    outage."""

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
        return client.list_workstation_groups()
    except PspError:
        logger.exception(
            "PSP list_workstation_groups failed for org %s", organization.pk
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
    """Push a formulation's stage graph to PSP as a cascade of BOMs
    + Routings. Called after every ``save_version``.

    Silent-degradation contract — no exception ever bubbles to the
    caller. If PSP is down, mis-configured, or the formulation
    isn't linked (``psp_finished_product_uuid IS NULL``), the push
    is skipped and the return value is ``None``.

    Cascade shape (one round-trip per stage per BOM + one per
    routing, all inside a single push):

    * Non-terminal stages — each becomes its own semi-finished
      Item on PSP. On the first push NPD creates the item via
      ``POST /items`` (idempotency key: ``external_sku =
      NPD-STAGE-<formulation_uuid>-<sort_order>``), caches the
      returned UUID onto :attr:`FormulationStage.psp_semi_finished_uuid`,
      and pushes a BOM listing that stage's raw-material lines
      **plus** a link to the prior stage's semi-finished item
      (qty = 1) so the multi-level structure resolves. Then pushes
      a single-step Routing anchored at the stage's workstation
      group.

    * Terminal stage — its output IS the finished product on PSP
      (:attr:`Formulation.psp_finished_product_uuid`). BOM = the
      stage's own raw-material lines + the prior stage's semi-
      finished output; Routing = one step on the stage's
      workstation.

    * No-stages fallback — a formulation that predates the stages
      model (or a dosage form with no default template — liquid,
      other-solid) still pushes ONE flat BOM against the finished-
      product item, matching the pre-stages behaviour. Ensures
      legacy formulations keep syncing without a manual migration.

    Excipient / band picks stay deferred (same MVP scope as before —
    the band-level mg splits need the compute service to reproduce
    server-side).
    """

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

    try:
        client = _client_factory(config)
    except PspInvalidConfig:
        logger.exception(
            "PSP push_bom: invalid config for org %s", organization.pk
        )
        return None

    # Auto-create the finished-product PSP item the first time we
    # push. Historically the operator had to hand-pick it through the
    # finished-product picker before any save-version push would work;
    # that gate silently swallowed pushes for formulations the
    # operator hadn't linked yet. Same idempotency mechanism the
    # semi-finished stages use (external_sku key) so a re-run doesn't
    # duplicate.
    if not formulation.psp_finished_product_uuid:
        finished_uuid = _ensure_finished_product(
            client=client, formulation=formulation
        )
        if finished_uuid is None:
            return None

    stages = list(formulation.stages.order_by("sort_order"))

    try:
        if not stages:
            return _push_flat_bom(client=client, formulation=formulation)
        return _push_staged_cascade(
            client=client, formulation=formulation, stages=stages
        )
    except PspError:
        logger.exception(
            "PSP push_bom failed for formulation %s (org %s)",
            formulation.pk,
            organization.pk,
        )
        return None


def _lines_for_stage(formulation: Any, stage_id: Any) -> list[Any]:
    """Return the formulation's PSP-mirrored lines assigned to
    ``stage_id`` (or, when ``stage_id is None``, the legacy "no
    stage" bucket that flows into the terminal stage by default).
    """

    query = formulation.lines.select_related("item")
    if stage_id is None:
        query = query.filter(stage__isnull=True)
    else:
        query = query.filter(stage_id=stage_id)
    return list(query.order_by("display_order"))


def _bom_lines_from(items: list[Any], *, start_index: int = 0) -> list[dict[str, Any]]:
    """Project a list of ``FormulationLine`` rows into the PSP BOM
    line shape. Skips rows whose local Item has no ``psp_source_uuid``
    (legacy pre-mirror items) or whose cached serving weight is
    non-positive (a compute glitch we don't want to propagate)."""

    out: list[dict[str, Any]] = []
    for offset, line in enumerate(items):
        item = line.item
        if item is None or not getattr(item, "psp_source_uuid", None):
            continue
        qty = line.mg_per_serving_cached
        if qty is None or qty <= 0:
            continue
        out.append(
            {
                "part_uuid": str(item.psp_source_uuid),
                "qty": str(qty),
                "sort_order": start_index + offset,
            }
        )
    return out


def _push_flat_bom(*, client: PspClient, formulation: Any) -> dict | None:
    """Legacy path: one flat BOM against the finished-product item.
    Kept as the fallback for formulations that don't yet have a
    stage graph (dosage forms with no default template, or rows
    created before phase 2 landed)."""

    lines = _bom_lines_from(_lines_for_stage(formulation, stage_id=None))
    all_lines = _bom_lines_from(
        list(
            formulation.lines.select_related("item").order_by("display_order")
        )
    )
    # A formulation with NULL-stage lines + no stages carries the
    # same set both ways; keeping ``all_lines`` as the source of
    # truth avoids double-counting.
    payload_lines = all_lines or lines
    if not payload_lines:
        return None

    payload = {
        "name": f"{formulation.code} — {formulation.name}",
        "version_notes": f"NPD save at {formulation.updated_at.isoformat()}",
        "lines": payload_lines,
    }
    return client.put_bom(formulation.psp_finished_product_uuid, payload)


def _push_staged_cascade(
    *,
    client: PspClient,
    formulation: Any,
    stages: list[Any],
) -> dict | None:
    """Walk stages in ``sort_order`` and push one BOM + one Routing
    per stage. Each stage's ``psp_item_type`` decides whether it
    manifests on PSP as a semi-finished intermediate or as the
    formulation's finished-product item. Exactly one
    ``finished_product`` stage per formulation is enforced at
    save-formulation-stages time; if a legacy formulation somehow
    slips through with zero (all-semi) we fall back to treating the
    last stage as finished so the cascade still terminates in a
    finished product.

    Returns the finished-product BOM response so callers can log the
    final version number. Intermediate responses are captured on
    exception context but not returned.
    """

    # Terminal-stage detection: prefer the explicit type flag, fall
    # back to sort_order when no stage carries it (legacy safety net).
    finished_stage = next(
        (s for s in stages if s.psp_item_type == "finished_product"),
        stages[-1],
    )
    previous_semi_uuid: str | None = None
    last_response: dict | None = None

    for stage in stages:
        is_finished = stage.id == finished_stage.id
        # Finished-product stages bind to the formulation's
        # ``psp_finished_product_uuid`` (auto-created by
        # ``_ensure_finished_product``). Semi-finished stages get their
        # own per-stage uuid via ``_ensure_semi_finished``.
        if is_finished:
            output_uuid = _ensure_finished_product(
                client=client, formulation=formulation, stage=stage
            )
            if output_uuid is None:
                logger.warning(
                    "PSP push_bom: finished stage %s produced no uuid;"
                    " aborting cascade for formulation %s",
                    stage.id,
                    formulation.pk,
                )
                return last_response
        else:
            output_uuid = _ensure_semi_finished(
                client=client, formulation=formulation, stage=stage
            )
            if output_uuid is None:
                logger.warning(
                    "PSP push_bom: stage %s produced no semi-finished uuid;"
                    " aborting cascade for formulation %s",
                    stage.id,
                    formulation.pk,
                )
                return last_response

        # BOM lines = raw-material picks assigned to this stage
        # (+ any legacy null-stage lines when this is the finished
        # stage — they flow into the finished product by default).
        assigned = _lines_for_stage(formulation, stage_id=stage.id)
        if is_finished:
            assigned = assigned + _lines_for_stage(formulation, stage_id=None)
        bom_lines = _bom_lines_from(assigned)

        # Every stage after the first consumes the prior stage's
        # semi-finished output at qty = 1 (one serving worth of
        # blend feeds forward). Prepend so the FE + audit rows see
        # the semi-finished dependency at the top of the BOM.
        if previous_semi_uuid is not None:
            bom_lines = [
                {
                    "part_uuid": previous_semi_uuid,
                    "qty": "1",
                    "sort_order": -1,
                }
            ] + bom_lines
            # Renumber sort_order so PSP's storage stays dense.
            for i, row in enumerate(bom_lines):
                row["sort_order"] = i

        # Skip stages with nothing to push — mostly relevant for
        # non-terminal stages that carry no lines yet (operator
        # hasn't assigned actives to that stage). The routing
        # still gets pushed so the workstation reservation exists.
        stage_label = stage.name or f"Stage {stage.sort_order + 1}"
        bom_name = f"{formulation.code} — {stage_label}"

        if bom_lines:
            payload = {
                "name": bom_name,
                "version_notes": (
                    f"NPD stage push at {formulation.updated_at.isoformat()}"
                ),
                "lines": bom_lines,
            }
            response = client.put_bom(output_uuid, payload)
            if response is not None:
                last_response = response

        # Routing = one step for this stage's workstation. Skip
        # when the stage has no workstation picked yet — pushing
        # an empty-workstation routing would 422.
        if stage.workstation_group_uuid:
            _stringify_decimal = (
                lambda v: str(v) if v is not None else None  # noqa: E731
            )
            client.put_routing(
                output_uuid,
                name=f"{formulation.code} — {stage_label} Routing",
                other_fixed_cost=_stringify_decimal(stage.other_fixed_cost),
                other_variable_cost=_stringify_decimal(
                    stage.other_variable_cost
                ),
                other_variable_cost_basis=_stringify_decimal(
                    stage.other_variable_cost_basis
                ),
                steps=[
                    {
                        "workstation_group_uuid": str(stage.workstation_group_uuid),
                        "sort_order": 0,
                        # Prefer the operator-authored description;
                        # fall back to the stage label so shop-floor
                        # cards always have something meaningful.
                        "operation_description": (
                            (stage.operation_description or "").strip()
                            or stage_label
                        ),
                        "setup_time_min": _stringify_decimal(
                            stage.setup_time_min
                        ),
                        "cycle_time_min": _stringify_decimal(
                            stage.cycle_time_min
                        ),
                        "fixed_cost": _stringify_decimal(stage.fixed_cost),
                        "variable_cost": _stringify_decimal(
                            stage.variable_cost
                        ),
                        "capacity": _stringify_decimal(stage.capacity),
                        "default_worker_uuids": list(
                            stage.worker_psp_uuids or []
                        ),
                    }
                ],
            )

        previous_semi_uuid = output_uuid if not is_finished else None

    return last_response


def _ensure_semi_finished(
    *, client: PspClient, formulation: Any, stage: Any
) -> str | None:
    """Return the PSP semi-finished item UUID for a non-terminal
    stage, creating it on the first push and syncing name changes on
    every subsequent push.

    Idempotency: ``external_sku = NPD-STAGE-<formulation_id>-<sort_order>``.
    PSP's ``POST /items`` returns the existing row when the sku is
    already present AND updates its ``name`` / ``description`` fields
    to match the payload — so a stage rename in NPD propagates to
    PSP on the next push without needing a separate ``PATCH`` call.
    The returned UUID is cached back onto
    :attr:`FormulationStage.psp_semi_finished_uuid` so we know we've
    seen it, but we still ``POST`` on repeat pushes so a rename can
    take effect. Net cost: one extra HTTP call per stage per save
    (typical formulation = 3-5 stages, save-version is user-
    initiated → not a hot path).
    """

    # Scientist-supplied identity wins; fall back to auto-derived
    # values so legacy stages keep syncing without an operator touch.
    external_sku = (
        stage.psp_item_external_sku
        or f"NPD-STAGE-{formulation.id}-{stage.sort_order}"
    )
    # Scientist-typed override wins over the auto-derived label.
    name = stage.psp_item_name or (
        f"{formulation.code} — {stage.name or f'Stage {stage.sort_order + 1}'}"
    )
    description = stage.psp_item_description or (
        f"Auto-created by NPD for formulation {formulation.code}"
        f" stage {stage.sort_order + 1}."
    )
    response = client.create_item(
        name=name,
        item_type="semi_finished",
        external_sku=external_sku,
        description=description,
        attributes=stage.psp_item_attributes or None,
        barcode=stage.psp_item_barcode or "",
        stock_uom_uuid=stage.psp_item_stock_uom_uuid,
        product_family_uuid=stage.psp_item_product_family_uuid,
        # Warehouse identity + allergens live at the FORMULATION
        # level. Every stage on a formulation ships with the same
        # storage / reorder / allergen decls, so we forward the
        # same values on every stage — PSP dedupes idempotently.
        storage_tags=list(getattr(formulation, "storage_tags", []) or []),
        min_stock_qty=getattr(formulation, "min_stock_qty", None),
        target_stock_qty=getattr(formulation, "target_stock_qty", None),
        allergen_uuids=list(
            getattr(formulation, "allergen_uuids", []) or []
        ),
    )
    if not response or not response.get("uuid"):
        # Soft failure — return the cached uuid if we have one so the
        # BOM push can still proceed against the last-known item.
        return (
            str(stage.psp_semi_finished_uuid)
            if stage.psp_semi_finished_uuid
            else None
        )
    uuid = str(response["uuid"])

    # Cache on the stage the first time we see the uuid. Save only
    # this field so we don't race with concurrent stage edits.
    if str(stage.psp_semi_finished_uuid or "") != uuid:
        stage.psp_semi_finished_uuid = uuid
        stage.save(update_fields=["psp_semi_finished_uuid", "updated_at"])
    return uuid


def _ensure_finished_product(
    *,
    client: PspClient,
    formulation: Any,
    stage: Any | None = None,
) -> str | None:
    """Return the PSP finished-product item UUID for a formulation,
    creating it on the first push AND syncing its name on every
    subsequent push (so a formulation rename in NPD propagates to
    PSP without a separate PATCH).

    Idempotency: ``external_sku = NPD-FINISHED-<formulation_id>``.
    PSP's ``POST /items`` returns the existing row when the sku
    matches AND updates the row's ``name`` / ``description`` to
    match the payload. The returned UUID is cached on
    :attr:`Formulation.psp_finished_product_uuid` so we know we've
    seen it. See ``_ensure_semi_finished`` for the same rationale on
    the trade-off (one extra HTTP call per push, not a hot path).
    """

    # If the finished-product stage carries scientist-supplied
    # identity, honour it; otherwise auto-derive from the formulation
    # (legacy shape). Semi-finished uses the same pattern in
    # ``_ensure_semi_finished`` above.
    stage_sku = stage.psp_item_external_sku if stage is not None else ""
    stage_description = (
        stage.psp_item_description if stage is not None else ""
    )
    stage_name_override = (
        stage.psp_item_name if stage is not None else ""
    )
    stage_name = (
        stage.name
        if stage is not None and getattr(stage, "name", "")
        else None
    )
    external_sku = stage_sku or f"NPD-FINISHED-{formulation.id}"
    # Scientist-typed PSP name override on the finished stage wins;
    # otherwise fall back to the auto-derived "{code} — {stage}" or
    # the formulation's own name (legacy shape).
    if stage_name_override:
        name = stage_name_override
    elif stage_name:
        name = f"{formulation.code} — {stage_name}"
    else:
        name = formulation.name
    description = stage_description or (
        f"Auto-created by NPD for formulation {formulation.code}"
        " on first BOM push."
    )
    stage_attributes = (
        stage.psp_item_attributes if stage is not None else None
    )
    stage_barcode = stage.psp_item_barcode if stage is not None else ""
    stage_uom_uuid = (
        stage.psp_item_stock_uom_uuid if stage is not None else None
    )
    stage_family_uuid = (
        stage.psp_item_product_family_uuid if stage is not None else None
    )
    # Setup tab is the source of truth for every spec field. Rebuild
    # the spec bag from ``formulation`` on every push; any stage-
    # level ``psp_finished_product_spec`` overrides layer on top
    # (kept as an escape hatch for edge cases — normal flow leaves
    # it empty). Missing formulation values fall through so PSP's
    # existing row keeps whatever it already had.
    stage_spec: dict[str, Any] = {}

    def _put(key: str, value: Any) -> None:
        if value in (None, "", []):
            return
        stage_spec[key] = value

    _put("regulatory_category", getattr(formulation, "regulatory_category", ""))
    _put("dosage_form", getattr(formulation, "dosage_form", ""))
    _put("capsule_size", getattr(formulation, "capsule_size", ""))
    _put("directions_of_use", getattr(formulation, "directions_of_use", ""))
    _put("suggested_dosage", getattr(formulation, "suggested_dosage", ""))
    _put("warnings_text", getattr(formulation, "warnings_text", ""))
    _put("storage_conditions", getattr(formulation, "storage_conditions", ""))
    _put("shelf_life_months", getattr(formulation, "shelf_life_months", None))
    _put("target_markets", list(getattr(formulation, "target_markets", []) or []))
    # Numeric + UOM pairs. PSP resolves the UUIDs to local ids;
    # unknown UUIDs get dropped silently on the PSP side.
    if getattr(formulation, "serving_size", None) is not None:
        _put("serving_size", str(formulation.serving_size))
    if getattr(formulation, "servings_per_pack", None) is not None:
        _put("servings_per_pack", int(formulation.servings_per_pack))
    if getattr(formulation, "net_quantity", None) is not None:
        _put("net_quantity", str(formulation.net_quantity))
    if getattr(formulation, "net_quantity_uom_uuid", None):
        _put(
            "net_quantity_uom_uuid",
            str(formulation.net_quantity_uom_uuid),
        )
    if getattr(formulation, "serving_size_uom_uuid", None):
        _put(
            "serving_size_uom_uuid",
            str(formulation.serving_size_uom_uuid),
        )
    # Phase 4a: may-contain declaration lives on the formulation
    # and rides the same spec push. Empty list / string means no
    # declaration; the changeset accepts both cases.
    if hasattr(formulation, "may_contain_allergen_keys"):
        _put(
            "may_contain_allergens",
            list(formulation.may_contain_allergen_keys or []),
        )
    if getattr(formulation, "may_contain_justification", ""):
        _put(
            "may_contain_justification",
            formulation.may_contain_justification,
        )
    # Stage-level overrides last so a per-stage tweak still wins if
    # someone hand-edited the JSONField for a specific finished stage.
    if stage is not None and stage.psp_finished_product_spec:
        stage_spec.update(stage.psp_finished_product_spec)
    response = client.create_item(
        name=name,
        item_type="finished_product",
        external_sku=external_sku,
        description=description,
        attributes=stage_attributes or None,
        barcode=stage_barcode or "",
        stock_uom_uuid=stage_uom_uuid,
        product_family_uuid=stage_family_uuid,
        finished_product_spec=stage_spec or None,
        # Warehouse + allergens flow from the formulation.
        storage_tags=list(getattr(formulation, "storage_tags", []) or []),
        min_stock_qty=getattr(formulation, "min_stock_qty", None),
        target_stock_qty=getattr(formulation, "target_stock_qty", None),
        allergen_uuids=list(
            getattr(formulation, "allergen_uuids", []) or []
        ),
    )
    if not response or not response.get("uuid"):
        # Soft failure — return the cached uuid if we have one.
        return (
            str(formulation.psp_finished_product_uuid)
            if formulation.psp_finished_product_uuid
            else None
        )
    uuid = str(response["uuid"])

    # Cache on the formulation the first time we see the uuid. Save
    # only this field so we don't race with concurrent metadata edits.
    if str(formulation.psp_finished_product_uuid or "") != uuid:
        formulation.psp_finished_product_uuid = uuid
        formulation.save(
            update_fields=["psp_finished_product_uuid", "updated_at"]
        )

    # Phase 4b: push any un-mirrored photos + files. NPD is source of
    # truth for the bytes; the local ``psp_uuid`` per row is the
    # idempotency marker so re-syncs skip rows PSP already has.
    _push_finished_product_assets(client=client, formulation=formulation, item_uuid=uuid)

    return uuid


def _push_finished_product_assets(
    *,
    client: PspClient,
    formulation: Any,
    item_uuid: str,
) -> None:
    """Best-effort push of formulation photos + files onto the PSP
    finished-product item. Silent-degrade — any failure is logged and
    the cascade continues so a network blip on the photo endpoint
    doesn't fail the whole BOM save.
    """

    # Photos
    for photo in formulation.photos.filter(psp_uuid__isnull=True):
        try:
            with photo.image.open("rb") as fh:
                content = fh.read()
        except (OSError, ValueError):
            logger.warning(
                "PSP push: failed reading FormulationPhoto %s bytes; skipping.",
                photo.id,
            )
            continue
        try:
            response = client.upload_item_image(
                item_uuid,
                content=content,
                filename=photo.original_filename or f"photo-{photo.id}",
                content_type=photo.content_type or None,
            )
        except PspError as exc:
            logger.info("PSP push: image upload soft-failed: %s", exc)
            continue
        if response and response.get("uuid"):
            photo.psp_uuid = str(response["uuid"])
            photo.save(update_fields=["psp_uuid"])

    # Files
    for file_row in formulation.files.filter(psp_uuid__isnull=True):
        try:
            with file_row.file.open("rb") as fh:
                content = fh.read()
        except (OSError, ValueError):
            logger.warning(
                "PSP push: failed reading FormulationFile %s bytes; skipping.",
                file_row.id,
            )
            continue
        try:
            response = client.upload_item_file(
                item_uuid,
                content=content,
                filename=file_row.filename,
                content_type=file_row.mime or None,
                kind=file_row.kind,
            )
        except PspError as exc:
            logger.info("PSP push: file upload soft-failed: %s", exc)
            continue
        if response and response.get("uuid"):
            file_row.psp_uuid = str(response["uuid"])
            file_row.save(update_fields=["psp_uuid"])


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
