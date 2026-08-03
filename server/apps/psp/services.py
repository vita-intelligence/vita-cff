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
    #: EU 1169 Annex II allergens declared on the raw material — a
    #: list of ``{"uuid", "key"}`` dicts projected from the wire's
    #: top-level ``allergens`` list. NPD's Setup tab unions these
    #: across every picked ingredient to auto-derive the finished-
    #: product allergen declaration. Missing / empty list = no
    #: declared allergens on the item.
    allergens: tuple[dict, ...] = ()


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
    #: Optional — the PSP warehouse uuid trial-batch MOs get created
    #: against. Not required for general PSP liveness (search,
    #: pricing, BOM sync all work without it); required for the
    #: trial-batch MO create flow. Kept on the same config blob so
    #: settings management is one page.
    psp_warehouse_uuid: str = ""

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
            # Read the response body so validation errors from PSP
            # (typically 4xx with an ``{error, detail}`` JSON body)
            # actually surface in NPD logs. Without this, downstream
            # PspUnreachable messages are useless "HTTP 422" strings.
            body_snippet = ""
            try:
                body_snippet = (exc.read() or b"").decode("utf-8", errors="replace")[:500]
            except Exception:  # pragma: no cover — defensive
                body_snippet = ""
            raise PspUnreachable(
                f"PSP returned HTTP {exc.code}."
                + (f" Body: {body_snippet}" if body_snippet else "")
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

    def get_item_bom(self, item_uuid: Any) -> dict | None:
        """Fetch the item's active primary BOM (header + lines) from
        PSP so NPD can hydrate a formulation from the recipe of
        record. Returns the raw response dict on 200, ``None`` when
        PSP has the item but no primary BOM (404 → soft ``None``).

        Response shape (per PSP's ``GET
        /api/integration/items/:uuid/bom``):

            {"bom": {"uuid", "name", "notes", "item_uuid",
                     "lines": [{"sort_order", "qty", "is_fixed",
                                "notes", "uom_uuid", "uom_symbol",
                                "part": {<full item shape>}}]}}
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(f"api/integration/items/{cleaned}/bom")
        if not isinstance(response, dict):
            return None
        row = response.get("bom")
        if not isinstance(row, dict):
            return None
        return row

    def suggest_costs(self, item_uuids: list[Any]) -> list[dict]:
        """Bulk cost lookup — powers the vita-cff builder's live cost
        calculator. Ships a POST with ``{item_uuids: [...]}`` and
        returns the ``items`` list from PSP's response.

        Each entry carries ``uuid`` + ``unit_cost`` (string decimal
        or ``None``) + ``currency_code`` + ``uom_symbol`` + ``source``
        (``"po_history" | "purchase_term" | "none"``) + ``vendor_name``.

        Empty input short-circuits with ``[]`` so the caller doesn't
        need to gate the call site. Missing / archived uuids silently
        drop out of the response — the caller diffs input vs returned
        to spot dead references.
        """

        cleaned = [
            str(u).strip()
            for u in (item_uuids or [])
            if u and str(u).strip()
        ]
        if not cleaned:
            return []

        response = self._request(
            "api/integration/items/suggest-costs",
            method="POST",
            body={"item_uuids": cleaned},
        )
        if not isinstance(response, dict):
            return []
        items = response.get("items")
        if not isinstance(items, list):
            return []
        return items

    def workstation_costs(self, wsg_uuids: list[Any]) -> list[dict]:
        """Bulk cost + throughput lookup for workstation groups —
        powers vita-cff's real-time per-unit routing cost estimate.
        Ships a POST with ``{workstation_group_uuids: [...]}`` and
        returns the ``items`` list from PSP's response.

        Each entry carries ``uuid`` + ``name`` + ``machine_hourly_rate``
        (string decimal or ``None``) + ``avg_labour_hourly_rate``
        (string decimal or ``None``) + ``avg_seconds_per_unit`` (string
        decimal or ``None``) + ``session_count`` (int) +
        ``currency_code``. ``None`` on either average means "no session
        history" — caller falls back to the stage's own ``cycle_time_min``
        + ``fixed_cost`` fields.

        Empty input short-circuits with ``[]``. Missing / archived
        uuids silently drop out of the response.
        """

        cleaned = [
            str(u).strip()
            for u in (wsg_uuids or [])
            if u and str(u).strip()
        ]
        if not cleaned:
            return []

        response = self._request(
            "api/integration/workstation-groups/costs",
            method="POST",
            body={"workstation_group_uuids": cleaned},
        )
        if not isinstance(response, dict):
            return []
        items = response.get("items")
        if not isinstance(items, list):
            return []
        return items

    def create_manufacturing_order(
        self,
        *,
        item_uuid: Any,
        warehouse_uuid: Any,
        quantity: Any,
        npd_trial_batch_uuid: Any,
        project_type: str = "trial",
        due_date: Any = None,
        notes: str = "",
    ) -> dict:
        """POST ``/api/integration/manufacturing-orders``.

        Idempotent by ``npd_trial_batch_uuid`` — a retry of the same
        trial batch uuid returns the existing MO (200) rather than
        spawning a duplicate (201). Either way we get back the
        ``manufacturing_order`` object with its uuid + status.

        Raises :class:`PspUnreachable` on any non-2xx, with the PSP
        response body embedded in the exception message so the API
        layer can surface actionable validation errors ("this item
        doesn't exist on PSP", "the target warehouse is missing", …)
        instead of a generic "PSP said no".
        """

        # ``quantity`` may arrive as int / str / Decimal — normalise to
        # a plain string so ``json.dumps`` doesn't choke on Decimal.
        # PSP parses the field with :decimal, so a numeric string round-
        # trips cleanly including fractions (e.g. "0.166667" packs).
        if isinstance(quantity, Decimal):
            quantity_serial: Any = format(quantity, "f")
        else:
            quantity_serial = quantity

        body: dict[str, Any] = {
            "item_uuid": str(item_uuid or "").strip(),
            "warehouse_uuid": str(warehouse_uuid or "").strip(),
            "quantity": quantity_serial,
            "npd_trial_batch_uuid": str(npd_trial_batch_uuid or "").strip(),
            "project_type": project_type or "trial",
            "notes": notes or "",
        }
        if due_date:
            body["due_date"] = str(due_date)

        response = self._request(
            "api/integration/manufacturing-orders",
            method="POST",
            body=body,
        )
        if not isinstance(response, dict):
            raise PspUnreachable(
                "PSP returned no body for MO create."
            )
        mo = response.get("manufacturing_order")
        if not isinstance(mo, dict):
            raise PspUnreachable(
                "PSP returned a create response without a "
                "``manufacturing_order`` object."
            )
        return mo

    def get_manufacturing_order_chain(self, mo_uuid: Any) -> dict | None:
        """GET ``/api/integration/manufacturing-orders/:uuid/chain``.

        Returns the full parent → child MO tree rooted at the trial
        MO. Payload shape (per PSP's controller):

            {"chain": [
              {"uuid", "status", "quantity", "project_type",
               "npd_trial_batch_uuid", "due_date", "inserted_at",
               "parent_uuid", "depth", "is_root",
               "item": {"uuid", "name"}},
              ...
            ]}

        Returns ``None`` on 404 (unknown mo uuid) — NPD's panel treats
        that as "nothing to render yet".
        """

        cleaned = str(mo_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/manufacturing-orders/{cleaned}/chain"
        )
        if not isinstance(response, dict):
            return None
        return response

    def list_rnd_warehouses(self) -> list[dict]:
        """GET ``/api/integration/warehouses``.

        Returns the list of R&D-tagged warehouses for the
        Create-MO-on-PSP dropdown. PSP filters to warehouses that
        have at least one cell (or rack) carrying the reserved
        ``rnd`` stream tag, so the picker only shows warehouses
        actually set up for R&D flow.

        Payload: ``{"warehouses": [{"uuid", "name"}, ...]}``.
        Returns ``[]`` if the org has no R&D-tagged warehouses or
        PSP returned an unexpected shape.
        """

        response = self._request("api/integration/warehouses")
        if not isinstance(response, dict):
            return []
        raw = response.get("warehouses")
        return raw if isinstance(raw, list) else []

    def list_mo_bookings(self, mo_uuid: Any) -> dict | None:
        """GET ``/api/integration/manufacturing-orders/:uuid/bookings``.

        Returns the ``{bookings, summary}`` shape PSP ships so NPD
        can render the "picker at step N/M" indicator on the trial
        batch card. Returns ``None`` on 404 (unknown mo uuid) — the
        UI treats that as "no bookings yet".
        """

        cleaned = str(mo_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/manufacturing-orders/{cleaned}/bookings"
        )
        if not isinstance(response, dict):
            return None
        return response

    def delete_item(self, item_uuid: Any) -> dict:
        """Safe-delete a PSP catalog item. PSP's ``DELETE /items/:uuid``
        gates on ownership + reference count + history and returns:

        * ``200 {"deleted": true, "uuid": "..."}`` — actually deleted.
        * ``404 {"deleted": false, "reason": "not_found", ...}`` — the
          uuid doesn't exist on PSP.
        * ``409 {"deleted": false, "reason": "sku_not_npd_owned" |
                "referenced_by_bom" | "has_history", ...}`` — refused
          because the item isn't safe to remove.

        Returns the parsed body on any of the above so the caller can
        inspect ``deleted`` + ``reason`` without exception handling.
        Auth / rate-limit / network errors still raise the usual
        :class:`PspError` subclasses.
        """

        cleaned = str(item_uuid or "").strip()
        if not cleaned:
            return {"deleted": False, "reason": "invalid_uuid"}

        base = self._config.base_url.rstrip("/")
        url = f"{base}/api/integration/items/{cleaned}"
        headers = {
            "Accept": "application/json",
            "X-Integration-Token": self._auth_header,
            "User-Agent": "VitaNPD/1.0",
        }
        req = Request(url, method="DELETE", headers=headers)
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
            if exc.code in (404, 409):
                # PSP returns a structured refusal body on both — parse
                # it out so the caller sees the reason code instead of
                # a generic "PSP unreachable".
                body_bytes = b""
                try:
                    body_bytes = exc.read() or b""
                except Exception:  # pragma: no cover — defensive
                    body_bytes = b""
                try:
                    parsed = json.loads(body_bytes.decode("utf-8"))
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass
                fallback_reason = "not_found" if exc.code == 404 else "refused"
                return {"deleted": False, "reason": fallback_reason}
            body_snippet = ""
            try:
                body_snippet = (
                    (exc.read() or b"").decode("utf-8", errors="replace")[:500]
                )
            except Exception:  # pragma: no cover — defensive
                body_snippet = ""
            raise PspUnreachable(
                f"PSP returned HTTP {exc.code}."
                + (f" Body: {body_snippet}" if body_snippet else "")
            ) from exc
        except URLError as exc:
            raise PspUnreachable(
                f"Couldn't reach PSP: {exc.reason}"
            ) from exc
        if not raw:
            return {"deleted": True, "reason": "ok"}
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {"deleted": True, "reason": "ok"}
        if isinstance(parsed, dict):
            return parsed
        return {"deleted": True, "reason": "ok"}

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

    def sync_customer_order(self, payload: dict) -> dict | None:
        """Push a formulation-to-CustomerOrder sync payload to PSP.

        Called after every ``save_version`` on NPD. Idempotent on the
        PSP side keyed by ``npd_formulation_uuid`` — first hit creates
        a fresh draft CustomerOrder with ``uuid = npd_formulation_uuid``
        (so the URL matches on both apps); subsequent hits refresh the
        mirrored identity fields without touching operator-owned
        columns like status / customer_id.

        Returns PSP's response body on success (carries
        ``customer_order.uuid`` + ``status``) or ``None`` on soft
        failure. Auth / network / rate-limit failures bubble as
        :class:`PspError` — callers should catch and log-and-continue
        so a slow PSP never blocks a scientist's save.
        """

        response = self._request(
            "api/integration/customer-orders/sync",
            method="POST",
            body=payload,
        )
        if not isinstance(response, dict):
            return None
        return response

    def merge_customer_orders_from_proposal(
        self, payload: dict
    ) -> dict | None:
        """Consolidate N R&D COs on PSP into one when a proposal is
        drafted.

        Fires once per proposal creation (single-spec via
        :func:`create_proposal` and multi-spec via
        :func:`create_proposal_bundle` alike). PSP's ``ProposalMerge``
        picks the first ``npd_formulation_uuid`` as primary, reassigns
        comments + lines from the others, marks them
        ``merged_into_id: primary.id``, and plants the proposal
        identity so the wizard advances to ``:awaiting_signature``.

        Idempotent by ``npd_proposal_uuid`` — a retry after a network
        error refreshes the primary's lines rather than duplicating
        rows.
        """

        response = self._request(
            "api/integration/customer-orders/from-proposal",
            method="POST",
            body=payload,
        )
        if not isinstance(response, dict):
            return None
        return response

    def unmerge_customer_orders_from_proposal(
        self, proposal_uuid: str
    ) -> dict | None:
        """Reverse a proposal-driven CO merge on PSP.

        Fires from :func:`delete_proposal`'s ``on_commit`` when the
        underlying Proposal is deleted on NPD. PSP's
        ``ProposalMerge.unmerge_from_proposal`` fans comments back to
        their home CustomerOrder, clears ``merged_into_id`` on every
        secondary, and wipes the primary's proposal identity + lines
        so each spec's R&D draft reappears in the wizard as it was
        before the merge.

        Idempotent — a re-fire on an already-unmerged proposal_uuid
        returns ``{"no_op": true}`` from PSP rather than erroring.
        """

        response = self._request(
            f"api/integration/customer-orders/from-proposal/{proposal_uuid}",
            method="DELETE",
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

    def list_certificates(self) -> list[dict[str, Any]]:
        """PSP certificate registry — the picker source for NPD's
        Setup Certificates panel. Same silent-degrade contract as
        the other catalog lists. Rows carry ``uuid`` +
        ``default_validity_months`` so the FE can prefill the
        ``valid_until`` field from ``valid_from``.
        """

        payload = self._request("api/integration/certificates")
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
        try:
            response = self._request(
                "api/integration/items",
                method="POST",
                body=body,
            )
        except PspUnreachable as exc:
            # Name-conflict fallback: PSP enforces a unique (company,
            # name) constraint on items. When two NPD formulations
            # try to auto-create the same-named finished product (or a
            # scientist created the PSP item by hand first), the
            # create returns 422 with ``name already exists``. Rather
            # than surface a scary error, look the item up by exact
            # name + item_type and return it — the scientist gets a
            # link to the existing SKU without a manual re-picker
            # step. The 422 body is embedded in the exception message
            # by ``_request``; we probe for the marker substring so
            # the fallback is precise (any other 422 rethrows).
            message = str(exc)
            name_conflict = (
                "name already exists" in message.lower()
                or "duplicate name" in message.lower()
            )
            if not name_conflict:
                raise
            match = self._find_item_by_exact_name(name=name, item_type=item_type)
            if match is None:
                raise
            return match
        if not isinstance(response, dict):
            return None
        row = response.get("item")
        if not isinstance(row, dict):
            return None
        return row

    def _find_item_by_exact_name(
        self, *, name: str, item_type: str
    ) -> dict | None:
        """Look up a PSP item by exact ``name`` (case-insensitive) +
        ``item_type``. Used as the name-conflict fallback in
        :meth:`create_item` so a duplicate-name auto-create resolves
        to a link instead of an error.

        Returns the same shape ``create_item`` normally returns
        (``{uuid, name, item_type, external_sku, code, ...}``) or
        ``None`` when zero exact matches surface.
        """

        needle = (name or "").strip()
        if not needle:
            return None
        try:
            payload = self._request(
                "api/integration/items",
                query={"search": needle, "item_types": item_type},
            )
        except PspError:
            return None
        if not isinstance(payload, dict):
            return None
        rows = payload.get("items")
        if not isinstance(rows, list):
            return None
        cleaned = needle.casefold()
        for row in rows:
            if isinstance(row, dict) and str(row.get("name") or "").casefold() == cleaned:
                # Synthesize the ``created: false`` marker so the
                # caller can log the link vs create split if it wants.
                return {**row, "created": False, "resolved_by_name": True}
        return None

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

    def attach_item_certificate(
        self,
        item_uuid: Any,
        *,
        certificate_uuid: Any,
        certificate_number: str | None = None,
        valid_from: str | None = None,
        valid_until: str | None = None,
    ) -> dict | None:
        """Attach a certificate to an item on PSP. Returns the
        created attachment row (with ``uuid`` = the attachment id)
        or ``None`` on soft failure. Callers cache the returned
        ``uuid`` on ``FormulationCertificate.psp_attachment_uuid``
        so re-syncs skip pushed rows.
        """

        cleaned = str(item_uuid or "").strip()
        cert_uuid_clean = str(certificate_uuid or "").strip()
        if not cleaned or not cert_uuid_clean:
            return None
        body: dict[str, Any] = {"certificate_uuid": cert_uuid_clean}
        if certificate_number:
            body["certificate_number"] = certificate_number
        if valid_from:
            body["valid_from"] = valid_from
        if valid_until:
            body["valid_until"] = valid_until
        response = self._request(
            f"api/integration/items/{cleaned}/certificates",
            method="POST",
            body=body,
        )
        if not isinstance(response, dict):
            return None
        row = response.get("item_certificate")
        if not isinstance(row, dict):
            return None
        return row

    def detach_item_certificate(
        self,
        item_uuid: Any,
        attachment_uuid: Any,
    ) -> bool:
        """Best-effort detach — silent-degrade so a lost cascade
        doesn't block the local FormulationCertificate delete."""

        item = str(item_uuid or "").strip()
        att = str(attachment_uuid or "").strip()
        if not (item and att):
            return False
        try:
            self._request(
                f"api/integration/items/{item}/certificates/{att}",
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
        # Allergens — top-level list on the wire, each row a
        # ``{uuid, key, label, source, sort_order}`` map. We keep
        # only ``uuid`` + ``key`` locally — that's what NPD's
        # derivation service needs to union across ingredients.
        # Non-list / missing degrades to an empty tuple so pre-
        # allergen PSP builds keep parsing.
        allergens=tuple(
            {"uuid": str(a.get("uuid") or ""), "key": str(a.get("key") or "")}
            for a in (row.get("allergens") or [])
            if isinstance(a, dict) and a.get("uuid") and a.get("key")
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
        psp_warehouse_uuid=str(raw.get("psp_warehouse_uuid") or "").strip(),
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
        # Optional target warehouse for trial-batch MO creation. Kept
        # in the same blob so the settings form stays one page; blank
        # is fine — everything except the "Create MO on PSP" action
        # works without it.
        "psp_warehouse_uuid": str(raw.get("psp_warehouse_uuid") or ""),
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
    psp_warehouse_uuid: str | None = None,
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

        # psp_warehouse_uuid follows the same "None = preserve,
        # empty string = clear" convention as ui_base_url. The FE
        # doesn't have to re-send the value on every unrelated toggle.
        if psp_warehouse_uuid is None:
            resolved_warehouse_uuid = str(
                existing.get("psp_warehouse_uuid") or ""
            )
        else:
            resolved_warehouse_uuid = (psp_warehouse_uuid or "").strip()

        organization.psp_config = {
            "enabled": bool(enabled),
            "base_url": (base_url or "").strip().rstrip("/"),
            "ui_base_url": resolved_ui_base_url,
            "integration_token_ciphertext": ciphertext,
            "psp_warehouse_uuid": resolved_warehouse_uuid,
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


def delete_psp_item(*, organization: Any, uuid: str) -> dict:
    """Safe-delete a PSP item on behalf of NPD. Silent-degrade —
    returns a status dict rather than raising so callers (stage-
    delete hooks) never block on PSP being offline.

    Return shape mirrors :meth:`PspClient.delete_item`:

        {"deleted": bool, "reason": "<code>", "uuid": "<uuid>"}

    Additional local skip reasons:

    * ``psp_not_live`` — org has no live PSP integration.
    * ``config_decryption_failed`` — token can't be decrypted.
    * ``client_init_failed`` — config is invalid on our side.
    * ``client_error`` — PSP round-trip failed (auth / network / rate).
    """

    cleaned = str(uuid or "").strip()
    if not cleaned:
        return {"deleted": False, "reason": "invalid_uuid", "uuid": cleaned}
    if not is_psp_live(organization):
        return {"deleted": False, "reason": "psp_not_live", "uuid": cleaned}
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return {
            "deleted": False,
            "reason": "config_decryption_failed",
            "uuid": cleaned,
        }
    try:
        client = _client_factory(config)
    except PspInvalidConfig:
        logger.exception(
            "PSP delete_item: invalid config for org %s", organization.pk
        )
        return {
            "deleted": False,
            "reason": "client_init_failed",
            "uuid": cleaned,
        }
    try:
        result = client.delete_item(cleaned)
    except PspError:
        logger.exception(
            "PSP delete_item failed for org %s item %s",
            organization.pk,
            cleaned,
        )
        return {"deleted": False, "reason": "client_error", "uuid": cleaned}
    if isinstance(result, dict):
        result.setdefault("uuid", cleaned)
        return result
    return {"deleted": False, "reason": "unexpected_response", "uuid": cleaned}


def get_psp_item_bom(*, organization: Any, uuid: str) -> dict | None:
    """Fetch the active primary BOM for a PSP item. Silent-degrade —
    returns ``None`` when PSP is off, mis-configured, the item has
    no BOM, or the round-trip fails. Used by the stage strip so
    each stage card can mirror the item's real recipe on PSP
    rather than a locally-synthesized list."""

    cleaned = str(uuid or "").strip()
    if not cleaned:
        return None
    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return None
    try:
        client = _client_factory(config)
        return client.get_item_bom(cleaned)
    except PspError:
        logger.exception(
            "PSP get_item_bom failed for org %s item %s",
            organization.pk,
            cleaned,
        )
        return None


# ---------------------------------------------------------------------------
# CustomerOrder sync — NPD formulation ↔ PSP customer order (project)
# ---------------------------------------------------------------------------


def _person_display_name(user: Any) -> str:
    """Best-effort name for the "R&D lead / Sales" chips on PSP.

    Prefers the account's ``full_name`` (first + last), falls back to
    email so the operator sees *something* actionable even when the
    profile is half-set. Returns an empty string when the user is
    unset — PSP treats "" the same as missing.
    """

    if user is None:
        return ""
    full = getattr(user, "full_name", "") or ""
    if full.strip():
        return full.strip()
    email = getattr(user, "email", "") or ""
    return email.strip()


def _formulation_app_url(organization: Any, formulation: Any) -> str:
    """Deep link back into NPD's own formulation builder page.

    Composed here (rather than on the PSP side) because the base URL
    is an NPD-owned setting. Next.js resolves the locale on its own
    (via middleware) so we skip the locale prefix. Returns an empty
    string when the base URL is unset in Django settings — PSP then
    hides the "Open on NPD" button and shows the config hint.
    """

    from django.conf import settings as django_settings

    base = (getattr(django_settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base or not formulation:
        return ""
    return f"{base}/formulations/{formulation.id}/builder/"


def _customer_identity(customer: Any) -> dict:
    """Display + shell-creation fields for the linked customer.

    Returns a homogeneous dict whether or not a customer is attached.
    PSP's ``NpdSync``:

    * On empty ``customer_display_name`` — snaps the CO back to the
      per-tenant "NPD Placeholder" customer (the R&D-mode default).
    * On non-empty — find-or-create-shell in PSP's own Customers
      table using ``customer_uuid`` as the identity key; swaps the
      CO's ``customer_id`` FK to that shell so PSP-native surfaces
      (proposals, invoices) can pick up the customer without the
      operator re-entering anything.

    We ship contact name explicitly so the auto-created PSP shell
    has a meaningful ``contact_name`` right away (PSP normally
    validates this on approval), sparing sales a re-entry.
    """

    if customer is None:
        return {
            "customer_uuid": "",
            "customer_display_name": "",
            "customer_contact_name": "",
        }
    # Prefer the company name (that's what appears on invoices and the
    # kanban); fall back to the contact person when the client is a
    # sole trader with no company set.
    company = (getattr(customer, "company", "") or "").strip()
    contact_name = (getattr(customer, "name", "") or "").strip()
    display = company or contact_name
    return {
        "customer_uuid": str(getattr(customer, "id", "") or ""),
        "customer_display_name": display,
        "customer_contact_name": contact_name,
    }


def _spec_sheet_url(sheet: Any) -> str:
    """Deep link to the spec sheet detail page on NPD."""

    from django.conf import settings as django_settings

    base = (getattr(django_settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base or not sheet:
        return ""
    return f"{base}/specifications/{sheet.id}/"


def _iso(dt: Any) -> str:
    """Return ISO-8601 (UTC ``Z`` suffix) for a datetime, else empty."""

    from datetime import datetime, timezone

    if not isinstance(dt, datetime):
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _cff_url(cff: Any) -> str:
    """Deep link to the CFF submission on NPD."""

    from django.conf import settings as django_settings

    base = (getattr(django_settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base or not cff:
        return ""
    return f"{base}/cff/{cff.id}/"


def _cff_payload(cff: Any) -> dict:
    """CFF identity block for the sync payload — fired on
    ``assign_to_project`` so PSP mirrors the same CFF-project link
    the scientist sees on NPD.
    """

    submitter_name = (
        getattr(cff, "submitter_name", "") or ""
    ).strip()
    if not submitter_name:
        submitter_name = (
            getattr(cff, "portal_submitter_name", "") or ""
        ).strip()
    submitter_email = (
        getattr(cff, "submitter_email", "") or ""
    ).strip()
    return {
        "cff_uuid": str(getattr(cff, "id", "") or ""),
        "cff_url": _cff_url(cff),
        "cff_submitter_name": submitter_name,
        "cff_submitter_email": submitter_email,
    }


def _spec_sheet_payload(sheet: Any) -> dict:
    """Spec identity + sign-off block for the PSP sync payload.

    Only invoked from the ``in_review → approved`` transition, so
    ``director_signed_at`` is guaranteed set — that timestamp is what
    PSP uses to gate the phase move to :awaiting_proposal.
    """

    return {
        "spec_sheet_uuid": str(sheet.id),
        "spec_sheet_url": _spec_sheet_url(sheet),
        "spec_prepared_by_name": _person_display_name(
            getattr(sheet, "prepared_by_user", None)
        ),
        "spec_prepared_at": _iso(getattr(sheet, "prepared_by_signed_at", None)),
        "spec_director_name": _person_display_name(
            getattr(sheet, "director_user", None)
        ),
        "spec_approved_at": _iso(getattr(sheet, "director_signed_at", None)),
    }


def sync_customer_order_to_psp(
    *,
    formulation: Any,
    approved_spec_sheet: Any | None = None,
    spec_cleared: bool = False,
    linked_cff: Any | None = None,
    cff_cleared: bool = False,
) -> dict | None:
    """Push a formulation → CustomerOrder sync payload to PSP.

    Called after every successful ``save_version`` AND when a spec
    sheet transitions to ``approved`` (director signs). PSP treats
    every NPD formulation as a customer order (its "project") —
    first-sync inserts a fresh draft CO with ``uuid = formulation.id``
    planted so the same URL identifies the project on both apps;
    subsequent syncs refresh the identity fields only.

    ``approved_spec_sheet`` — the freshly-approved
    :class:`SpecificationSheet` when called from the spec transition
    hook. Adds spec identity + sign-off timestamps to the payload so
    PSP can flip the phase from ``:r_and_d`` to ``:awaiting_proposal``.
    Absent on ordinary ``save_version`` syncs; PSP preserves any spec
    fields it already has (nil-passes are treated as "no change").

    Silent-degradation contract — no exception bubbles up:

    * PSP integration off / decryption failed → ``None``, no log.
    * PSP unreachable / rate-limited / auth failed → warn + ``None``.

    Returns PSP's response body (``{customer_order: {uuid, status,
    npd_formulation_uuid, inserted_at}}``) on success so callers can
    log the outcome.
    """

    organization = getattr(formulation, "organization", None)
    if organization is None:
        return None
    if not is_psp_live(organization):
        return None

    # RTG-track formulations are catalog dev, not customer projects.
    # They shouldn't ride the CustomerOrder mirror — until a customer
    # actually orders one via the portal, they have no owner. When
    # someone does order, the Proposal → CustomerOrder merge path
    # (``PspClient.merge_customer_orders_from_proposal``) handles the
    # push separately.
    from apps.formulations.models import ProjectType

    if getattr(formulation, "project_type", None) == ProjectType.READY_TO_GO:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return None

    payload = {
        "npd_formulation_uuid": str(formulation.id),
        "name": (getattr(formulation, "name", "") or "").strip(),
        "code": (getattr(formulation, "code", "") or "").strip(),
        # Denormalised R&D team so PSP can render "R&D lead: X ·
        # Sales: Y" on its project page without a round-trip back to
        # NPD. Roles are FK to auth_user; either can be nil (project
        # unassigned). Trimmed to empty-string → treated as "no value"
        # by PSP's sync path.
        "lead_scientist_name": _person_display_name(
            getattr(formulation, "lead_scientist", None)
        ),
        "sales_person_name": _person_display_name(
            getattr(formulation, "sales_person", None)
        ),
        # Deep link back into NPD's own detail page. PSP can't build
        # this itself (locale + base URL are NPD-owned settings), so
        # we send it every sync. Falls back to nil when the org
        # hasn't configured an `app_base_url`.
        "app_url": _formulation_app_url(organization, formulation),
        # Customer identity — nil when the project hasn't been linked
        # yet. PSP uses this to swap the placeholder customer for the
        # real name on its kanban / project page. The uuid lets PSP
        # match against its own Customers table if a matching entry
        # exists (future enhancement); today it's display-only.
        **_customer_identity(getattr(formulation, "customer", None)),
    }

    if approved_spec_sheet is not None:
        # Spec-approved sync: attach sheet identity + who-signed-when
        # so PSP's project page can render the director sign-off card
        # and gate the phase move to :awaiting_proposal.
        payload.update(_spec_sheet_payload(approved_spec_sheet))
    elif spec_cleared:
        # Spec-reverted sync: an already-approved sheet has just been
        # bumped back to draft / rejected. Tell PSP to wipe every
        # spec_* field on the CO so its wizard phase drops from
        # :awaiting_proposal back to :r_and_d.
        payload["spec_state"] = "cleared"

    if linked_cff is not None:
        # CFF-linked sync: attach the submitter identity + a deep
        # link so PSP's project page surfaces the same "who asked
        # for this?" context the scientist sees on NPD.
        payload.update(_cff_payload(linked_cff))
    elif cff_cleared:
        # CFF-unlink sync: wipe all cff_* fields on the CO.
        payload["cff_state"] = "cleared"

    try:
        client = _client_factory(config)
        return client.sync_customer_order(payload)
    except PspError:
        logger.exception(
            "PSP sync_customer_order failed for org %s formulation %s",
            organization.pk,
            formulation.pk,
        )
        return None


def sync_proposal_to_psp(*, proposal: Any) -> dict | None:
    """Push a proposal-created merge sync to PSP.

    Called on ``on_commit`` after :func:`create_proposal` and
    :func:`create_proposal_bundle` succeed. PSP-side
    ``ProposalMerge.merge_from_proposal`` consolidates the N R&D draft
    CustomerOrders that back this proposal's ProposalLines into ONE
    primary CO, absorbs their comments, and creates one CO line per
    ProposalLine.

    Silent-degradation contract (mirrors :func:`sync_customer_order_to_psp`):

    * PSP integration off / decryption failed → ``None``, no log.
    * PSP unreachable / auth failed / merge errored → warn + ``None``.
    * No formulation lines to merge → ``None`` (nothing to do).
    """

    organization = getattr(proposal, "organization", None)
    if organization is None:
        return None
    if not is_psp_live(organization):
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return None

    # Materialise the ProposalLine rows in the order the operator
    # picked them. First line's formulation becomes the primary on PSP.
    lines = list(
        proposal.lines.select_related(
            "formulation_version__formulation"
        ).order_by("id")
    )
    if not lines:
        return None

    line_payload: list[dict[str, Any]] = []
    for line in lines:
        formulation = line.formulation_version.formulation
        if formulation is None:
            continue
        # Phase 3: attach the customer's picked packaging combo (if
        # any) so PSP can overlay the CO's packaging BOM with the
        # combo's items instead of the canonical formulation's default
        # packaging picks. Sent as a self-contained list of
        # ``{psp_item_uuid, name, quantity}`` so PSP doesn't have to
        # round-trip back into NPD to resolve items.
        combo = getattr(line, "selected_packaging_combo", None)
        combo_uuid: str | None = None
        combo_name: str = ""
        combo_items: list[dict[str, Any]] = []
        if combo is not None:
            combo_uuid = str(combo.id)
            combo_name = combo.name or ""
            for row in combo.items.select_related("item").all():
                if row.item_id is None:
                    continue
                combo_items.append(
                    {
                        "npd_item_uuid": str(row.item_id),
                        "psp_item_uuid": (
                            str(row.item.psp_source_uuid)
                            if getattr(row.item, "psp_source_uuid", None)
                            else None
                        ),
                        "name": row.item.name or "",
                        "quantity": int(row.quantity or 1),
                    }
                )

        line_payload.append(
            {
                "npd_formulation_uuid": str(formulation.id),
                "psp_finished_product_uuid": (
                    str(formulation.psp_finished_product_uuid)
                    if getattr(formulation, "psp_finished_product_uuid", None)
                    else None
                ),
                "quantity": int(line.quantity or 1),
                "unit_price": (
                    str(line.unit_price) if line.unit_price is not None else None
                ),
                "line_subtotal": (
                    str(line.line_subtotal)
                    if getattr(line, "line_subtotal", None) is not None
                    else None
                ),
                "packaging_combo_uuid": combo_uuid,
                "packaging_combo_name": combo_name,
                "packaging_combo_items": combo_items,
            }
        )

    if not line_payload:
        return None

    # Per-transition timestamps for the wizard-phase gate (latest-wins).
    transitions = _proposal_transition_map(proposal)
    # Full audit-preserving history — PSP renders every entry as a
    # timeline event. Includes each formulation's own creation, spec
    # sheet transitions, and every proposal status change (including
    # revert-and-redo cycles).
    timeline = _build_full_timeline(organization, proposal)

    payload = {
        "npd_proposal_uuid": str(proposal.id),
        "npd_proposal_code": (getattr(proposal, "code", "") or "").strip(),
        "npd_proposal_url": _proposal_app_url(organization, proposal),
        # NPD-authoritative status. PSP mirrors it and derives the
        # wizard block from here (Awaiting approval → Ready to send
        # → Awaiting customer signature).
        "npd_proposal_status": getattr(proposal, "status", "") or "",
        # Latest-transition timestamps for the wizard phase gate.
        "npd_proposal_created_at": _iso_or_none(getattr(proposal, "created_at", None)),
        "npd_proposal_created_by_name": _person_display_name(
            getattr(proposal, "created_by", None)
        ),
        **transitions,
        "timeline": timeline,
        "lines": line_payload,
    }

    try:
        client = _client_factory(config)
        return client.merge_customer_orders_from_proposal(payload)
    except PspError:
        logger.exception(
            "PSP merge_customer_orders_from_proposal failed for org %s "
            "proposal %s",
            organization.pk,
            proposal.pk,
        )
        return None


def unsync_proposal_from_psp(
    *, organization: Any, proposal_uuid: str
) -> dict | None:
    """Reverse a proposal-driven merge on PSP.

    Called on ``on_commit`` after :func:`delete_proposal` succeeds.
    PSP-side ``ProposalMerge.unmerge_from_proposal`` restores every
    R&D draft CustomerOrder that was folded into the primary — fans
    comments back to their home CO, clears ``merged_into_id`` on the
    N-1 secondaries, and wipes the primary's proposal identity +
    proposal-derived lines so the wizard snaps back to ``:r_and_d``.

    Silent-degradation contract:

    * PSP integration off / decryption failed → ``None``, no log.
    * PSP unreachable / auth failed / unmerge errored → warn + ``None``.
    * Empty ``proposal_uuid`` → ``None`` (nothing to undo).
    """

    if organization is None or not proposal_uuid:
        return None
    if not is_psp_live(organization):
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return None

    try:
        client = _client_factory(config)
        return client.unmerge_customer_orders_from_proposal(proposal_uuid)
    except PspError:
        logger.exception(
            "PSP unmerge_customer_orders_from_proposal failed for org %s "
            "proposal %s",
            organization.pk,
            proposal_uuid,
        )
        return None


def _proposal_app_url(organization: Any, proposal: Any) -> str | None:
    """Deep link back into NPD's own proposal detail.

    Base URL resolution — checked in order — matches the sibling
    builders (``_formulation_app_url``, ``_spec_sheet_url``,
    ``_cff_url``):

    1. Per-org override (``organization.app_base_url``) when set —
       lets an admin point a specific tenant at a bespoke domain.
    2. Global ``django_settings.APP_BASE_URL`` — the default the
       rest of the sync stack already uses.

    Previously only step 1 was checked, which left the URL empty
    for every proposal because ``app_base_url`` is a per-org
    optional column that no tenant fills in in practice. PSP's
    ``npd_proposal_url`` column stayed blank → the "Open signed
    proposal on NPD" button never rendered.
    """

    base = (getattr(organization, "app_base_url", "") or "").strip()
    if not base:
        from django.conf import settings as django_settings

        base = (getattr(django_settings, "APP_BASE_URL", "") or "").strip()
    if not base:
        return None
    return f"{base.rstrip('/')}/proposals/{proposal.id}"


def _iso_or_none(value: Any) -> str | None:
    """ISO-8601 for a Django DateTime field. NPD sends UTC; PSP parses
    with ``DateTime.from_iso8601`` — matched on both sides.
    """

    if value is None:
        return None
    isofmt = getattr(value, "isoformat", None)
    if not callable(isofmt):
        return None
    return isofmt()


#: Human-readable labels for proposal status codes. Anything the
#: enum grows later falls back to a title-cased raw code so the
#: timeline still renders something intelligible.
_PROPOSAL_STATUS_LABELS: dict[str, str] = {
    "draft": "Draft",
    "in_review": "In review",
    "approved": "Approved",
    "sent": "Sent to customer",
    "accepted": "Accepted by customer",
    "rejected": "Rejected",
}

_SPEC_STATUS_LABELS: dict[str, str] = {
    "draft": "Draft",
    "in_review": "In review",
    "approved": "Approved",
    "sent": "Sent to customer",
    "accepted": "Accepted",
    "rejected": "Rejected",
}


def _human_proposal_status(code: str) -> str:
    return _PROPOSAL_STATUS_LABELS.get(code, code.replace("_", " ").capitalize())


def _human_spec_status(code: str) -> str:
    return _SPEC_STATUS_LABELS.get(code, code.replace("_", " ").capitalize())


def _build_full_timeline(organization: Any, proposal: Any) -> list[dict[str, Any]]:
    """Every audit-worthy event for the proposal, sorted oldest-first.

    Sources:

    * Proposal creation (``proposal.created_at``).
    * Every ``ProposalStatusTransition`` row (from_status → to_status).
    * Every attached spec sheet's transitions — each sheet contributes
      its own approval / send / accept history so a multi-spec proposal
      keeps N distinct approval events instead of collapsing to one.
    * Each formulation's creation timestamp so the timeline stretches
      back to "R&D drafted" for every merged project.

    Nil-safe throughout — a missing timestamp or actor drops a field
    (never the whole entry).
    """

    from apps.proposals.models import ProposalStatusTransition
    from apps.specifications.models import SpecificationTransition

    events: list[dict[str, Any]] = []

    proposal_url = _proposal_app_url(organization, proposal)

    # 1. Every formulation that made it into the proposal contributes
    #    its own "Formulation drafted" event. Multi-spec proposals
    #    surface each merged project's origin.
    seen_formulations: set[Any] = set()
    for line in proposal.lines.select_related(
        "formulation_version__formulation__created_by",
    ).all():
        formulation = getattr(line.formulation_version, "formulation", None)
        if formulation is None or formulation.id in seen_formulations:
            continue
        seen_formulations.add(formulation.id)
        events.append(
            {
                "at": _iso_or_none(getattr(formulation, "created_at", None)),
                "label": f"Formulation drafted: {formulation.name or formulation.code}",
                "actor": _person_display_name(
                    getattr(formulation, "created_by", None)
                ),
                "href": _formulation_app_url(organization, formulation),
                "kind": "formulation_created",
            }
        )

    # 2. Every attached spec sheet's transition history. One row per
    #    status change — an approve/revert/re-approve sequence shows
    #    up as three distinct rows so the audit trail is intact.
    sheet_ids = {
        line.specification_sheet_id
        for line in proposal.lines.all()
        if line.specification_sheet_id is not None
    }
    if sheet_ids:
        spec_transitions = (
            SpecificationTransition.objects.filter(sheet_id__in=sheet_ids)
            .select_related("actor", "sheet")
            .order_by("created_at")
        )
        for t in spec_transitions:
            events.append(
                {
                    "at": _iso_or_none(t.created_at),
                    "label": _spec_transition_label(t),
                    "actor": _person_display_name(t.actor),
                    "href": None,
                    "kind": "spec_transition",
                }
            )

    # 3. Proposal itself.
    events.append(
        {
            "at": _iso_or_none(getattr(proposal, "created_at", None)),
            "label": "Proposal drafted",
            "actor": _person_display_name(
                getattr(proposal, "created_by", None)
            ),
            "href": proposal_url,
            "kind": "proposal_created",
        }
    )

    proposal_transitions = (
        ProposalStatusTransition.objects.filter(proposal=proposal)
        .select_related("actor")
        .order_by("created_at")
    )
    for t in proposal_transitions:
        events.append(
            {
                "at": _iso_or_none(t.created_at),
                "label": _proposal_transition_label(t),
                "actor": _person_display_name(t.actor),
                "href": proposal_url,
                "kind": "proposal_transition",
            }
        )

    # Drop entries without a timestamp (defensive; the DB defaults
    # ``created_at`` on every row we source from), then sort ascending
    # so PSP renders oldest → newest without needing to re-sort.
    filtered = [e for e in events if e.get("at")]
    filtered.sort(key=lambda e: e["at"])
    return filtered


def _proposal_transition_label(t: Any) -> str:
    from_h = _human_proposal_status(t.from_status)
    to_h = _human_proposal_status(t.to_status)
    base = f"Proposal moved from {from_h} to {to_h}"
    # Preserve the reject reason across the sync — reject dialog +
    # revert-to-draft dialog both write it to ``notes`` on the
    # transition row. Without this the reason is orphaned on NPD and
    # PSP's timeline is blind to WHY the proposal died.
    notes = (getattr(t, "notes", "") or "").strip()
    if notes and t.to_status in {"rejected", "draft"}:
        return f"{base} — Reason: {notes}"
    return base


def _spec_transition_label(t: Any) -> str:
    code = t.sheet.code or "Spec sheet"
    from_h = _human_spec_status(t.from_status)
    to_h = _human_spec_status(t.to_status)
    return f"{code} moved from {from_h} to {to_h}"


def _proposal_transition_map(proposal: Any) -> dict[str, Any]:
    """Latest transition per target status for the timeline.

    For each of the three status transitions we care about (``approved``,
    ``sent``, ``accepted``) we take the freshest row so the timeline
    reflects the most recent flip. Older revert-and-redo cycles are
    represented by their newest attempt.
    """

    from apps.proposals.models import ProposalStatusTransition

    transitions = ProposalStatusTransition.objects.filter(
        proposal=proposal,
    ).select_related("actor").order_by("created_at")

    per_status: dict[str, ProposalStatusTransition] = {}
    for t in transitions:
        per_status[t.to_status] = t

    def _pair(status: str, at_key: str, by_key: str) -> dict[str, Any]:
        row = per_status.get(status)
        if row is None:
            return {at_key: None, by_key: None}
        return {
            at_key: _iso_or_none(row.created_at),
            by_key: _person_display_name(row.actor),
        }

    return {
        **_pair(
            "approved",
            "npd_proposal_director_approved_at",
            "npd_proposal_director_name",
        ),
        **_pair(
            "sent",
            "npd_proposal_sent_at",
            "npd_proposal_sent_by_name",
        ),
        **_pair(
            "accepted",
            "npd_proposal_accepted_at",
            "npd_proposal_accepted_by_name",
        ),
    }


# ---------------------------------------------------------------------------
# BOM push — NPD formulation → PSP finished-product BOM
# ---------------------------------------------------------------------------


def push_bom_to_psp(
    *,
    formulation: Any,
    stage_bom_overrides: dict[str, list[dict[str, Any]]] | None = None,
) -> dict | None:
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

    ``stage_bom_overrides`` — the FE ships the compute-derived
    full BOM (actives + every excipient band, mg per SKU) on
    sync/save. When present for a stage's uuid, we use those lines
    verbatim instead of deriving from ``formulation.lines`` — that
    way each stage's PSP BOM mirrors exactly what NPD shows on the
    stage card (including anti-caking / MCC / DCP bands that only
    exist in FE compute). Shape:
    ``{"<stage_uuid>": [{"item_uuid": ..., "mg": <float>,
                         "sort_order": <int>}, ...]}``.
    Stages not listed in the override fall back to the derived
    per-stage line projection.
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

    stages = list(formulation.stages.order_by("sort_order"))

    try:
        # Auto-create the finished-product PSP item the first time we
        # push. Historically the operator had to hand-pick it through
        # the finished-product picker before any save-version push
        # would work; that gate silently swallowed pushes for
        # formulations the operator hadn't linked yet. Same idempotency
        # mechanism the semi-finished stages use (external_sku key) so
        # a re-run doesn't duplicate.
        if not formulation.psp_finished_product_uuid:
            finished_uuid = _ensure_finished_product(
                client=client, formulation=formulation
            )
            if finished_uuid is None:
                return None

        if not stages:
            return _push_flat_bom(client=client, formulation=formulation)
        return _push_staged_cascade(
            client=client,
            formulation=formulation,
            stages=stages,
            stage_bom_overrides=stage_bom_overrides,
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


# PSP stores BOM qty in the child item's own stock UoM (kg for raw
# materials, unit for counted items, …). NPD stores every non-manual
# line as ``mg per serving``. This map converts mg → the child's
# stock UoM at push time. Count-based UoMs (unit / pcs / count …)
# are absent from the map — those items should only land as manual
# picks where ``label_claim_mg`` is already a literal count that
# rides through untouched.
_UOM_MG_FACTOR: dict[str, Decimal] = {
    "kg": Decimal("0.000001"),
    "g": Decimal("0.001"),
    "mg": Decimal("1"),
    "l": Decimal("0.000001"),
    "ml": Decimal("0.001"),
}


def _unit_factor_for(item: Any) -> Decimal:
    """Look up the mg → item-native-unit conversion factor. Reads the
    Item's ``unit`` field (mirrored from PSP on pick). Unknown /
    count-based UoMs return 1 (no conversion) which is the right
    behaviour for count items — the compute pipeline shouldn't be
    feeding those anyway, and if it does the number rides through
    unchanged so no data is silently zeroed."""

    unit = str(getattr(item, "unit", "") or "").strip().lower()
    return _UOM_MG_FACTOR.get(unit, Decimal("1"))


def _unit_symbol_for(item: Any) -> str:
    """Return the child item's unit symbol lowercased (kg / g / mg /
    l / ml) or the empty string when the item has no unit set on
    NPD's mirror. The caller decides how to interpret the blank
    (fall back to ``"mg"`` since NPD compute is mg, or leave the
    line untyped).
    """

    return str(getattr(item, "unit", "") or "").strip().lower()


# In-memory catalog of PSP's UoM registry per organization. Filled
# lazily on first BOM push so the round-trip cost is amortised
# across every line in the formulation. Two views:
#
# * ``_PSP_UNIT_INFO_CACHE`` — keyed by ``(org_pk, symbol_lower)``:
#   ``{uuid, symbol, dimension, factor_to_base: Decimal, is_base: bool}``.
#   Used to convert a source qty into PSP's base unit and tag the
#   line with the base UoM's uuid.
# * ``_PSP_UNIT_BASE_CACHE`` — keyed by ``(org_pk, dimension)`` →
#   the same shape as above for whichever UoM has ``is_base=true``.
#   Used to find "the kg for mass" / "the L for volume" without
#   scanning the catalog per lookup.
#
# Both are cleared via :func:`_reset_psp_unit_cache` in tests.
_PSP_UNIT_INFO_CACHE: dict[tuple[Any, str], dict[str, Any]] = {}
_PSP_UNIT_BASE_CACHE: dict[tuple[Any, str], dict[str, Any]] = {}
# Legacy alias — external tests reference the old name. Points at
# ``_PSP_UNIT_INFO_CACHE`` so its cache-invalidation semantics carry
# through.
_PSP_UNIT_CACHE = _PSP_UNIT_INFO_CACHE


def _load_psp_unit_catalog(
    client: "PspClient", organization: Any
) -> Any:
    """Populate the UoM caches for ``organization`` if not already
    warm. Returns the organization's cache key so the caller can do
    subsequent lookups without recomputing the key. Silently no-ops
    (leaves caches empty) when PSP is unreachable — the caller
    still ships the line, minus the ``uom_uuid`` tag."""

    org_key = getattr(organization, "pk", None) or getattr(organization, "id", None)
    already_hot = any(k[0] == org_key for k in _PSP_UNIT_INFO_CACHE)
    if already_hot:
        return org_key
    try:
        rows = client.list_units_of_measurement()
    except PspError:
        logger.exception(
            "PSP push_bom: list_units_of_measurement failed for org %s",
            org_key,
        )
        return org_key
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        sym = str(row.get("symbol") or "").strip().lower()
        uuid = str(row.get("uuid") or "").strip()
        if not sym or not uuid:
            continue
        try:
            factor = Decimal(str(row.get("factor_to_base") or "1"))
        except (InvalidOperation, TypeError, ValueError):
            factor = Decimal("1")
        info: dict[str, Any] = {
            "uuid": uuid,
            "symbol": sym,
            "dimension": str(row.get("dimension") or "").strip().lower() or None,
            "factor_to_base": factor,
            "is_base": bool(row.get("is_base")),
        }
        _PSP_UNIT_INFO_CACHE[(org_key, sym)] = info
        if info["is_base"] and info["dimension"]:
            _PSP_UNIT_BASE_CACHE[(org_key, info["dimension"])] = info
    return org_key


def _psp_unit_info_for(
    client: "PspClient", organization: Any, symbol: str
) -> dict[str, Any] | None:
    """Return the full PSP UoM catalog row for ``symbol`` or ``None``."""

    key = str(symbol or "").strip().lower()
    if not key:
        return None
    org_key = _load_psp_unit_catalog(client, organization)
    return _PSP_UNIT_INFO_CACHE.get((org_key, key))


def _psp_uom_uuid_for(
    client: "PspClient", organization: Any, symbol: str
) -> str | None:
    """Backward-compatible symbol → uuid lookup. Prefer
    :func:`_psp_unit_info_for` in new code so callers can also read
    the dimension / conversion factor."""

    info = _psp_unit_info_for(client, organization, symbol)
    return info["uuid"] if info else None


def _psp_base_unit_for_dimension(
    client: "PspClient", organization: Any, dimension: str
) -> dict[str, Any] | None:
    """Return the base UoM (``is_base=true``) for a dimension, or
    ``None`` when PSP has none seeded for that dimension. Caches
    piggyback on :func:`_load_psp_unit_catalog`."""

    key = str(dimension or "").strip().lower()
    if not key:
        return None
    org_key = _load_psp_unit_catalog(client, organization)
    return _PSP_UNIT_BASE_CACHE.get((org_key, key))


def _convert_qty_to_base(
    qty: Decimal,
    source_symbol: str,
    *,
    client: "PspClient | None",
    organization: Any,
) -> tuple[Decimal, str | None, str | None]:
    """Normalise ``(qty, source_symbol)`` to PSP's base unit for its
    dimension. Returns ``(qty_in_base, base_symbol, base_uom_uuid)``.

    Falls back to the original (qty, source_symbol, None) when:

    * ``client`` / ``organization`` weren't provided (offline call).
    * PSP's UoM catalog is unreachable.
    * The source symbol isn't in PSP's registry (unknown unit).
    * The source unit's dimension has no ``is_base`` row.

    The fallback keeps every line shipping — the qty just stays in
    the source unit and the caller can decide whether to tag it.
    """

    if client is None or organization is None:
        return qty, source_symbol or None, None
    src = _psp_unit_info_for(client, organization, source_symbol)
    if src is None or not src.get("dimension"):
        return qty, source_symbol or None, None
    base = _psp_base_unit_for_dimension(client, organization, src["dimension"])
    if base is None:
        return qty, src["symbol"], src["uuid"]
    if src["uuid"] == base["uuid"]:
        # Already in the base unit — skip the arithmetic.
        return qty, base["symbol"], base["uuid"]
    converted = qty * src["factor_to_base"]
    return converted, base["symbol"], base["uuid"]


def _resolve_line_uom_uuid(
    client: "PspClient",
    organization: Any,
    item: Any,
) -> str | None:
    """Best-effort resolve of the per-line UoM UUID to embed in the
    PSP BOM push. Uses the child item's declared unit when known;
    falls back to ``"mg"`` because that's NPD's compute unit — any
    quantity from :attr:`FormulationLine.mg_per_serving_cached`
    that reaches PSP without a scaling factor is literally mg, so
    tagging it as mg keeps the display honest even when the item
    itself has no ``stock_uom`` on PSP.

    Returns ``None`` when PSP has no matching symbol in its
    catalogue — the caller lets the line ride through without a UoM
    marker (legacy behaviour) rather than blocking the push.
    """

    symbol = _unit_symbol_for(item)
    if not symbol:
        symbol = "mg"
    return _psp_uom_uuid_for(client, organization, symbol)


def _bom_lines_from(
    items: list[Any],
    *,
    start_index: int = 0,
    servings_per_output_unit: Decimal | None = None,
    client: "PspClient | None" = None,
    organization: Any = None,
) -> list[dict[str, Any]]:
    """Project a list of ``FormulationLine`` rows into the PSP BOM
    line shape. Skips rows whose local Item has no ``psp_source_uuid``
    (legacy pre-mirror items) or whose cached serving weight is
    non-positive (a compute glitch we don't want to propagate).

    ``servings_per_output_unit`` is the target stage's
    ``FormulationStage.servings_per_output_unit`` (how many finished
    servings equal 1 stock unit of the stage's PSP output item). It
    scales mg-based lines to PSP's per-1-parent-unit BOM convention.
    Defaults to 1.0 so callers that don't know the stage context
    preserve the legacy behavior.

    ``client`` + ``organization`` — when both provided, each output
    line gets a ``uom_uuid`` tag so PSP renders "600 mg" instead of
    a bare "600". Missing either arg falls back to the legacy
    UoM-less shape (PSP resolves the line's UoM from the part's
    stock_uom, which may be null).

    Manual picks (``source_kind == "manual"``) bypass the mg → UoM
    conversion — their ``label_claim_mg`` is the user-typed qty in
    the item's native unit (per finished output), so it rides through
    verbatim.
    """

    servings = servings_per_output_unit or Decimal("1")
    out: list[dict[str, Any]] = []
    for offset, line in enumerate(items):
        item = line.item
        if item is None or not getattr(item, "psp_source_uuid", None):
            continue
        raw_qty = line.mg_per_serving_cached
        if raw_qty is None or raw_qty <= 0:
            continue
        source_kind = getattr(line, "source_kind", "active")
        if source_kind == "manual":
            # User typed qty in the item's native unit; keep that as
            # the source unit + let the base-normaliser rescale it.
            source_qty = Decimal(str(raw_qty))
            source_symbol = _unit_symbol_for(item) or "mg"
        else:
            # Actives + band picks: compute is always mg per serving;
            # scale to per-1-parent-unit then let the base-normaliser
            # move it to kg / L. We deliberately skip the historical
            # ``_unit_factor_for(item)`` step — that pre-converted to
            # the item's declared unit, which sometimes matched the
            # base and sometimes didn't. Feeding raw mg straight into
            # the normaliser is unambiguous.
            source_qty = Decimal(str(raw_qty)) * servings
            source_symbol = "mg"
        qty, _base_symbol, base_uom_uuid = _convert_qty_to_base(
            source_qty,
            source_symbol,
            client=client,
            organization=organization,
        )
        if qty <= 0:
            continue
        row: dict[str, Any] = {
            "part_uuid": str(item.psp_source_uuid),
            "qty": str(qty),
            "sort_order": start_index + offset,
        }
        if base_uom_uuid:
            row["uom_uuid"] = base_uom_uuid
        elif client is not None and organization is not None:
            # Base lookup failed (dimension-less item, unknown symbol,
            # or PSP unreachable). Fall back to the source-unit uuid
            # so downstream still gets a UoM label.
            fallback_uuid = _psp_uom_uuid_for(
                client, organization, source_symbol
            )
            if fallback_uuid:
                row["uom_uuid"] = fallback_uuid
        out.append(row)
    return out


def _override_to_bom_lines(
    override: list[dict[str, Any]],
    *,
    item_lookup_by_local_id: dict[str, dict[str, str]],
    servings_per_output_unit: Decimal | None = None,
    client: "PspClient | None" = None,
    organization: Any = None,
) -> list[dict[str, Any]]:
    """Project the FE-computed stage snapshot into the PSP BOM line
    shape. Each incoming row is ``{"item_id", "mg", "sort_order"}``
    — a local ``catalogues.Item.id`` (already mirrored so its
    ``psp_source_uuid`` is populated) plus the compute-adjusted mg
    per serving.

    ``item_lookup_by_local_id`` maps each local id to
    ``{"psp_uuid": str, "unit": str}`` so we can both resolve the
    child PSP uuid AND convert mg → the child's native stock UoM.
    ``servings_per_output_unit`` scales per-serving mg into the
    per-1-parent-unit that PSP's BOM math expects (defaults to 1.0).

    ``client`` + ``organization`` — when both provided, each output
    line gets a ``uom_uuid`` tag (from the child's declared unit, or
    ``mg`` when the item has none) so PSP renders the qty with its
    real unit label.

    Rows without a resolvable PSP uuid (unmirrored placeholders from
    empty picker bands) or with non-positive mg are dropped so the
    payload only carries lines PSP can resolve.
    """

    servings = servings_per_output_unit or Decimal("1")
    out: list[dict[str, Any]] = []
    for row in override:
        if not isinstance(row, dict):
            continue
        local_item_id = row.get("item_id")
        info: dict[str, str] | None = None
        if local_item_id:
            info = item_lookup_by_local_id.get(str(local_item_id))
        psp_uuid: str | None = info["psp_uuid"] if info else None
        if not psp_uuid:
            raw_uuid = row.get("psp_item_uuid")
            if raw_uuid:
                psp_uuid = str(raw_uuid).strip() or None
        if not psp_uuid:
            continue
        raw_mg = row.get("mg", row.get("qty"))
        try:
            mg = Decimal(str(raw_mg)) if raw_mg is not None else Decimal("0")
        except (InvalidOperation, TypeError, ValueError):
            continue
        if mg <= 0:
            continue
        # Compute is mg per serving → scale to per-1-parent-unit. Then
        # hand off to the base-normaliser so the line lands on PSP in
        # kg / L, tagged with the base UoM's uuid. See the twin
        # comment in ``_bom_lines_from`` for why we skip the historic
        # per-item unit-factor step.
        source_qty = mg * servings
        qty, _base_symbol, base_uom_uuid = _convert_qty_to_base(
            source_qty,
            "mg",
            client=client,
            organization=organization,
        )
        if qty <= 0:
            continue
        try:
            sort_order = int(row.get("sort_order", len(out)))
        except (TypeError, ValueError):
            sort_order = len(out)
        line_row: dict[str, Any] = {
            "part_uuid": str(psp_uuid),
            "qty": str(qty),
            "sort_order": sort_order,
        }
        if base_uom_uuid:
            line_row["uom_uuid"] = base_uom_uuid
        elif client is not None and organization is not None:
            # Same fallback as the item-driven path: tag the line with
            # the source unit's uuid so PSP still shows a UoM label.
            fallback_uuid = _psp_uom_uuid_for(client, organization, "mg")
            if fallback_uuid:
                line_row["uom_uuid"] = fallback_uuid
        out.append(line_row)
    return out


def _push_flat_bom(*, client: PspClient, formulation: Any) -> dict | None:
    """Legacy path: one flat BOM against the finished-product item.
    Kept as the fallback for formulations that don't yet have a
    stage graph (dosage forms with no default template, or rows
    created before phase 2 landed)."""

    # Legacy flat BOM = "the finished product is the parent". 1 unit
    # of the finished product = 1 pack, so servings per unit = the
    # formulation's servings_per_pack (falls back to 1 for older rows).
    fallback_servings = Decimal("1")
    raw_spp = getattr(formulation, "servings_per_pack", None)
    if raw_spp:
        try:
            candidate = Decimal(str(raw_spp))
            if candidate > 0:
                fallback_servings = candidate
        except (InvalidOperation, TypeError, ValueError):
            pass
    lines = _bom_lines_from(
        _lines_for_stage(formulation, stage_id=None),
        servings_per_output_unit=fallback_servings,
        client=client,
        organization=formulation.organization,
    )
    all_lines = _bom_lines_from(
        list(
            formulation.lines.select_related("item").order_by("display_order")
        ),
        servings_per_output_unit=fallback_servings,
        client=client,
        organization=formulation.organization,
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


def _stage_servings(stage: Any) -> Decimal:
    """Coerce a stage's ``servings_per_output_unit`` to a positive
    Decimal. Zero / negative / missing values fall back to 1 so a
    misconfigured stage doesn't divide-by-zero the prior-semi qty
    formula downstream (worst case ships wrong quantities that the
    operator can fix on the Stages tab)."""

    raw = getattr(stage, "servings_per_output_unit", None)
    if raw is None:
        return Decimal("1")
    try:
        value = Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("1")
    return value if value > 0 else Decimal("1")


def _push_staged_cascade(
    *,
    client: PspClient,
    formulation: Any,
    stages: list[Any],
    stage_bom_overrides: dict[str, list[dict[str, Any]]] | None = None,
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
    # Track the previous stage's declared stock UoM uuid so the parent
    # stage's BOM line for the semi-finished input can be tagged with
    # it. Without this, the parent MO Parts table on PSP falls back to
    # "?" for the semi row even though the semi item itself has a
    # stock_uom set — because BOM lines carry their own UoM slot.
    previous_semi_stock_uom_uuid: str | None = None
    previous_servings: Decimal = Decimal("1")
    last_response: dict | None = None

    # Build the local-item-id → {psp_uuid, unit} lookup once, spanning
    # every id referenced across all overrides. One query beats N
    # Item.get calls in the per-stage loop. The ``unit`` string feeds
    # ``_override_to_bom_lines``'s mg → native-UoM conversion.
    override_item_lookup: dict[str, dict[str, str]] = {}
    if stage_bom_overrides:
        wanted_ids: set[str] = set()
        for rows in stage_bom_overrides.values():
            for row in rows:
                if not isinstance(row, dict):
                    continue
                raw = row.get("item_id")
                if raw:
                    wanted_ids.add(str(raw))
        if wanted_ids:
            from apps.catalogues.models import Item

            for item in Item.objects.filter(
                id__in=wanted_ids, psp_source_uuid__isnull=False
            ).only("id", "psp_source_uuid", "unit"):
                override_item_lookup[str(item.id)] = {
                    "psp_uuid": str(item.psp_source_uuid),
                    "unit": str(item.unit or ""),
                }

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

        # BOM lines — prefer the FE-computed override for this stage
        # (which carries the full recipe: assigned actives + every
        # excipient band at compute-adjusted mg per SKU), else fall
        # back to the ORM-line derivation for backwards compatibility.
        # The override is what makes NPD's stage card display and
        # PSP's per-stage BOM show the same list — otherwise the
        # FE synthesizes excipients that never reach PSP.
        stage_servings = _stage_servings(stage)
        override = None
        if stage_bom_overrides is not None:
            override = stage_bom_overrides.get(str(stage.id))
        if override is not None:
            bom_lines = _override_to_bom_lines(
                override,
                item_lookup_by_local_id=override_item_lookup,
                servings_per_output_unit=stage_servings,
                client=client,
                organization=formulation.organization,
            )
        else:
            assigned = _lines_for_stage(formulation, stage_id=stage.id)
            if is_finished:
                assigned = assigned + _lines_for_stage(
                    formulation, stage_id=None
                )
            bom_lines = _bom_lines_from(
                assigned,
                servings_per_output_unit=stage_servings,
                client=client,
                organization=formulation.organization,
            )

        # Prior-stage semi input: how many stock-units of the prior
        # semi does 1 stock-unit of THIS stage's output consume?
        #     qty = stage.servings_per_output_unit
        #         ÷ prior_stage.servings_per_output_unit
        # e.g. Bottle (60 servings/unit) consuming Blend (2000
        # servings/kg): 60 ÷ 2000 = 0.03 kg per bottle.
        if previous_semi_uuid is not None:
            if previous_servings > 0:
                prior_qty = stage_servings / previous_servings
            else:
                prior_qty = Decimal("1")
            prior_line: dict[str, Any] = {
                "part_uuid": previous_semi_uuid,
                "qty": str(prior_qty),
                "sort_order": -1,
            }
            # Tag with the semi item's declared stock UoM so the parent
            # MO Parts table renders "0.03 L" instead of "0.03 ?".
            if previous_semi_stock_uom_uuid:
                prior_line["uom_uuid"] = str(previous_semi_stock_uom_uuid)
            bom_lines = [prior_line] + bom_lines
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
                # Cache the BOM uuid PSP returned so the Preview tab's
                # stage-title link can navigate straight to
                # ``/production/boms/<uuid>``. PSP's response shape is
                # ``{"bom": {"uuid": ..., "version_no": N}}``.
                returned_bom = response.get("bom") if isinstance(response, dict) else None
                bom_uuid = (
                    returned_bom.get("uuid")
                    if isinstance(returned_bom, dict)
                    else None
                )
                if bom_uuid and str(bom_uuid) != str(stage.psp_bom_uuid or ""):
                    stage.psp_bom_uuid = bom_uuid
                    stage.save(update_fields=["psp_bom_uuid"])

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

        if is_finished:
            previous_semi_uuid = None
            previous_semi_stock_uom_uuid = None
        else:
            previous_semi_uuid = output_uuid
            previous_semi_stock_uom_uuid = (
                str(stage.psp_item_stock_uom_uuid)
                if stage.psp_item_stock_uom_uuid
                else None
            )
            previous_servings = stage_servings

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
    # Auto-push aggregated compliance flags. Each flag's status = AND
    # across every ingredient's own ``vegan`` / ``organic`` / ``halal``
    # / ``kosher`` attribute — one non-compliant SKU taints the whole
    # product, an unanswered ingredient returns None and skips the
    # push. Same rule ``compute_compliance`` applies to the FE chip
    # so what NPD shows == what PSP receives.
    try:
        from apps.formulations.services import compute_compliance

        line_items = [
            line.item
            for line in formulation.lines.select_related("item").all()
            if line.item is not None
        ]
        if line_items:
            compliance = compute_compliance(items=line_items)
            for flag in compliance.flags:
                if flag.status is None:
                    continue
                _put(
                    flag.key,
                    "Yes" if flag.status else "No",
                )
    except Exception:  # noqa: BLE001
        # Compliance derivation is a best-effort convenience — a
        # traceback here should never break the PSP push cascade,
        # which already treats every spec field as optional.
        logger.exception(
            "PSP finished-product spec: compliance derivation failed"
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

    # Certificates — attach any un-mirrored rows. NPD is source of
    # truth for the attach metadata (number + validity); PSP is
    # source of truth for the certificate registry itself. Silent-
    # degrade per row so a transient PSP failure doesn't block the
    # whole cascade.
    for cert_row in formulation.certificates.filter(psp_attachment_uuid__isnull=True):
        valid_from = (
            cert_row.valid_from.isoformat() if cert_row.valid_from else None
        )
        valid_until = (
            cert_row.valid_until.isoformat() if cert_row.valid_until else None
        )
        try:
            response = client.attach_item_certificate(
                item_uuid,
                certificate_uuid=cert_row.psp_certificate_uuid,
                certificate_number=cert_row.certificate_number or None,
                valid_from=valid_from,
                valid_until=valid_until,
            )
        except PspError as exc:
            logger.info(
                "PSP push: certificate attach soft-failed: %s", exc
            )
            continue
        if response and response.get("uuid"):
            cert_row.psp_attachment_uuid = str(response["uuid"])
            cert_row.save(update_fields=["psp_attachment_uuid"])


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


class PspTrialBatchWarehouseMissing(Exception):
    """The org has PSP live but hasn't picked the target warehouse on
    /settings/integrations. Without it we can't tell PSP where to
    consume + deposit stock for the trial MO. API layer maps to 409
    ("configure first") — a different remediation from a generic 400.
    """

    code = "psp_trial_batch_warehouse_missing"


class PspTrialBatchItemMissing(Exception):
    """The formulation the trial batch pins isn't linked to a PSP
    finished product yet (``psp_finished_product_uuid`` is null). We
    can't create an MO for an item PSP doesn't know about. API layer
    maps to 409.
    """

    code = "psp_trial_batch_item_missing"


class PspCreateManufacturingOrderFailed(Exception):
    """Passthrough for validation errors PSP raised while creating the
    MO (missing warehouse, missing item, rd_stream_mismatch, etc.).
    Carries the PSP-side error code + detail so the FE can surface a
    specific hint instead of a generic "PSP said no".
    """

    def __init__(self, message: str, *, psp_error: str = "", detail: str = ""):
        super().__init__(message)
        self.psp_error = psp_error
        self.detail = detail

    code = "psp_create_manufacturing_order_failed"


class PspCreateFinishedProductFailed(Exception):
    """PSP accepted the request but returned an unexpected shape (no
    uuid on the response). API layer maps to 502 — soft failure
    that's neither auth nor rate limit."""

    code = "psp_create_finished_product_failed"


def _derive_psp_mo_quantity(trial_batch: Any) -> Decimal:
    """Translate a trial batch's planned scale into PSP's
    ``mo.quantity`` — expressed in the finished-product's stock unit.

    Two conversions stack:

    1. The trial batch stores ``batch_size_units`` in one of two
       modes (``BatchSizeMode``):
       * ``pack`` — user typed a pack count. Total-servings intent is
         ``batch_size_units × formulation.servings_per_pack``.
       * ``unit`` — user typed the raw servings count. Intent is
         ``batch_size_units`` as-is.
    2. PSP's BOM lines are per-1-stock-unit-of-finished. If the
       finished stage sets ``servings_per_output_unit = N``, then one
       stock unit already bundles N servings, so ``mo.quantity =
       target_servings / N``.

    Rounding: caller quantises to 6 dp. Zero / null anywhere
    collapses to ``batch_size_units`` (the raw number) so the trial
    still MOs rather than 400-ing on missing config.
    """

    batch_size_raw = getattr(trial_batch, "batch_size_units", None)
    if batch_size_raw in (None, ""):
        raise ValueError("trial_batch.batch_size_units is required")

    try:
        batch_size = Decimal(str(batch_size_raw))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(
            "trial_batch.batch_size_units must be numeric"
        ) from exc
    if batch_size <= 0:
        raise ValueError(
            "trial_batch.batch_size_units must be positive"
        )

    # Step 1: convert to target servings.
    mode = getattr(trial_batch, "batch_size_mode", None) or "pack"
    formulation = trial_batch.formulation_version.formulation
    servings_per_pack = getattr(formulation, "servings_per_pack", None)
    if mode == "pack":
        multiplier = Decimal(str(servings_per_pack or 1))
        if multiplier <= 0:
            multiplier = Decimal("1")
        target_servings = batch_size * multiplier
    else:  # "unit" — batch_size is already in individual servings
        target_servings = batch_size

    # Step 2: divide by servings-per-stock-unit (per finished stage).
    finished_stage = (
        formulation.stages.filter(psp_item_type="finished_product")
        .order_by("-sort_order")
        .first()
    )
    if finished_stage is None:
        divisor = Decimal("1")
    else:
        try:
            divisor = Decimal(
                str(finished_stage.servings_per_output_unit or 1)
            )
        except (InvalidOperation, TypeError, ValueError):
            divisor = Decimal("1")
        if divisor <= 0:
            divisor = Decimal("1")

    return target_servings / divisor


def create_psp_manufacturing_order_for_trial_batch(
    *,
    organization: Any,
    actor: Any,
    trial_batch: Any,
    quantity: Any,
    warehouse_uuid: Any,
    project_type: str = "trial",
    item_uuid: Any = None,
    due_date: Any = None,
    notes: str = "",
) -> dict:
    """Create a PSP Manufacturing Order for a trial batch + pin the
    returned uuid on ``TrialBatch.psp_manufacturing_order_uuid``.

    Resolves inputs in this order (values in parentheses win):

    * ``item_uuid`` — caller override (raw string) or
      ``trial_batch.formulation_version.formulation.psp_finished_product_uuid``.
    * ``warehouse_uuid`` — required per-request from the modal's
      dropdown. Was previously a global setting; moved to per-MO
      choice so multi-site R&D setups can route different trial
      batches to different R&D warehouses without editing settings.
    * ``project_type`` — caller override (``trial`` | ``sample``);
      defaults to ``trial``.
    * ``quantity`` — required, whole number > 0.

    Idempotent by ``trial_batch.id`` — PSP's unique partial index on
    ``manufacturing_orders_npd_trial_batch_uuid_unique`` guarantees
    the same trial can't spawn a duplicate MO; a retry returns the
    existing MO (200) which we still persist through so the local
    row's uuid heals on any drift.

    Records an audit row on success. Raises typed exceptions on
    config gaps so the API layer can map each to a distinct 4xx.
    """

    from django.db import transaction

    from apps.audit.services import record as record_audit

    if not is_psp_live(organization):
        raise PspNotConfigured(
            "PSP is not configured or is disabled on this workspace."
        )

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        # Same silent-degrade posture as every other create-path
        # helper — the FE surfaces "PSP unavailable, check settings".
        raise

    resolved_warehouse_uuid = str(warehouse_uuid or "").strip()
    if not resolved_warehouse_uuid:
        raise PspTrialBatchWarehouseMissing(
            "Pick a PSP warehouse for this trial MO."
        )

    resolved_item_uuid = str(item_uuid or "").strip()
    if not resolved_item_uuid:
        formulation = trial_batch.formulation_version.formulation
        raw = getattr(formulation, "psp_finished_product_uuid", None)
        resolved_item_uuid = str(raw or "").strip()
    if not resolved_item_uuid:
        raise PspTrialBatchItemMissing(
            "Link this formulation to a PSP finished product before "
            "spawning a trial MO."
        )

    # Default quantity from the trial batch's planned scale — the whole
    # point of a trial batch is to fix the run size, so re-asking the
    # scientist to type it is a compliance-first field-design smell.
    # Callers can still override (e.g. an integration test) but the
    # standard "Create MO" click sends nothing and lands here.
    #
    # PSP's ``mo.quantity`` is expressed in the finished-product's
    # stock unit. The trial batch's ``batch_size_units`` is in either
    # packs OR individual servings depending on ``batch_size_mode``,
    # so we normalise both branches to a servings target first, then
    # divide by the finished stage's ``servings_per_output_unit`` so
    # the number PSP sees means the same thing as PSP's BOM lines
    # (which are per-1-stock-unit).
    if quantity in (None, ""):
        quantity = _derive_psp_mo_quantity(trial_batch)

    try:
        qty_dec = Decimal(str(quantity))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("quantity must be a positive number") from exc
    if qty_dec <= 0:
        raise ValueError("quantity must be a positive number")
    # Cap at 6 dp so a fractional-pack MO (e.g. 10 servings / 60 =
    # 0.16666666… packs) reaches PSP with clean digits.
    qty_dec = qty_dec.quantize(Decimal("0.000001"))

    if project_type not in ("trial", "sample"):
        raise ValueError("project_type must be 'trial' or 'sample'")

    client = _client_factory(config)
    try:
        mo = client.create_manufacturing_order(
            item_uuid=resolved_item_uuid,
            warehouse_uuid=resolved_warehouse_uuid,
            quantity=qty_dec,
            npd_trial_batch_uuid=str(trial_batch.id),
            project_type=project_type,
            due_date=due_date,
            notes=notes or "",
        )
    except PspUnreachable as exc:
        # PSP-side validation errors come through as PspUnreachable
        # with the JSON body embedded in the message. Try to project
        # them onto a specific typed exception the API layer can map
        # to a 4xx with actionable copy.
        message = str(exc)
        if '"rd_stream_mismatch"' in message:
            raise PspCreateManufacturingOrderFailed(
                "One or more BOM components are R&D-only (tagged "
                "`rnd`). Set project_type=trial or remove the rnd tag "
                "from the offending items on PSP.",
                psp_error="rd_stream_mismatch",
                detail=message,
            ) from exc
        if '"item_not_found"' in message:
            raise PspCreateManufacturingOrderFailed(
                "PSP couldn't find the finished-product item. Push "
                "the formulation first, then retry.",
                psp_error="item_not_found",
                detail=message,
            ) from exc
        if '"warehouse_not_found"' in message:
            raise PspCreateManufacturingOrderFailed(
                "PSP couldn't find the target warehouse. Update "
                "`psp_warehouse_uuid` on /settings/integrations.",
                psp_error="warehouse_not_found",
                detail=message,
            ) from exc
        raise

    if not mo.get("uuid"):
        raise PspCreateManufacturingOrderFailed(
            "PSP accepted the create but returned no MO uuid.",
            psp_error="no_uuid",
            detail=str(mo),
        )

    with transaction.atomic():
        # Detect the re-attempt case: PSP handed back a different MO
        # uuid than the one we had pinned, which means the previous
        # MO was cancelled and PSP minted a fresh chain. Reset the
        # gate flag so the QC tab locks again until this fresh chain
        # completes end-to-end.
        previous_uuid = trial_batch.psp_manufacturing_order_uuid
        is_fresh_chain = (
            previous_uuid is not None and str(previous_uuid) != str(mo["uuid"])
        )
        trial_batch.psp_manufacturing_order_uuid = mo["uuid"]
        trial_batch.updated_by = actor
        update_fields = [
            "psp_manufacturing_order_uuid",
            "updated_by",
            "updated_at",
        ]
        if is_fresh_chain:
            trial_batch.psp_all_stages_completed = False
            update_fields.append("psp_all_stages_completed")
        trial_batch.save(update_fields=update_fields)
        record_audit(
            organization=organization,
            actor=actor,
            action="psp.trial_batch.mo.create",
            target=trial_batch,
            after={
                "psp_manufacturing_order_uuid": mo.get("uuid"),
                "status": mo.get("status"),
                "quantity": mo.get("quantity"),
                "project_type": mo.get("project_type"),
                "item_uuid": resolved_item_uuid,
                "warehouse_uuid": resolved_warehouse_uuid,
            },
        )
    return mo


def get_psp_manufacturing_order_chain(
    *,
    organization: Any,
    mo_uuid: Any,
) -> dict | None:
    """Fetch the full parent → child MO tree for a trial batch's
    linked PSP MO. Powers the "stage chain" list on the trial-batch
    detail page — one row per stage MO, indented by depth. Returns
    ``None`` when PSP has no such MO or the org has no live PSP
    integration.
    """

    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    return client.get_manufacturing_order_chain(mo_uuid)


def get_psp_manufacturing_order_bookings(
    *,
    organization: Any,
    mo_uuid: Any,
) -> dict | None:
    """Fetch the per-booking pick/consumption state for a trial MO —
    powers the "picker at step N/M" indicator on the trial batch
    card. Returns ``None`` when PSP has no such MO or the org has
    no live PSP integration.
    """

    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    return client.list_mo_bookings(mo_uuid)


def get_psp_rnd_warehouses(*, organization: Any) -> list[dict]:
    """List R&D-tagged PSP warehouses for the Create-MO dropdown.

    Silent-degrade posture — returns ``[]`` when PSP isn't configured,
    can't decrypt the token, or doesn't respond. The Create-MO modal
    surfaces "no R&D warehouse available" and disables the submit
    button in that case, same as before.
    """

    if not is_psp_live(organization):
        return []
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return []
    client = _client_factory(config)
    try:
        return client.list_rnd_warehouses()
    except PspError:
        return []


def create_psp_finished_product(
    *,
    organization: Any,
    actor: Any,
    name: str,
    external_sku: str = "",
    description: str = "",
    barcode: str = "",
) -> dict:
    """Create a brand-new PSP finished-product item on demand — used
    by the New-formulation dialog when the scientist doesn't want to
    link an existing PSP item.

    Delegates to :meth:`PspClient.create_item` with
    ``item_type="finished_product"`` locked. Returns the raw PSP
    response ``{"uuid", "name", "item_type", "external_sku",
    "code"?, "created"}`` so the caller can populate the new-form
    fields + link the returned uuid onto the formulation.

    Idempotency: ``external_sku`` is the load-bearing key on PSP. If
    the caller provides a value that already exists, PSP returns the
    existing row with ``created: false``. If the caller leaves it
    blank we auto-generate ``NPD-FP-<random>`` so back-to-back
    submissions of the same form don't collide on empty strings.
    """

    import secrets

    if not is_psp_live(organization):
        raise PspNotConfigured(
            "PSP is not configured or is disabled on this workspace."
        )

    cleaned_name = (name or "").strip()
    if not cleaned_name:
        raise ValueError("name is required to create a PSP finished product")

    cleaned_sku = (external_sku or "").strip()
    if not cleaned_sku:
        cleaned_sku = f"NPD-FP-{secrets.token_hex(4).upper()}"

    config = get_psp_config(organization=organization)
    client = _client_factory(config)
    response = client.create_item(
        name=cleaned_name,
        item_type="finished_product",
        external_sku=cleaned_sku,
        description=(description or "").strip(),
        barcode=(barcode or "").strip(),
    )
    if not response or not response.get("uuid"):
        raise PspCreateFinishedProductFailed(
            "PSP accepted the create request but returned no uuid."
        )

    from apps.audit.services import record as record_audit

    record_audit(
        organization=organization,
        actor=actor,
        action="psp.finished_product.create",
        target=organization,
        after={
            "uuid": str(response.get("uuid")),
            "name": response.get("name"),
            "external_sku": response.get("external_sku"),
            "created": bool(response.get("created")),
        },
    )
    return response


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
    # Allergen decls from the PSP raw material flow onto the local
    # mirror as parallel key + uuid lists. NPD's Setup tab reads
    # these off every ingredient in the formulation and unions them
    # into the derived allergen declaration. Empty lists still get
    # written so the "no allergens on this ingredient" signal is
    # explicit — a missing key would be ambiguous.
    attrs["allergen_keys"] = [a["key"] for a in (psp_item.allergens or ())]
    attrs["allergen_uuids"] = [a["uuid"] for a in (psp_item.allergens or ())]
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
# Pull-from-PSP — hydrate a formulation from PSP's existing BOM
# ---------------------------------------------------------------------------


class PspFinishedProductNotLinked(Exception):
    """Formulation has no ``psp_finished_product_uuid`` yet, so there
    is no PSP item to pull a BOM from. API layer maps to 400.
    """

    code = "psp_finished_product_not_linked"


class PspBomNotFound(Exception):
    """PSP has the linked item but no primary active BOM on it — the
    caller can't hydrate from an empty recipe. API layer maps to 404.
    """

    code = "psp_bom_not_found"


class PspBomEmpty(Exception):
    """PSP returned a BOM header but no lines — treated the same as
    "no BOM" so the API layer surfaces a clear message rather than a
    silent no-op."""

    code = "psp_bom_empty"


#: UOM symbol → conversion factor to milligrams. Anything not in the
#: map is stored verbatim as ``label_claim_mg`` with the raw numeric
#: qty, and flagged in the summary so the scientist knows to adjust.
_UOM_TO_MG: dict[str, Decimal] = {
    "mg": Decimal("1"),
    "g": Decimal("1000"),
    "kg": Decimal("1000000"),
    "µg": Decimal("0.001"),
    "ug": Decimal("0.001"),
    "mcg": Decimal("0.001"),
}


def pull_psp_bom_into_formulation(
    *,
    organization: Any,
    formulation: Any,
    actor: Any,
) -> dict:
    """Wholesale-replace a formulation's finished-stage BOM with the
    active primary BOM PSP has for the linked finished-product item.

    Steps (all inside one transaction so a mid-pull failure leaves
    NPD untouched):

    1. Cut a ``FormulationVersion`` snapshot BEFORE the pull with an
       auto-label so the pre-pull state is always in the version
       drawer (recoverable via rollback).
    2. Fetch the BOM from PSP (raise ``PspBomNotFound`` on 404).
    3. For every line, mirror the raw material into the local
       ``psp_mirror`` catalog (idempotent via ``psp_source_uuid``).
    4. Delete every existing ``FormulationLine`` on the finished
       stage. Semi-finished stages' lines are left alone.
    5. Create fresh lines for the finished stage with
       ``label_claim_mg`` converted from ``qty`` × UOM. Purity and
       overage overrides pin to 100 / 0 so the compute pass-through
       matches what PSP just handed us — the scientist can adjust
       later.

    Returns a summary dict the caller renders in a toast:

        {
          "lines_pulled": 10,
          "items_mirrored": 3,
          "items_reused": 7,
          "unconvertible_uom_lines": ["capsules", "bottles"],
          "pre_pull_version_number": 6,
        }

    Raises:
      * ``PspNotConfigured`` — org has no live PSP integration.
      * ``PspFinishedProductNotLinked`` — formulation not linked.
      * ``PspBomNotFound`` — PSP returned no primary BOM.
      * ``PspBomEmpty`` — PSP BOM has zero lines.
    """

    from django.db import transaction

    from apps.formulations.models import FormulationLine, FormulationStage
    from apps.formulations.services import save_version

    if not is_psp_live(organization):
        raise PspNotConfigured(
            "PSP is not configured or is disabled on this workspace."
        )
    if not formulation.psp_finished_product_uuid:
        raise PspFinishedProductNotLinked(
            "This formulation has no linked PSP finished product yet."
        )

    config = get_psp_config(organization=organization)
    client = _client_factory(config)

    payload = client.get_item_bom(formulation.psp_finished_product_uuid)
    if not payload:
        raise PspBomNotFound(
            "PSP has no primary BOM for the linked finished-product item."
        )
    raw_lines = payload.get("lines") or []
    if not raw_lines:
        raise PspBomEmpty("PSP's BOM has no component lines.")

    # Snapshot the pre-pull state so an accidental overwrite is
    # recoverable from the version drawer. Uses save_version so all
    # its side effects (audit + compute cache + BOM push retry) fire
    # exactly as they would for a normal save.
    pre_pull_version = save_version(
        formulation=formulation,
        actor=actor,
        label="pre-pull-from-psp",
    )

    # Reload so we see any concurrent edits + the freshly saved
    # version number.
    formulation.refresh_from_db()

    with transaction.atomic():
        finished_stage = (
            formulation.stages.filter(psp_item_type="finished_product")
            .order_by("sort_order")
            .first()
        )
        if finished_stage is None:
            # Fall back to the last stage — matches the server-side
            # invariant used everywhere else.
            finished_stage = (
                formulation.stages.order_by("-sort_order").first()
            )
        # If there are no stages at all yet, seed one so the pulled
        # lines have somewhere to land. Scientists typically create
        # stages first, but we shouldn't block the pull on it.
        if finished_stage is None:
            finished_stage = FormulationStage.objects.create(
                formulation=formulation,
                sort_order=0,
                name="Finished product",
                stage_key="custom",
                psp_item_type="finished_product",
            )

        items_mirrored = 0
        items_reused = 0
        unconvertible: list[str] = []
        new_lines: list[FormulationLine] = []

        for display_order, raw_line in enumerate(raw_lines):
            part_payload = raw_line.get("part") or {}
            part_uuid = str(part_payload.get("uuid") or "").strip()
            if not part_uuid:
                continue

            existed_before = _has_mirror_row(
                organization=organization, psp_uuid=part_uuid
            )
            mirrored_item = mirror_psp_item(
                organization=organization,
                actor=actor,
                psp_item_uuid=part_uuid,
            )
            if existed_before:
                items_reused += 1
            else:
                items_mirrored += 1

            qty_raw = raw_line.get("qty") or "0"
            try:
                qty_dec = Decimal(str(qty_raw))
            except (InvalidOperation, TypeError):
                qty_dec = Decimal("0")
            uom_symbol = (raw_line.get("uom_symbol") or "").strip().lower()
            factor = _UOM_TO_MG.get(uom_symbol)
            if factor is None:
                # Store the raw qty as mg so the row still lands and
                # the scientist can adjust. Track the flagged UOM.
                if uom_symbol:
                    unconvertible.append(uom_symbol)
                label_claim_mg = qty_dec
            else:
                label_claim_mg = qty_dec * factor

            new_lines.append(
                FormulationLine(
                    formulation=formulation,
                    item=mirrored_item,
                    stage=finished_stage,
                    display_order=display_order,
                    label_claim_mg=label_claim_mg,
                    purity_override=Decimal("100"),
                    overage_override=Decimal("0"),
                    notes=(raw_line.get("notes") or "").strip(),
                )
            )

        # Wholesale-replace: drop only the finished stage's lines. Any
        # semi-finished stage's lines survive so the multi-stage
        # cascade stays intact — matches the user's "only finished
        # stage" scope decision.
        FormulationLine.objects.filter(
            formulation=formulation, stage=finished_stage
        ).delete()
        FormulationLine.objects.bulk_create(new_lines)

    return {
        "lines_pulled": len(new_lines),
        "items_mirrored": items_mirrored,
        "items_reused": items_reused,
        "unconvertible_uom_lines": sorted(set(unconvertible)),
        "pre_pull_version_number": getattr(
            pre_pull_version, "version_number", None
        ),
    }


def _has_mirror_row(*, organization: Any, psp_uuid: str) -> bool:
    """Return True when the PSP UUID already has a local mirror row.
    Used by ``pull_psp_bom_into_formulation`` to distinguish "newly
    mirrored" from "reused an existing mirror" in the response
    summary, without an extra DB call downstream."""

    from apps.catalogues.models import PSP_MIRROR_SLUG, Item

    return Item.objects.filter(
        catalogue__organization=organization,
        catalogue__slug=PSP_MIRROR_SLUG,
        psp_source_uuid=psp_uuid,
    ).exists()


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
