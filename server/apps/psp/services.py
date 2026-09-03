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
    #: PSP-side stock UoM the item is procured / stored in — bag of
    #: ``{"uuid", "symbol", "dimension"}``. Populated from PSP's
    #: ``stock_uom`` block on the item read shape. ``None`` for legacy
    #: PSP builds that predate the exposure OR items whose stock_uom
    #: wasn't set on PSP.
    #:
    #: Load-bearing for the BOM push cascade — an item with
    #: ``dimension == "count"`` (bottle, closure, capsule shell, label)
    #: must NOT receive a mass-tagged (mg/kg) push, or PSP's
    #: ``BOMLine.changeset`` dimension guard rejects it. NPD reads this
    #: field to auto-tag such rows as ``source_unit=pcs`` when the FE
    #: snapshot lacks an explicit tag.
    stock_uom_uuid: str | None = None
    stock_uom_symbol: str | None = None
    stock_uom_dimension: str | None = None


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


class PspSampleCoSyncMissingItem(PspError):
    """A sample trial batch tried to sync its customer-order to PSP
    but the parent formulation isn't linked to a PSP finished-product
    item yet (``Formulation.psp_finished_product_uuid IS NULL``).

    Loud fail rather than silent-degrade: the MO create that follows
    would also error (``sample_co_not_found`` from PSP) but with a
    generic "sync the sample CO first" message that doesn't point
    at the real cause. Raising here lets the API layer surface a
    scientist-actionable "link the formulation to a PSP finished
    product first" hint on the trial-batch page.
    """

    code = "psp_sample_co_sync_missing_item"

    def __init__(self, *, formulation_pk: Any) -> None:
        self.formulation_pk = formulation_pk
        super().__init__(
            f"Formulation {formulation_pk} has no psp_finished_product_uuid — "
            f"link it to a PSP finished product before spawning a sample MO."
        )


class PspPackagingComboItemsNotMirrored(PspError):
    """Trial batch's packaging combo has one or more items that
    haven't been mirrored to PSP. The MO create would silently
    strip them from the BOM overlay and the batch would run
    without packaging — a compliance failure we refuse rather
    than allow.

    Attach the offending item names + combo name so the API layer
    can point the scientist straight at what to fix in Settings →
    Items (mirror the pouch / bottle / cap from PSP's catalog).
    """

    code = "psp_packaging_combo_items_not_mirrored"

    def __init__(self, *, combo_name: str, missing_item_names: list[str]) -> None:
        self.combo_name = combo_name
        self.missing_item_names = missing_item_names
        joined = ", ".join(missing_item_names) or "(unknown)"
        super().__init__(
            f"Packaging combo {combo_name!r} contains items not mirrored "
            f"to PSP: {joined}. Sync them from PSP's item catalog before "
            f"running this MO."
        )


class PspDecryptionFailed(Exception):
    """Stored ciphertext could not be decrypted (typically because
    the shared secret key was rotated without re-encrypting)."""

    code = "psp_decryption_failed"


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------


#: Hard ceiling on a single PSP round-trip. The picker fires inline
#: during a modal open — anything longer than 2 seconds stalls the
#: operator more than the "no PSP match" fallback would. Tightened
#: from 4 s → 2 s because a slow PSP that pins Django workers for
#: 4 s each cascades into pool saturation under load. Matches the
#: MRPEasy ceiling for consistency.
_PSP_TIMEOUT_SECONDS = 2.0

#: Circuit-breaker window. When PSP times out N times in a row the
#: client trips open and returns cached "unreachable" for the next
#: ``_PSP_CB_COOLDOWN_SECONDS`` seconds without ever hitting the
#: network — protects Django workers from queueing behind a slow
#: PSP while it recovers. Cleared by the first successful call.
_PSP_CB_THRESHOLD = 3
_PSP_CB_COOLDOWN_SECONDS = 30


class _PspCircuitBreaker:
    """Process-local circuit breaker for the PSP HTTP client.

    Not distributed (each Daphne worker keeps its own state); good
    enough for the failure shape we're guarding against — a PSP
    outage will trip the breaker on every worker within seconds
    after they each observe their first N failures. Redis-backed
    coordination is the natural next step if we ever run more than
    a few workers, but the in-process variant already prevents the
    request-worker-pool-saturation failure mode.
    """

    def __init__(self) -> None:
        self._consecutive_failures = 0
        self._open_until: float = 0.0

    def is_open(self) -> bool:
        import time

        return time.monotonic() < self._open_until

    def record_success(self) -> None:
        self._consecutive_failures = 0
        self._open_until = 0.0

    def record_failure(self) -> None:
        import time

        self._consecutive_failures += 1
        if self._consecutive_failures >= _PSP_CB_THRESHOLD:
            self._open_until = time.monotonic() + _PSP_CB_COOLDOWN_SECONDS


_PSP_BREAKER = _PspCircuitBreaker()


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

        # Fast-fail while the breaker is open. Skips the 2 s block on
        # every worker for the cooldown window when PSP is down.
        if _PSP_BREAKER.is_open():
            raise PspUnreachable(
                "PSP circuit breaker is open — recent calls timed out. "
                "Retrying automatically in a few seconds."
            )

        try:
            with urlopen(req, timeout=_PSP_TIMEOUT_SECONDS) as resp:
                raw = resp.read()
        except HTTPError as exc:
            # 4xx responses are still "PSP is up" — don't trip the
            # breaker on validation errors / rate-limits. Only pool-
            # saturating shapes (timeouts, connection errors) do.
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
                _PSP_BREAKER.record_success()
                return None
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
            _PSP_BREAKER.record_failure()
            raise PspUnreachable(
                f"Couldn't reach PSP: {exc.reason}"
            ) from exc
        except (TimeoutError, OSError) as exc:
            _PSP_BREAKER.record_failure()
            raise PspUnreachable(
                f"PSP timed out after {_PSP_TIMEOUT_SECONDS} s: {exc}"
            ) from exc

        _PSP_BREAKER.record_success()
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
        npd_formulation_uuid: Any = None,
        project_type: str = "trial",
        due_date: Any = None,
        notes: str = "",
        packaging_combo_items: Any = None,
        npd_sample_payment_uuid: Any = None,
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
        # Formulation UUID is optional on PSP; only include when we have
        # one so a payload from an unlinked / legacy trial doesn't send
        # ``"None"``. PSP uses it to build the Output QC → NPD deep-link
        # (`/formulations/{uuid}/qc/`).
        if npd_formulation_uuid:
            body["npd_formulation_uuid"] = str(npd_formulation_uuid).strip()
        if due_date:
            body["due_date"] = str(due_date)
        # Packaging overlay is a three-state signal on PSP:
        #
        #   * absent            → no overlay (default packaging BOM)
        #   * ``[]``            → overlay active, no items to book
        #                         (sample with no combo picked =
        #                         loose bulk output)
        #   * populated list    → overlay active, substitute these
        #                         for packaging-typed BOM lines
        #
        # ``packaging_combo_items is None`` collapses to the first
        # bucket (skip the key entirely). Trial batches always land
        # here.
        if packaging_combo_items is not None:
            body["packaging_combo_items"] = packaging_combo_items
        # Sample fulfilment link. When set, PSP resolves the sample
        # CO (uuid = this value) + its line and pins the MO's
        # ``customer_order_line_id``. That's what lands the MO on the
        # /projects kanban attached to the correct customer. Absent on
        # trial-kind MOs and manually-created samples (no source
        # payment) — MO still lands, just orphaned from a project.
        if npd_sample_payment_uuid:
            body["npd_sample_payment_uuid"] = str(npd_sample_payment_uuid).strip()

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

    def sync_trial_validation(
        self,
        *,
        npd_trial_batch_uuid: Any,
        validation_uuid: Any,
        status: str,
        failure_reason: str | None = None,
    ) -> dict:
        """POST ``/api/integration/trial-validations/sync``.

        Push the current ProductValidation state to PSP so its Output QC
        gate for the paired trial MO can (a) unblock the operator's pass
        button when we reach ``passed``, or (b) auto-fail the output lot
        when we reach ``failed``.

        Idempotent — a resend of the same status is a 200 no-op on
        PSP's side. Fires ``failure_reason`` only for ``failed`` (PSP
        rejects the payload otherwise).

        Raises :class:`PspUnreachable` on any non-2xx.
        """

        body: dict[str, Any] = {
            "npd_trial_batch_uuid": str(npd_trial_batch_uuid or "").strip(),
            "validation": {
                "uuid": str(validation_uuid or "").strip(),
                "status": status,
            },
        }
        if status == "failed":
            # PSP refuses ``failed`` without a reason so the auto-fail
            # LotEvent has something to render. Empty string ⇒ nil on
            # PSP; the controller's guard returns 400 if truly missing.
            body["validation"]["failure_reason"] = failure_reason or ""

        response = self._request(
            "api/integration/trial-validations/sync",
            method="POST",
            body=body,
        )
        if not isinstance(response, dict):
            raise PspUnreachable(
                "PSP returned no body for trial-validation sync."
            )
        return response

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

    def list_customer_order_invoices(self, co_uuid: Any) -> list[dict]:
        """GET ``/api/integration/customer-orders/:uuid/invoices``.

        Returns the list of ``CustomerInvoice`` records attached to a
        CO on PSP. Powers NPD's finance-payment detail page so the
        accountant sees invoices without switching apps.

        Silent-degrade: returns ``[]`` on any transport failure /
        404 — the caller renders "no invoices yet" and the finance
        user can still record their payment.
        """

        cleaned = str(co_uuid or "").strip()
        if not cleaned:
            return []
        response = self._request(
            f"api/integration/customer-orders/{cleaned}/invoices"
        )
        if not isinstance(response, dict):
            return []
        raw = response.get("invoices")
        return raw if isinstance(raw, list) else []

    def list_customer_order_release_documents(self, co_uuid: Any) -> list[dict]:
        """GET ``/api/integration/customer-orders/:uuid/release-documents``.

        Returns metadata for every Final Product Release file on the
        CO's root MO — powers the customer portal's Release documents
        card. Silent-degrade returns ``[]`` on any failure so the
        portal renders nothing instead of blocking the page.

        Shape: ``[{uuid, kind, filename, mime, byte_size, uploaded_at}, ...]``.
        """

        cleaned = str(co_uuid or "").strip()
        if not cleaned:
            return []
        response = self._request(
            f"api/integration/customer-orders/{cleaned}/release-documents"
        )
        if not isinstance(response, dict):
            return []
        raw = response.get("documents")
        return raw if isinstance(raw, list) else []

    def fetch_customer_order_release_document(
        self, co_uuid: Any, file_uuid: Any
    ) -> tuple[bytes, str, str] | None:
        """GET ``/api/integration/customer-orders/:uuid/release-documents/:file_uuid``.

        Streams raw bytes for proxy-download from the portal. Returns
        ``(bytes, mime, filename)`` on 200 or ``None`` on any non-2xx
        / transport failure. Filename is parsed from
        ``Content-Disposition`` so the portal can suggest the right
        save-as name.

        Uses stdlib ``urllib`` to match the rest of :class:`PspClient`.
        Content-Type from PSP flows through as-is (e.g.
        ``application/pdf``) so the portal can render inline.
        """

        cleaned_co = str(co_uuid or "").strip()
        cleaned_file = str(file_uuid or "").strip()
        if not cleaned_co or not cleaned_file:
            return None

        base = self._config.base_url.rstrip("/")
        url = (
            f"{base}/api/integration/customer-orders/"
            f"{cleaned_co}/release-documents/{cleaned_file}"
        )
        headers = {
            "X-Integration-Token": self._auth_header,
            "User-Agent": "VitaNPD/1.0",
        }
        req = Request(url, method="GET", headers=headers)
        try:
            with urlopen(req, timeout=_PSP_TIMEOUT_SECONDS) as resp:
                bytes_body = resp.read()
                mime = resp.headers.get(
                    "Content-Type", "application/octet-stream"
                )
                filename = _parse_filename_from_content_disposition(
                    resp.headers.get("Content-Disposition", "")
                )
        except (HTTPError, URLError):
            return None

        return bytes_body, mime, filename

    def get_customer_order_dispatch(self, co_uuid: Any) -> dict | None:
        """GET ``/api/integration/customer-orders/:uuid/dispatch``.

        Returns the dispatch-confirmation snapshot (carrier, vehicle,
        driver, checklist, photos) for the CO's root-MO produced lot,
        or ``None`` on any failure / unknown CO. Powers the "Dispatch"
        card on the customer portal's sample detail page.

        The endpoint returns ``{"dispatch": null}`` when the shipment
        hasn't been ``picked_up`` yet — we surface that as ``None``
        too so the caller has one "nothing to show" branch.
        """

        cleaned = str(co_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/customer-orders/{cleaned}/dispatch"
        )
        if not isinstance(response, dict):
            return None
        dispatch = response.get("dispatch")
        return dispatch if isinstance(dispatch, dict) else None

    def confirm_customer_order_delivery(
        self, co_uuid: Any, *, recipient_signatory: str, delivery_notes: str = ""
    ) -> dict | None:
        """POST ``/api/integration/customer-orders/:uuid/dispatch/confirm-delivery``.

        Customer-driven POD. Body:

            {"recipient_signatory": "Alex Baker",
             "delivery_notes": "Arrived intact"}

        Returns PSP's ``{"dispatch": {status, delivered_at, ...}}``
        response body on success, or ``None`` on any failure (already
        delivered, invalid state, transport). Callers should re-read
        the sample detail after a success so the FE Dispatch card
        picks up the new ``delivered`` state.
        """

        cleaned = str(co_uuid or "").strip()
        signatory = (recipient_signatory or "").strip()
        if not cleaned or not signatory:
            return None

        payload: dict[str, str] = {"recipient_signatory": signatory}
        notes = (delivery_notes or "").strip()
        if notes:
            payload["delivery_notes"] = notes

        response = self._request(
            f"api/integration/customer-orders/{cleaned}/dispatch/confirm-delivery",
            method="POST",
            body=payload,
        )
        return response if isinstance(response, dict) else None

    def confirm_customer_order_event_delivery(
        self,
        co_uuid: Any,
        event_uuid: Any,
        *,
        recipient_signatory: str,
        delivery_notes: str = "",
    ) -> dict | None:
        """``POST /api/integration/customer-orders/:uuid/dispatch/pickup-events/:event_uuid/confirm-delivery``.

        Per-event customer-driven POD. Each pickup event confirms
        independently — the customer taps "Confirm receipt" on the
        Tuesday truck's row without touching Thursday's row.
        """

        cleaned_co = str(co_uuid or "").strip()
        cleaned_event = str(event_uuid or "").strip()
        signatory = (recipient_signatory or "").strip()
        if not cleaned_co or not cleaned_event or not signatory:
            return None

        payload: dict[str, str] = {"recipient_signatory": signatory}
        notes = (delivery_notes or "").strip()
        if notes:
            payload["delivery_notes"] = notes

        response = self._request(
            f"api/integration/customer-orders/{cleaned_co}/dispatch/pickup-events/{cleaned_event}/confirm-delivery",
            method="POST",
            body=payload,
        )
        return response if isinstance(response, dict) else None

    def submit_customer_order_routing_choice(
        self, co_uuid: Any, *, choice: str
    ) -> dict | None:
        """POST ``/api/integration/customer-orders/:uuid/routing-choice``.

        Portal-driven customer routing decision on a bespoke
        NPD-formulation CO. Body: ``{"choice": "three_pl" | "shipment"}``.

        Returns PSP's ``{"routing_request": {...}}`` echo on success —
        the caller upserts the local ``PspProductionStatus.routing_request``
        with this so the portal card reflects the new state without
        waiting for PSP's next production_status push.

        Returns ``None`` on any transport / validation error.
        """

        cleaned = str(co_uuid or "").strip()
        if not cleaned or choice not in ("three_pl", "shipment"):
            return None

        response = self._request(
            f"api/integration/customer-orders/{cleaned}/routing-choice",
            method="POST",
            body={"choice": choice},
        )
        if not isinstance(response, dict):
            return None
        request_row = response.get("routing_request")
        return request_row if isinstance(request_row, dict) else None

    def fetch_customer_order_dispatch_photo(
        self, co_uuid: Any, file_uuid: Any
    ) -> tuple[bytes, str, str] | None:
        """GET ``/api/integration/customer-orders/:uuid/dispatch/photos/:file_uuid``.

        Streams raw bytes for proxy-download from the portal. Returns
        ``(bytes, mime, filename)`` on 200 or ``None`` on any non-2xx
        / transport failure. Photos are typically ``image/jpeg`` or
        ``image/png``; the portal renders them inline in the dispatch
        card thumbnails.

        Uses stdlib ``urllib`` to match :meth:`fetch_customer_order_release_document`.
        """

        cleaned_co = str(co_uuid or "").strip()
        cleaned_file = str(file_uuid or "").strip()
        if not cleaned_co or not cleaned_file:
            return None

        base = self._config.base_url.rstrip("/")
        url = (
            f"{base}/api/integration/customer-orders/"
            f"{cleaned_co}/dispatch/photos/{cleaned_file}"
        )
        headers = {
            "X-Integration-Token": self._auth_header,
            "User-Agent": "VitaNPD/1.0",
        }
        req = Request(url, method="GET", headers=headers)
        try:
            with urlopen(req, timeout=_PSP_TIMEOUT_SECONDS) as resp:
                bytes_body = resp.read()
                mime = resp.headers.get(
                    "Content-Type", "application/octet-stream"
                )
                filename = _parse_filename_from_content_disposition(
                    resp.headers.get("Content-Disposition", "")
                ) or "dispatch-photo"
        except (HTTPError, URLError):
            return None

        return bytes_body, mime, filename

    def get_customer_order_snapshot(self, co_uuid: Any) -> dict | None:
        """GET ``/api/integration/customer-orders/:uuid/snapshot``.

        Returns PSP's :func:`OrderWizard.snapshot` projected to the
        customer-safe fields — just the phase key + coarse counts.
        Deliberately excludes PSP's ``phase.label`` /
        ``next_action.title`` / ``next_action.detail`` /
        ``blockers`` because those are written for operators
        ("Open MO MO00051 to finish bookings") and shouldn't
        reach a customer surface. The NPD side does its own copy
        lookup keyed on ``phase.key``.

        Shape:

            {"snapshot": {
                "phase": {"key", "index", "total", "is_terminal"},
                "mo_count", "mos_in_production"
            }}

        Returns ``None`` on 404 (unknown CO uuid on PSP) or on any
        transport failure — the portal treats absent snapshot as
        "PSP hasn't seen this order yet" and falls back to the MO-
        chain-only pipeline path.
        """

        cleaned = str(co_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/customer-orders/{cleaned}/snapshot"
        )
        if not isinstance(response, dict):
            return None
        return response

    def create_customer_fulfilment_request(self, payload: dict) -> dict | None:
        """POST ``/api/integration/customer-fulfilment-requests``.

        Portal-triggered dispatch request — a customer clicked
        "Request dispatch" on their /portal/warehouse page. PSP
        creates a ``pending`` three_pl_dispatches row that lands on
        the mobile picker queue; a warehouse operator completes the
        physical send-out on mobile exactly as they would for a
        staff-typed request.

        Payload shape (see the Elixir controller):

            {
              "customer_uuid": "…",
              "lot_uuid": "…",
              "qty": "150",
              "reference": "…" (optional),
              "notes": "…" (optional),
              "source": "portal" (default),
              "external_reference": nil (Phase 3 will fill)
            }

        Returns PSP's response body (dispatch snapshot) on success;
        bubbles ``PspError`` on transport failure or 4xx so the
        portal view can map to a validation error the customer
        sees ("Not enough stock on hand", "Lot not found", etc.).
        """

        response = self._request(
            "api/integration/customer-fulfilment-requests",
            method="POST",
            body=payload,
        )
        if not isinstance(response, dict):
            return None
        return response

    def get_customer_bailee_inventory(self, customer_uuid: Any) -> dict | None:
        """GET ``/api/integration/customer-bailee-inventory/:customer_uuid``.

        Returns PSP's snapshot of the finished-goods stock we hold in
        bailee custody for that customer — one row per lot, plus a
        summary section with lot count / total qty / total held m³ /
        total accrued storage charge. Powers the portal warehouse-
        visibility page.

        Shape (mirrored from
        :mod:`BackendWeb.IntegrationCustomerBaileeInventoryController`):

            {
              "customer": {"uuid": "…", "name": "…"},
              "currency": "GBP",
              "rate_per_m3_per_day": "1.5000",
              "summary": {
                "lot_count": …, "total_qty_on_hand": "…",
                "total_held_volume_m3": "…", "total_accrued_charge": "…"
              },
              "lots": [ {lot payload} … ]
            }

        Returns ``None`` on 404 (unknown customer uuid on PSP) or on
        any transport failure — the portal treats absent snapshot as
        "no held stock right now" and renders the empty-state copy.
        """

        cleaned = str(customer_uuid or "").strip()
        if not cleaned:
            return None
        response = self._request(
            f"api/integration/customer-bailee-inventory/{cleaned}"
        )
        if not isinstance(response, dict):
            return None
        return response

    def sync_sample_customer_order(self, payload: dict) -> dict | None:
        """Push a sample-fulfilment payload to PSP so a CO is created
        (or refreshed) for a customer sample run.

        Sibling of :meth:`sync_customer_order`, keyed on
        ``npd_sample_payment_uuid`` instead of ``npd_formulation_uuid``.
        One CO per customer-sample pair — that's the identity model
        that solves the RTG shared-catalog problem (a single RTG
        formulation is ordered by many customers, so the formulation
        uuid can't be the CO uuid).

        On PSP, the same ``resolve_customer`` helper the commercial
        sync uses runs the dedupe: existing PSP customer wins via
        ``npd_source_uuid``, name-match soft-dedupes and back-fills
        the identity, and a new customer is only created when
        nothing matches.

        Returns PSP's response body on success. Bubbles PspError on
        transport failure — callers should catch + log-and-continue
        so a flaky PSP never blocks a scientist's Create MO click.
        """

        response = self._request(
            "api/integration/customer-orders/sync-sample",
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
        # PSP started exposing ``stock_uom`` on the item read shape in
        # ``feat(integration): expose stock_uom on /items``. Older PSP
        # builds omit the key — degrade to None so pre-exposure
        # servers keep working without crashing the mapper.
        stock_uom_uuid=(
            str(row["stock_uom"].get("uuid"))
            if isinstance(row.get("stock_uom"), dict) and row["stock_uom"].get("uuid")
            else None
        ),
        stock_uom_symbol=(
            str(row["stock_uom"].get("symbol") or "").strip().lower() or None
            if isinstance(row.get("stock_uom"), dict)
            else None
        ),
        stock_uom_dimension=(
            str(row["stock_uom"].get("dimension") or "").strip().lower() or None
            if isinstance(row.get("stock_uom"), dict)
            else None
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
            "customer_delivery_address": "",
        }
    # Prefer the company name (that's what appears on invoices and the
    # kanban); fall back to the contact person when the client is a
    # sole trader with no company set.
    company = (getattr(customer, "company", "") or "").strip()
    contact_name = (getattr(customer, "name", "") or "").strip()
    display = company or contact_name
    # Portal-profile delivery address is our single source of truth
    # for where a customer's goods ship. PSP mirrors it onto the
    # linked CustomerOrder so the shipment form's paperwork step
    # prefills without the coordinator retyping data the customer
    # already saved on /portal/settings.
    delivery_address = (getattr(customer, "delivery_address", "") or "").strip()
    return {
        "customer_uuid": str(getattr(customer, "id", "") or ""),
        "customer_display_name": display,
        "customer_contact_name": contact_name,
        "customer_delivery_address": delivery_address,
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

    Invoked from the ``in_review → approved`` transition AND on every
    subsequent save_version once the sheet is approved. Director
    signature is always set at that point; customer signature (kiosk
    portal) may follow later and is included when present so PSP's
    MO-create trust card can render "customer signed on X" without
    a round-trip back to NPD.
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
        "spec_customer_signed_at": _iso(
            getattr(sheet, "customer_signed_at", None)
        ),
        "spec_customer_signed_by_name": (
            getattr(sheet, "customer_name", "") or ""
        ).strip()
        or None,
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
    # (``PspClient.merge_customer_orders_from_proposal``) creates the
    # CO on PSP; *after that* label / header / photo updates from
    # this path must reach it (otherwise the LabelArtworkCard + hero
    # image never light up on the PSP project page). LabelDesign
    # existence is the reliable "a customer has ordered" proxy: it
    # only bootstraps after a customer signs a spec, which requires
    # a committed proposal.
    from apps.formulations.models import ProjectType

    if getattr(formulation, "project_type", None) == ProjectType.READY_TO_GO:
        from apps.label_design.models import LabelDesign

        has_label_design = LabelDesign.objects.filter(
            formulation_id=formulation.id
        ).exists()
        if not has_label_design:
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
        # Project flavour. Lets PSP's ``upsert_from_npd`` decide
        # whether to insert a new formulation-scoped CO (Custom) or
        # skip because the CO already exists per-proposal (RTG). Also
        # drives the RTG-safe branches on the proposal-merge path.
        "project_type": getattr(formulation, "project_type", "") or "",
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

    # Payments mirror — every save re-ships the full list so PSP's
    # invoice card reflects the current state of the finance queue
    # for this project (deposit / additional_samples / label_design
    # / final, in the order they landed). Empty list = "no finance
    # activity yet". PSP replaces its child rows to match — anything
    # in PSP but not in this list gets removed. See
    # ``_payments_for_formulation`` for the per-row shape.
    payload["payments"] = _payments_for_formulation(formulation)

    # Label supplementary artwork (back / side / bottle mockup views)
    # from the CURRENT revision. The primary PDF + PNG preview URLs
    # already ride the proposal-merge label state block; this list
    # covers the "extra views" gallery the operator sees on the PSP
    # project page. Empty when no current revision or no extras
    # attached.
    payload["label_files"] = _label_additional_assets_for_formulation(formulation)

    # Header image — one URL PSP renders on the projects dashboard +
    # detail hero. Priority: customer-approved label preview PNG →
    # first product photo the scientist uploaded → empty. NPD picks
    # so PSP doesn't have to fetch two upstream URLs and reason about
    # freshness.
    payload["header_image_url"] = _header_image_url_for_formulation(formulation)

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


def _payments_for_formulation(formulation: Any) -> list[dict]:
    """Every :class:`Payment` tied to this formulation, oldest first.

    Includes voided rows so PSP can render the full audit trail — the
    operator can see "we tried once, voided, took another payment"
    without switching apps.

    Nested ``files`` mirrors :func:`_sample_payment_payload` so PSP's
    per-payment file list uses the same shape whether the payment
    landed via the sample-flow sync or the main-formulation sync.
    """

    from apps.payments.models import Payment

    payments = (
        Payment.objects.filter(formulation_id=formulation.id)
        .prefetch_related("invoices")
        .order_by("paid_at")
    )

    result: list[dict] = []
    for payment in payments:
        amount = getattr(payment, "amount", None)
        paid_at = getattr(payment, "approved_at", None) or getattr(
            payment, "paid_at", None
        )
        files: list[dict] = []
        for pf in payment.invoices.all():
            files.append(
                {
                    "uuid": str(pf.id),
                    "filename": pf.filename or "",
                    "mime": pf.mime or "",
                    "byte_size": int(pf.byte_size or 0),
                    "uploaded_at": pf.uploaded_at.isoformat()
                    if pf.uploaded_at
                    else "",
                }
            )
        result.append(
            {
                "id": str(payment.id),
                "kind": payment.kind or "",
                "amount": format(amount, "f") if amount is not None else None,
                "currency": (payment.currency or "").strip(),
                "status": payment.status or "",
                "invoice_number": payment.invoice_number or "",
                "paid_at": paid_at.isoformat() if paid_at else None,
                "files": files,
            }
        )
    return result


def _label_additional_assets_for_formulation(formulation: Any) -> list[dict]:
    """List of supplementary-view assets on the current LabelDesign
    revision. Empty when no LabelDesign exists yet or the current
    revision has no extras.

    Emitted as a flat list of ``{uuid, label, content_type, filename,
    byte_size, file_url}`` so PSP can render an "Extra views" gallery
    on the project page without a second round-trip. ``file_url`` is
    absolute so a PSP browser can fetch it directly through the file
    proxy.
    """

    from apps.label_design.models import LabelDesign

    label = (
        LabelDesign.objects.filter(formulation_id=formulation.id)
        .select_related("current_revision")
        .first()
    )
    if label is None:
        return []
    revision = getattr(label, "current_revision", None)
    if revision is None:
        return []
    assets = getattr(revision, "additional_assets", None)
    if assets is None:
        return []

    result: list[dict] = []
    for asset in assets.all().order_by("sort_order"):
        file_url = _absolute_media_url(
            _safe_file_url(getattr(asset, "file", None))
        )
        if not file_url:
            continue
        result.append(
            {
                "uuid": str(asset.id),
                "label": asset.label or "",
                "content_type": asset.content_type or "",
                "filename": asset.original_filename or "",
                "byte_size": int(asset.size_bytes or 0),
                "file_url": file_url,
            }
        )
    return result


def _header_image_url_for_formulation(formulation: Any) -> str:
    """Pick one image URL for PSP to render as the project's header
    on the dashboard + detail page.

    Priority:
      1. Customer-approved LabelDesign's current-revision preview PNG.
      2. First :class:`FormulationPhoto` the scientist uploaded
         (``is_primary DESC, sort_order`` = model's default order).
      3. Empty string — PSP shows its neutral placeholder.
    """

    from apps.formulations.models import FormulationPhoto
    from apps.label_design.models import LabelDesign

    label = (
        LabelDesign.objects.filter(formulation_id=formulation.id)
        .select_related("current_revision")
        .first()
    )
    if _label_customer_approved_at(label) is not None:
        revision = getattr(label, "current_revision", None)
        # Preferred: a generated thumbnail from the PDF pipeline.
        preview_url = _absolute_media_url(
            _safe_file_url(getattr(revision, "artwork_preview_png", None))
        )
        if preview_url:
            return preview_url
        # Fallback: the ``artwork_pdf`` field accepts PNG / JPG too
        # (the field name is historical — it's the "final artwork"
        # slot regardless of extension). When the customer signed
        # off on a PNG / JPG, THAT file is the preview.
        artwork_file = getattr(revision, "artwork_pdf", None)
        artwork_name = (getattr(artwork_file, "name", "") or "").lower()
        if artwork_name.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")):
            artwork_url = _absolute_media_url(_safe_file_url(artwork_file))
            if artwork_url:
                return artwork_url

    photo = (
        FormulationPhoto.objects.filter(formulation_id=formulation.id)
        .order_by("-is_primary", "sort_order")
        .first()
    )
    if photo is not None:
        photo_url = _absolute_media_url(
            _safe_file_url(getattr(photo, "image", None))
        )
        if photo_url:
            return photo_url

    return ""


def maybe_resync_customer_address_to_psp(*, customer: Any) -> int:
    """Re-fire the sample-CO sync for every open sample payment tied
    to ``customer`` so PSP picks up a fresh ``delivery_address`` /
    contact update from the customer's portal profile edit.

    Called from the portal Settings save path. Silently degrades:

    * No customer → 0.
    * No matching payments → 0.
    * PSP integration off / unreachable → each per-payment sync bails
      internally; caller sees a 0-or-partial count with no exception.

    Returns the number of payments we attempted to resync (useful
    for logging). Sample payments are the only channel today because
    every portal-driven order lands as a ``FINAL`` payment on an
    RTG formulation — commercial custom-project COs come from the
    internal team, not the portal, so a portal profile edit never
    needs to touch them.
    """

    if customer is None:
        return 0

    from apps.payments.constants import PaymentKind, PaymentStatus
    from apps.payments.models import Payment

    # Pending + approved covers the "still shipping" window. Voided
    # payments don't move goods; their CO is a tombstone and the
    # shipping team wouldn't be prepping paperwork against them.
    open_statuses = (PaymentStatus.PENDING, PaymentStatus.APPROVED)
    qs = Payment.objects.filter(
        customer=customer,
        kind=PaymentKind.FINAL,
        status__in=open_statuses,
    ).select_related("formulation")

    resynced = 0
    for payment in qs.iterator():
        try:
            maybe_resync_sample_payment_to_psp(payment=payment)
            resynced += 1
        except Exception:
            # ``maybe_resync_sample_payment_to_psp`` already swallows
            # its own errors, but belt-and-braces so one bad payment
            # can't block a bulk profile save from processing the rest.
            logger.exception(
                "maybe_resync_customer_address_to_psp: unexpected failure "
                "on payment %s",
                payment.pk,
            )
    return resynced


def maybe_resync_payment_to_psp(*, payment: Any) -> None:
    """Fan-out for a payment lifecycle event (approve / void / file
    attach / file delete). Fires whichever PSP sync path applies:

    * RTG formulations → sample-flow sync (``sync_sample_customer_order``)
      as before — the sample CO is keyed on the payment id, not the
      formulation.
    * Custom formulations → main formulation sync
      (``sync_customer_order_to_psp``) so the ``payments`` list on the
      CO refreshes to include the newly approved / voided / re-filed
      row. This is the path that closes the "PSP invoice section is
      empty for custom projects" gap — before this hook the main sync
      never re-fired on a payment change.

    Silent-degrade end-to-end: no exception ever bubbles up. Callers
    treat this as fire-and-forget on ``transaction.on_commit`` so a
    downstream failure never rolls back the payment save.
    """

    from apps.formulations.models import ProjectType

    # RTG sample-CO path — early-return delegate. Keeps the historical
    # trial-batch sample-invoice card working exactly as it did.
    try:
        maybe_resync_sample_payment_to_psp(payment=payment)
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "maybe_resync_payment_to_psp: sample-path leg failed for "
            "payment %s (silent-degraded)",
            getattr(payment, "id", None),
        )

    # Custom-formulation path — re-fire the main sync so PSP's
    # ``customer_orders.npd_payments`` mirror picks up the fresh
    # payment row (or drops a voided row). Skipped for RTG (that's
    # what the sample path is for) and for anything without a
    # formulation attached (e.g. proposal-only deposits with no
    # formulation link).
    try:
        formulation = getattr(payment, "formulation", None)
        if formulation is None:
            return
        if getattr(formulation, "project_type", None) == ProjectType.READY_TO_GO:
            return
        sync_customer_order_to_psp(formulation=formulation)
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "maybe_resync_payment_to_psp: main-sync leg failed for "
            "payment %s (silent-degraded)",
            getattr(payment, "id", None),
        )


def maybe_resync_sample_payment_to_psp(*, payment: Any) -> None:
    """Best-effort re-sync of a sample payment's CO on PSP so the
    invoice card reflects the current payment state (files, status,
    invoice number, etc).

    Called from every payment lifecycle event that changes visible
    invoice data: approve, void, file upload, file delete. Bails
    silently when:

    * Payment isn't a sample (custom projects don't use this card yet).
    * No trial batch exists yet — nothing on PSP to update.
    * PSP integration off / unreachable — the change lands on the
      next natural sync (e.g. next Create MO click).

    Callers should treat this as fire-and-forget — no exception ever
    bubbles up.
    """

    from apps.payments.constants import PaymentKind
    from apps.formulations.models import ProjectType
    from apps.trial_batches.models import TrialBatch

    try:
        if payment is None or getattr(payment, "kind", None) != PaymentKind.FINAL:
            return
        formulation = getattr(payment, "formulation", None)
        if formulation is None:
            return
        if getattr(formulation, "project_type", None) != ProjectType.READY_TO_GO:
            # Custom-formulation payments don't use the sample-CO
            # path (their CO is keyed on formulation, not payment).
            return
        trial_batch = (
            TrialBatch.objects.filter(source_payment_id=payment.id)
            .select_related("formulation_version__formulation", "source_payment__customer")
            .order_by("-created_at")
            .first()
        )
        if trial_batch is None:
            # Payment approved but scientist hasn't created the MO
            # yet — nothing on PSP to update. Next Create MO click
            # will pick up the fresh payment state.
            return
        sync_sample_customer_order_to_psp(trial_batch=trial_batch)
    except Exception:
        logger.exception(
            "maybe_resync_sample_payment_to_psp: unexpected failure for "
            "payment %s (silent-degraded)",
            getattr(payment, "id", None),
        )


def _sample_payment_payload(payment: Any) -> dict:
    """Build the ``payment`` block shipped to PSP inside the sample
    sync payload.

    Includes the payment metadata (amount, invoice number, paid
    date, status) and the list of attached ``PaymentFile`` rows so
    PSP's CO detail card can render "N invoice files" without a
    second round-trip. File bytes stay on NPD — PSP receives only
    metadata (uuid, filename, mime, byte_size, uploaded_at).
    """

    if payment is None:
        return {}

    # ``paid_at`` is required on Payment (see models.py). ``approved_at``
    # is nullable until finance signs off. Prefer approved for the
    # "when did money land" story since it's the more meaningful
    # timestamp for a customer-facing invoice card.
    paid_at = getattr(payment, "approved_at", None) or getattr(payment, "paid_at", None)

    files = []
    file_qs = getattr(payment, "invoices", None)
    if file_qs is not None:
        # ``invoices`` is a reverse-FK manager; iterating hits the DB
        # exactly once. Payments typically carry 0-3 files.
        for pf in file_qs.all():
            files.append(
                {
                    "uuid": str(pf.id),
                    "filename": pf.filename or "",
                    "mime": pf.mime or "",
                    "byte_size": int(pf.byte_size or 0),
                    "uploaded_at": pf.uploaded_at.isoformat()
                    if pf.uploaded_at
                    else "",
                }
            )

    amount = getattr(payment, "amount", None)
    return {
        "id": str(payment.id),
        "amount": format(amount, "f") if amount is not None else None,
        "currency": getattr(payment, "currency", "") or "",
        "invoice_number": getattr(payment, "invoice_number", "") or "",
        "paid_at": paid_at.isoformat() if paid_at else None,
        "status": getattr(payment, "status", "") or "",
        "files": files,
    }


def _final_spec_state_for_proposal(proposal: Any) -> dict:
    """Build the FINAL-spec + FINAL-payment mirror block for the PSP
    proposal-merge payload.

    Six fields the ``customer_orders`` mirror needs to drive the
    ``:awaiting_final_spec`` phase and its promotion to
    ``:production_planning`` on FINAL-payment approve:

    * ``npd_customer_confirmed_done_at`` — set when the customer
      clicked "we're done" on the trial-batches portal card. Cleared
      when they later reject a FINAL (the reopen-cycle hook nulls it).
    * ``npd_final_spec_uuid`` / ``_status`` / ``_signed_at`` —
      identifies the ACTIVE FINAL sheet on the proposal's formulation
      (approved / sent / accepted). A rejected sheet is dead weight
      and contributes nothing — the customer told us to start over.
    * ``npd_final_spec_rejected_at`` — most recent rejection
      timestamp (any FINAL) so PSP can render a "customer rejected
      last time" audit badge on the trial-batches column card.
    * ``npd_final_payment_approved_at`` — finance approving the
      FINAL invoice. Its presence promotes PSP from
      ``:awaiting_final_spec`` to ``:production_planning``
      ("Need MO created") — production is authorised.

    A bundled proposal spans multiple formulations; the trial-batch /
    final-spec flow is per-formulation. The primary CO on PSP is the
    proposal's first line, so we key the lookup off THAT line's
    formulation to match how the deposit gate is keyed today.
    """

    from apps.payments.constants import PaymentKind, PaymentStatus
    from apps.payments.models import Payment
    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )
    from apps.trial_batches.models import TrialBatchCycle

    formulation_ids = list(
        proposal.lines.filter(
            formulation_version__formulation__isnull=False,
        )
        .values_list("formulation_version__formulation_id", flat=True)
        .distinct()
    )
    if not formulation_ids:
        return {
            "npd_customer_confirmed_done_at": None,
            "npd_final_spec_uuid": None,
            "npd_final_spec_status": None,
            "npd_final_spec_signed_at": None,
            "npd_final_spec_rejected_at": None,
            "npd_final_payment_approved_at": None,
        }

    # Primary CO on PSP is the first line's formulation. Trial-batch
    # cycles are per-formulation; we mirror the primary's cycle so
    # the primary CO card gets the phase promotion.
    primary_formulation_id = formulation_ids[0]

    cycle = TrialBatchCycle.objects.filter(
        formulation_id=primary_formulation_id
    ).first()
    # ``customer_confirmed_done_at`` is only stamped explicitly on the
    # "we're done" terminal-choice path (max-reached / team-closed →
    # customer clicks a follow-up prompt). The other happy path —
    # customer marks a slot as ``verdict=SATISFIED`` — auto-transitions
    # the cycle to ``SATISFIED`` (see ``cycle_services.record_slot_verdict``)
    # WITHOUT touching ``customer_confirmed_done_at`` because the
    # verdict itself IS the sign-off. From PSP's viewpoint both paths
    # are the same "customer said we're done with trials" milestone
    # that should promote the CO from ``:trial_batches_in_flight`` to
    # ``:awaiting_final_spec``. Fall back to the cycle's ``closed_at``
    # timestamp on the SATISFIED path so PSP's mirror flag lands
    # regardless of how the customer signalled done.
    from apps.trial_batches.models import TrialBatchCycleStatus
    confirmed_done_at = (
        cycle.customer_confirmed_done_at
        if cycle is not None and cycle.customer_confirmed_done_at is not None
        else (
            cycle.closed_at
            if cycle is not None
            and cycle.status == TrialBatchCycleStatus.SATISFIED
            else None
        )
    )

    # RTG multi-order isolation: for each downstream state below,
    # narrow to spec sheets + payments attached to THIS specific
    # proposal (not the whole formulation). Without this the second
    # RTG order's PSP CO would receive the first order's final-spec
    # status + payment timestamps and think it was already
    # production-authorised.
    from apps.proposals.models import ProposalLine

    proposal_line_spec_ids = list(
        ProposalLine.objects.filter(proposal=proposal)
        .exclude(specification_sheet__isnull=True)
        .values_list("specification_sheet_id", flat=True)
    )

    # Active FINAL — approved / sent / accepted. Rejected + draft +
    # in_review don't count. Prefer sheets linked to THIS proposal
    # (RTG-safe); fall back to any FINAL on the formulation for
    # legacy Custom sheets that predate the ProposalLine → spec link.
    active_final_qs = SpecificationSheet.objects.filter(
        document_kind=SpecificationDocumentKind.FINAL,
        status__in=(
            SpecificationStatus.APPROVED.value,
            SpecificationStatus.SENT.value,
            SpecificationStatus.ACCEPTED.value,
        ),
    )
    if proposal_line_spec_ids:
        active_final = (
            active_final_qs.filter(id__in=proposal_line_spec_ids)
            .order_by("-updated_at")
            .first()
        )
    else:
        active_final = (
            active_final_qs.filter(
                formulation_version__formulation_id=primary_formulation_id
            )
            .order_by("-updated_at")
            .first()
        )

    # Most recent rejection scoped the same way.
    rejected_qs = SpecificationSheet.objects.filter(
        document_kind=SpecificationDocumentKind.FINAL,
        status=SpecificationStatus.REJECTED.value,
    )
    if proposal_line_spec_ids:
        latest_rejected = (
            rejected_qs.filter(id__in=proposal_line_spec_ids)
            .order_by("-customer_rejected_at")
            .first()
        )
    else:
        latest_rejected = (
            rejected_qs.filter(
                formulation_version__formulation_id=primary_formulation_id
            )
            .order_by("-customer_rejected_at")
            .first()
        )

    # FINAL payment approval — the "production authorised" signal.
    # Scoped to this proposal so RTG order 2's CO isn't marked
    # authorised by order 1's payment approval.
    final_payment_approved_at = (
        Payment.objects.filter(
            formulation_id=primary_formulation_id,
            proposal=proposal,
            kind=PaymentKind.FINAL,
            status=PaymentStatus.APPROVED,
        )
        .order_by("-approved_at")
        .values_list("approved_at", flat=True)
        .first()
    )

    return {
        "npd_customer_confirmed_done_at": _iso_or_none(confirmed_done_at),
        "npd_final_spec_uuid": (
            str(active_final.id) if active_final is not None else None
        ),
        "npd_final_spec_status": (
            active_final.status if active_final is not None else None
        ),
        "npd_final_spec_signed_at": _iso_or_none(
            getattr(active_final, "customer_signed_at", None)
        ),
        "npd_final_spec_rejected_at": _iso_or_none(
            getattr(latest_rejected, "customer_rejected_at", None)
        ),
        "npd_final_payment_approved_at": _iso_or_none(final_payment_approved_at),
    }


def _label_design_state_for_proposal(proposal: Any) -> dict:
    """Build the label-design mirror block for the PSP proposal-merge
    payload.

    Keyed off the primary line's formulation (same rule as
    ``_final_spec_state_for_proposal``). The label workflow is
    per-formulation; a bundled multi-product proposal today mirrors
    only its primary product's label — the other products' label
    workflows live on their split-back R&D COs after unmerge.

    Nine fields land on ``customer_orders``:

    * ``npd_label_design_uuid`` — the ``LabelDesign`` row id (also the
      URL segment on ``/labelling/[id]``). Absence == "no workflow yet".
    * ``npd_label_status`` — one of the nine ``LabelDesignStatus``
      values.
    * ``npd_label_design_path`` — ``design_by_us`` / ``design_by_customer``
      / "" until the customer picks.
    * ``npd_label_approved_at`` — customer's e-sign timestamp (the
      terminal signal). Null on every non-terminal state.
    * ``npd_label_rejection_count`` — consecutive customer rejects.
      Bumped by ``transition_status``; auto-hold routes at 3.
    * ``npd_label_updated_at`` — freshness anchor from the
      ``LabelDesign.updated_at`` column.
    * ``npd_label_preview_png_url`` — absolute URL to the current
      revision's PNG thumbnail. Rendered on PSP's kanban card + R&D
      team card. Empty when no revision uploaded yet.
    * ``npd_label_pdf_url`` — absolute URL to the current revision's
      full artwork PDF.
    * ``npd_label_url`` — deep-link to ``/labelling/[id]`` on NPD.
    """

    empty = {
        "npd_label_design_uuid": None,
        "npd_label_status": None,
        "npd_label_design_path": None,
        "npd_label_approved_at": None,
        "npd_label_rejection_count": None,
        "npd_label_updated_at": None,
        "npd_label_preview_png_url": None,
        "npd_label_pdf_url": None,
        "npd_label_url": None,
    }

    from apps.label_design.models import LabelDesign

    formulation_ids = list(
        proposal.lines.filter(
            formulation_version__formulation__isnull=False,
        )
        .values_list("formulation_version__formulation_id", flat=True)
        .distinct()
    )
    if not formulation_ids:
        return empty

    primary_formulation_id = formulation_ids[0]
    label = (
        LabelDesign.objects.filter(formulation_id=primary_formulation_id)
        .select_related("current_revision")
        .first()
    )
    if label is None:
        return empty

    revision = label.current_revision
    return {
        "npd_label_design_uuid": str(label.id),
        "npd_label_status": label.status,
        "npd_label_design_path": label.design_path or "",
        "npd_label_approved_at": _iso_or_none(_label_customer_approved_at(label)),
        "npd_label_rejection_count": label.rejection_count,
        "npd_label_updated_at": _iso_or_none(label.updated_at),
        "npd_label_preview_png_url": _absolute_media_url(
            _safe_file_url(getattr(revision, "artwork_preview_png", None))
        ),
        "npd_label_pdf_url": _absolute_media_url(
            _safe_file_url(getattr(revision, "artwork_pdf", None))
        ),
        "npd_label_url": _label_design_url(label),
    }


def _label_design_url(label: Any) -> str:
    """Deep link to the /labelling/[id] workspace on NPD."""

    from django.conf import settings as django_settings

    base = (getattr(django_settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base or not label:
        return ""
    return f"{base}/labelling/{label.id}/"


def _label_customer_approved_at(label: Any) -> Any:
    """Return the moment the customer's approval landed, regardless
    of design path.

    ``LabelDesign.customer_approved_at`` is only stamped on the
    ``design_by_us`` path (customer signs off *our* artwork via the
    explicit CUSTOMER_APPROVAL step). On ``design_by_customer`` the
    customer's approval is implicit in the upload — captured on the
    revision as ``customer_approved_own_design=True`` — and there's
    no separate approval step to stamp the label row. Fall back to
    the revision's submit time so downstream mirrors (PSP header
    image, PSP LabelArtworkCard gate) treat the workflow as approved
    on both paths.
    """

    if label is None:
        return None
    if label.customer_approved_at is not None:
        return label.customer_approved_at
    revision = getattr(label, "current_revision", None)
    if revision is not None and getattr(
        revision, "customer_approved_own_design", False
    ):
        return getattr(revision, "submitted_at", None)
    return None


def _safe_file_url(file_field: Any) -> str:
    """Django ``FieldFile.url`` raises ``ValueError`` when the field
    has no attached file. Every ``_absolute_media_url`` caller wants
    an empty string in that case, so wrap the ``.url`` access here
    once instead of ``try / except`` at each call site.
    """

    if file_field is None:
        return ""
    if not getattr(file_field, "name", None):
        return ""
    try:
        return file_field.url or ""
    except (ValueError, AttributeError):
        return ""


def _absolute_media_url(relative_or_empty: str) -> str:
    """Prefix a Django-storage ``.url`` with APP_BASE_URL so a PSP
    browser can fetch it. Django returns paths like ``/media/…`` for
    local FileSystemStorage; those need a scheme + host before they'll
    load on a different origin. Azure-backed storage already returns
    absolute URLs — return them untouched.
    """

    if not relative_or_empty:
        return ""
    if relative_or_empty.startswith(("http://", "https://")):
        return relative_or_empty

    from django.conf import settings as django_settings

    base = (getattr(django_settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base:
        return ""
    return f"{base}{relative_or_empty}"


def _bundled_deposit_paid_at(proposal: Any):
    """Earliest ``approved_at`` across every approved DEPOSIT Payment
    tied to one of the proposal's formulations. Returns ``None`` when
    no deposit has landed yet — presence of this timestamp is what
    flips the PSP kanban phase to ``:trial_batches_in_flight``.
    """

    from apps.payments.constants import PaymentKind, PaymentStatus
    from apps.payments.models import Payment

    formulation_ids = list(
        proposal.lines.filter(
            formulation_version__formulation__isnull=False,
        ).values_list("formulation_version__formulation_id", flat=True).distinct()
    )
    if not formulation_ids:
        return None
    return (
        Payment.objects.filter(
            formulation_id__in=formulation_ids,
            kind=PaymentKind.DEPOSIT,
            status=PaymentStatus.APPROVED,
        )
        .order_by("approved_at")
        .values_list("approved_at", flat=True)
        .first()
    )


def _trial_batch_cycle_payload_fragment(
    trial_batch: Any, formulation: Any
) -> dict:
    """Return the cycle-context fields for the sample-CO sync payload.

    Empty dict when the trial batch isn't linked to a
    :class:`TrialBatchSlot` — storefront sample-kit batches (the
    audit's existing path) never populate the cycle fields, so the
    PSP mirror columns stay nil.
    """

    slot = getattr(trial_batch, "cycle_slot", None)
    if slot is None:
        return {}
    cycle = getattr(slot, "cycle", None)
    if cycle is None:
        return {}
    reference = (getattr(formulation, "code", "") or "").strip()
    return {
        "npd_trial_slot_sequence_no": slot.sequence_no,
        "npd_trial_slot_total": cycle.total_slots,
        "parent_customer_order_reference": reference,
    }


def sync_sample_customer_order_to_psp(
    *,
    trial_batch: Any,
    mo_quantity: Any | None = None,
) -> dict | None:
    """Push a sample-fulfilment CO sync to PSP for a sample trial batch.

    Called from :func:`create_psp_manufacturing_order_for_trial_batch`
    before the MO create — PSP needs the sample CO (with the correct
    customer resolved via its dedupe logic) to exist first so the MO
    can link back to it via ``customer_order_line_id``.

    Two identity paths:

    * **Storefront sample-kit** — ``TrialBatch.source_payment`` set
      by the R&D Samples fulfilment queue. Sample uuid =
      ``source_payment.id``; customer = ``source_payment.customer``.
    * **Cycle-slot sample** — ``TrialBatch.cycle_slot`` set by the
      trial-batch cycle flow, ``source_payment`` is null (the cycle
      is funded by a bundled deposit, not per-slot). Sample uuid =
      ``trial_batch.id``; customer = ``formulation.customer``. This
      is what makes the cycle sample MO land on the PSP /projects
      kanban with its own sample CO row (same shape a storefront
      sample gets), so the scientist can follow it through PSP's
      wizard end-to-end.

    Silent-degradation contract, same as
    :func:`sync_customer_order_to_psp`:

    * PSP integration off / decryption failed → ``None``, no log.
    * PSP unreachable / rate-limited / auth failed → warn + ``None``.
    * Cycle-slot batch with no ``formulation.customer`` → ``None``
      (no customer identity to send).
    * Legacy manual-created batch (no source payment AND no cycle
      slot) → ``None``. Same as before.

    Returns PSP's response body on success — the caller pins the
    returned CO's uuid on the MO payload as ``npd_sample_payment_uuid``
    so the receiving controller can locate the CO's line.
    """

    if trial_batch is None:
        return None

    formulation_version = getattr(trial_batch, "formulation_version", None)
    formulation = (
        getattr(formulation_version, "formulation", None)
        if formulation_version is not None
        else None
    )
    if formulation is None:
        return None

    source_payment = getattr(trial_batch, "source_payment", None)
    cycle_slot = getattr(trial_batch, "cycle_slot", None)
    if source_payment is not None:
        sample_uuid = str(source_payment.id)
        sample_customer = getattr(source_payment, "customer", None)
        sample_payment_block = _sample_payment_payload(source_payment)
    elif cycle_slot is not None:
        # Cycle-slot fallback — batch has no per-slot payment (cycle
        # is funded by the bundled deposit), so identity comes off
        # the **cycle slot** (not the trial batch) and the customer
        # from the parent formulation. Payment block is empty ({}
        # not a dict skip) so the PSP invoice card renders "no
        # per-sample payment" rather than a null crash.
        #
        # Identity was ``trial_batch.id`` until a scientist reported
        # duplicated PSP COs after deleting + recreating a batch for
        # the same slot. Each new batch has a fresh UUID → PSP's
        # ``upsert_sample_from_npd`` lookup missed → new CO row
        # spawned per batch instead of one canonical CO per slot.
        # ``cycle_slot.id`` is stable across batch churn (the slot
        # outlives every batch attached to it), so the PSP CO is
        # now reliably one-per-slot regardless of how many times
        # the scientist redrafts.
        sample_uuid = str(cycle_slot.id)
        sample_customer = getattr(formulation, "customer", None)
        sample_payment_block = {}
    else:
        # Legacy scientist-created batch with no source payment AND
        # no cycle slot. Nothing to attach to — MO push still works,
        # the sample CO just doesn't spawn on PSP.
        return None
    if sample_customer is None:
        return None

    organization = getattr(formulation, "organization", None)
    if organization is None:
        return None
    if not is_psp_live(organization):
        return None

    item_uuid = getattr(formulation, "psp_finished_product_uuid", None)
    if not item_uuid:
        # Loud fail — the follow-up MO push would silently error with
        # ``sample_co_not_found`` (misleading; the CO simply doesn't
        # exist yet because the sync silently returned None). Raising
        # a typed exception lets the API layer surface a scientist-
        # actionable "link the formulation to a PSP finished product
        # first" hint. The caller ``create_psp_manufacturing_order_for_trial_batch``
        # doesn't catch this — it propagates through the API's
        # PspError handler and lands on the scientist's toast.
        logger.warning(
            "sync_sample_customer_order_to_psp: formulation %s has no "
            "psp_finished_product_uuid; raising for API layer to surface",
            formulation.pk,
        )
        raise PspSampleCoSyncMissingItem(formulation_pk=formulation.pk)

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        logger.exception(
            "PSP config decryption failed for org %s", organization.pk
        )
        return None

    label = (getattr(trial_batch, "label", "") or "").strip()

    payload = {
        "npd_sample_payment_uuid": sample_uuid,
        "item_uuid": str(item_uuid),
        # Formulation id — pipe it through so PSP can persist it on
        # the sample CO. Without this, any MO the PSP operator
        # creates from the wizard's "Create MO for line" button lands
        # without an NPD formulation link, breaking the R&D
        # validation flow (which needs a formulation to validate
        # against) and NPD's trial-batch page (which shows "MO
        # connected but no chain" when it can't find the MO via the
        # linkage). The scientist's "Create MO on PSP" button
        # already sends this per-MO — we're just closing the same
        # gap on the sample-CO-first path.
        "npd_formulation_uuid": str(formulation.id),
        # Project flavour ("custom" | "ready_to_go"). PSP persists on
        # the CO row and downstream surfaces gate on it — most
        # visibly, the output-qc "Trial batch validation required"
        # card hides on RTG (RTG's FINAL-spec approval IS the
        # recipe-validation gate). The commercial-CO sync already
        # sends this on ``sync_customer_order_to_psp``; the sample
        # sync was missing it, so RTG customer-paid samples landed
        # on PSP without the flag and hit the Custom-safe fallback.
        "npd_project_type": (
            getattr(formulation, "project_type", "") or ""
        ),
        # Sample CO line qty. When the caller already knows the
        # actual PSP MO qty (i.e. this sync is being fired from
        # ``create_psp_manufacturing_order_for_trial_batch`` after
        # the size_mode + servings-per-pack normalisation has
        # landed a real number), we use THAT — so the CO line
        # matches the physical run. Falls back to
        # ``trial_batch.batch_size_units`` for callers without a
        # resolved MO qty (which land as a "planned scale" figure
        # on the CO line; the wizard's fulfilment-tolerance gate
        # already excludes ``sample_kind`` COs from its shortfall
        # check on the PSP side so a mismatch here doesn't fire a
        # false ``:awaiting_shortfall_resolution`` block anymore).
        # Historical bug: before this parameter existed, the sync
        # always sent ``batch_size_units``. If the scientist typed
        # "3 gummies" on the Create-MO modal (``size_mode=units``,
        # PSP MO landed at 0.05 packs), the CO line still showed
        # 20 packs (the cycle-slot's default batch size) and the
        # wizard read it as a massive shortfall.
        "quantity": (
            str(mo_quantity)
            if mo_quantity is not None
            else str(getattr(trial_batch, "batch_size_units", 1) or 1)
        ),
        "sample_label": label,
        "formulation_name": (getattr(formulation, "name", "") or "").strip(),
        "formulation_code": (getattr(formulation, "code", "") or "").strip(),
        # Reuse the commercial-sync helpers so a customer already
        # synced via a Custom project stays deduped on the PSP side.
        **_customer_identity(sample_customer),
        # Same R&D team + deep-link payload the commercial sync uses
        # so /projects can render the same "R&D lead" / "Sales" chips
        # on a sample CO.
        "lead_scientist_name": _person_display_name(
            getattr(formulation, "lead_scientist", None)
        ),
        "sales_person_name": _person_display_name(
            getattr(formulation, "sales_person", None)
        ),
        "app_url": _formulation_app_url(organization, formulation),
        # NPD payment mirror — PSP's CO detail invoice card renders
        # this instead of the default "Generate invoice" prompt.
        # Sample orders don't produce PSP-side invoices (finance
        # already processed the payment on NPD). Cycle-slot samples
        # pass an empty payment block — no per-slot payment exists;
        # the deposit that funded the cycle lives on the parent CO.
        "payment": sample_payment_block,
        # Trial-batch cycle mirror — non-empty only when this trial
        # batch was created for a slot in a
        # ``TrialBatchCycle``. Drives the "↳ Trial N/M · <ref>"
        # badge on the PSP /projects kanban so scientists can see
        # which sample MO cards are siblings of the same custom-
        # formulation project. PSP looks up the parent CO uuid
        # itself via the npd_formulation_uuid match; we send the
        # denormalised reference (formulation code) so the badge
        # renders without a second query.
        **_trial_batch_cycle_payload_fragment(trial_batch, formulation),
    }

    try:
        client = _client_factory(config)
        return client.sync_sample_customer_order(payload)
    except PspError:
        logger.exception(
            "PSP sync_sample_customer_order failed for org %s "
            "trial_batch %s payment %s",
            organization.pk,
            trial_batch.pk,
            source_payment.pk,
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
            # PSP stage uuid the whole combo defaults to (the routing
            # tab picks). Resolved once outside the item loop — every
            # item without an explicit override rides this stage.
            combo_stage_psp_uuid = _resolve_stage_psp_uuid(
                combo.stage, formulation
            )
            for row in combo.items.select_related("item", "stage").all():
                if row.item_id is None:
                    continue
                # Per-item stage override wins over the combo default
                # so scientists can split bottle → bottling stage and
                # label → labelling stage on the same combo. Falls back
                # to the combo default (which itself can be null on
                # in-progress combos) so pre-Option-A combos ship
                # exactly as they did before.
                item_stage_psp_uuid: str | None = None
                if row.stage_id is not None:
                    item_stage_psp_uuid = _resolve_stage_psp_uuid(
                        row.stage, formulation
                    )
                effective_stage_uuid = (
                    item_stage_psp_uuid or combo_stage_psp_uuid
                )
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
                        # PSP-side stage identity. ``psp_stage_uuid`` is
                        # the semi-finished item uuid on intermediate
                        # stages and ``None`` on the finished stage
                        # (PSP resolves finished-stage overlays against
                        # the root MO). Overlay booking on PSP walks
                        # the MO tree to find the child whose
                        # ``item.uuid`` matches; when it doesn't, the
                        # item falls back to the root MO — preserving
                        # legacy behaviour for pre-Option-A payloads.
                        "psp_stage_uuid": effective_stage_uuid,
                    }
                )

        # Per-line sample allocation state — drives PSP's
        # ``:awaiting_sample_selection`` kanban column. Value is
        # the raw ``SampleAllocation.status`` (``draft`` /
        # ``confirmed``) or ``None`` when the allocation row
        # doesn't exist yet (customer hasn't opened the picker).
        # PSP's ``derive_phase`` reads this to decide whether the
        # post-sign CO sits in "Choose samples" or has advanced to
        # "Awaiting R&D payment".
        allocation_status: str | None = None
        allocation_qty: int | None = None
        try:
            from apps.payments.models import SampleAllocation as _SA

            _alloc = _SA.objects.filter(formulation=formulation).only(
                "status", "quantity_ordered"
            ).first()
            if _alloc is not None:
                allocation_status = _alloc.status
                allocation_qty = _alloc.quantity_ordered
        except Exception:  # noqa: BLE001 — never break sync on a lookup
            pass

        # Authoritative run quantity for PSP.
        #
        # Custom flow: prefer the customer-ACCEPTED FINAL spec's
        # quantity — the FINAL is a per-project document and its
        # modal explicitly frames the quantity input as "the last
        # time you can change the run size — once the customer signs
        # it's locked". Fall back to the proposal-line quantity when
        # no accepted FINAL exists (pre-FINAL, legacy rows).
        #
        # RTG flow: SKIP the FINAL lookup entirely. RTG's FINAL spec
        # is a director-signed CATALOG template, not a per-order
        # document — its ``quantity`` is a template placeholder
        # (typically 1) representing "one pack of the finished
        # product", NOT the customer's ordered pack count. If we let
        # the Custom logic apply here, every RTG order silently
        # collapses to qty=1 on PSP regardless of what the customer
        # actually paid for (observed: PROP-0002 was for 1500 packs
        # of RTG00001, MO00143 was created with quantity=1 because
        # the accepted FINAL spec's template quantity=1 overrode the
        # proposal line's 1500). The proposal line's ``quantity`` IS
        # the authoritative customer-order size for RTG.
        #
        # Lazy import to avoid a specs → psp import cycle at boot.
        from apps.formulations.models import ProjectType as _ProjectType
        from apps.specifications.models import (
            SpecificationDocumentKind as _SDK,
            SpecificationSheet as _Sheet,
            SpecificationStatus as _SStatus,
        )

        is_rtg = (
            getattr(formulation, "project_type", "") == _ProjectType.READY_TO_GO.value
        )

        if is_rtg:
            authoritative_qty = int(line.quantity or 1)
        else:
            accepted_final = (
                _Sheet.objects.filter(
                    formulation_version__formulation=formulation,
                    document_kind=_SDK.FINAL.value,
                    status=_SStatus.ACCEPTED.value,
                )
                .order_by("-updated_at")
                .values_list("quantity", flat=True)
                .first()
            )
            authoritative_qty = (
                int(accepted_final)
                if accepted_final and int(accepted_final) > 0
                else int(line.quantity or 1)
            )

        line_payload.append(
            {
                "npd_formulation_uuid": str(formulation.id),
                "psp_finished_product_uuid": (
                    str(formulation.psp_finished_product_uuid)
                    if getattr(formulation, "psp_finished_product_uuid", None)
                    else None
                ),
                "quantity": authoritative_qty,
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
                "npd_sample_allocation_status": allocation_status,
                "npd_sample_allocation_quantity": allocation_qty,
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

    # Primary formulation for display. NPD's merge picks the first
    # line as the primary CO; PSP renders that CO with the primary's
    # customer-friendly name on the /projects kanban. Without a
    # ``name`` + ``code`` here, PSP falls back to whatever the CO's
    # ``customer_reference`` was BEFORE the merge — which on RTG is
    # the sample-kit label ("Ultimate Fat Burner Drink · Sample #3")
    # left over from ``sync_customer_order_to_psp``. The RTG kanban
    # card then reads like another sample and disappears from the
    # operator's mental map. Sending the display name + code here
    # gives PSP's ``apply_proposal_identity`` a canonical source that
    # overrides the stale sample label.
    from apps.client_portal.queries import formulation_display_name

    primary_formulation = (
        lines[0].formulation_version.formulation if lines else None
    )
    primary_display_name = (
        formulation_display_name(primary_formulation)
        if primary_formulation is not None
        else ""
    )
    primary_code = (
        getattr(primary_formulation, "code", "") or ""
        if primary_formulation is not None
        else ""
    ).strip()

    payload = {
        "npd_proposal_uuid": str(proposal.id),
        "npd_proposal_code": (getattr(proposal, "code", "") or "").strip(),
        "npd_proposal_url": _proposal_app_url(organization, proposal),
        # Primary formulation identity — powers PSP's CO display name
        # on the /projects kanban. See the block-comment above the
        # payload for why sending these is load-bearing on RTG.
        "primary_formulation_display_name": primary_display_name,
        "primary_formulation_code": primary_code,
        # Project flavour drives PSP's ``proposal_merge.fresh_merge``
        # branch — Custom reuses the existing formulation's CO (1:1
        # forever), RTG spawns a brand-new CO per proposal (catalog
        # products get ordered N times). Missing / empty string is
        # treated as Custom on the PSP side for safety.
        "npd_project_type": (
            getattr(primary_formulation, "project_type", "") or ""
            if primary_formulation is not None
            else ""
        ),
        # NPD-authoritative status. PSP mirrors it and derives the
        # wizard block from here (Awaiting approval → Ready to send
        # → Awaiting customer signature).
        "npd_proposal_status": getattr(proposal, "status", "") or "",
        # Customer-side sign timestamp — populated by
        # ``capture_customer_signature_on_proposal``. Drives PSP's
        # split of the ``sent`` proposal_status into distinct kanban
        # columns:
        #   * ``sent`` + ``npd_customer_signed_at is null`` → "Sent
        #     to client" (proposal in the customer's inbox, no
        #     action yet).
        #   * ``sent`` + ``npd_customer_signed_at`` populated →
        #     progresses through "Choose samples" then "Awaiting R&D
        #     payment" depending on the per-line
        #     ``npd_sample_allocation_status``.
        "npd_customer_signed_at": _iso_or_none(
            getattr(proposal, "customer_signed_at", None)
        ),
        # Bundled deposit+samples Payment approval timestamp for the
        # proposal's formulation. Presence flips the PSP kanban phase
        # from ":proposal_accepted" ("Awaiting R&D payment") to
        # ":trial_batches_in_flight" so operators see the cycle is
        # running. Looks up ONE approved DEPOSIT payment per
        # formulation on the proposal — a bundled proposal spans N
        # formulations but shares one deposit gate, so the earliest
        # approved deposit across the bundle drives the flip.
        "npd_deposit_paid_at": _iso_or_none(
            _bundled_deposit_paid_at(proposal)
        ),
        # FINAL-spec + FINAL-payment lifecycle mirror. Six columns
        # in one lookup — see ``_final_spec_state_for_proposal`` for
        # the "which sheet counts / what happened when" rules.
        # Rejection is self-healing: a rejected FINAL contributes
        # nothing here, and vita-cff's reopen-cycle hook clears
        # ``customer_confirmed_done_at`` on the trial cycle, so PSP
        # sees "no confirmed done + no active FINAL" and falls back
        # to ``:trial_batches_in_flight`` on the next derive_phase.
        **_final_spec_state_for_proposal(proposal),
        # Label-design workflow mirror. Nine columns in one lookup —
        # see ``_label_design_state_for_proposal`` for the exact
        # field list. Populated the moment vita-cff's LabelDesign
        # post_save signal fires on any workflow mutation (path
        # chosen, artwork uploaded, reviewer verdict, customer
        # approval). All nil when no LabelDesign row exists yet for
        # the primary formulation.
        **_label_design_state_for_proposal(proposal),
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


def _resolve_stage_psp_uuid(stage: Any, formulation: Any) -> str | None:
    """PSP-side identity for a formulation stage — the semi-finished
    item uuid on intermediate stages, ``None`` on the finished stage
    (PSP resolves finished-stage overlays against the root MO by
    default). Returns ``None`` when the stage hasn't been pushed yet
    or when the input is falsy so callers can safely chain into a
    combo-level fallback.

    Used by the packaging-combo push payload so PSP can route each
    overlay item to the specific stage MO in the tree it belongs to
    (bottle → bottling stage, label → labelling stage). Missing
    uuid ⇒ overlay falls back to the root MO, preserving legacy
    behaviour on formulations that haven't cascaded yet.
    """

    if stage is None:
        return None
    # Finished-product stage rides the root MO — no per-child
    # routing needed. Return None so the CO controller books the
    # item on the parent MO exactly as it always has.
    if str(getattr(stage, "psp_item_type", "") or "") == "finished_product":
        return None
    semi_uuid = getattr(stage, "psp_semi_finished_uuid", None)
    return str(semi_uuid) if semi_uuid else None


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
# Per-(org, item uuid) cache for PSP item metadata (chiefly stock_uom
# info consumed by the BOM push cascade to decide count-vs-mass row
# tagging). Filled lazily by :func:`_get_psp_item_cached` on the
# first push that references an item; subsequent pushes hit the
# cache. Cleared alongside the UoM cache via
# :func:`_reset_psp_unit_cache`. Cached ``None`` explicitly to short-
# circuit repeated lookups of items PSP doesn't know about.
_PSP_ITEM_CACHE: dict[tuple[Any, str], Any] = {}
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


def _get_psp_item_cached(
    client: "PspClient | None", organization: Any, uuid: Any
) -> Any:
    """Fetch a PSP item by uuid via an in-process cache.

    The BOM push cascade previously issued one ``get_item`` call per
    unique item per push to learn its ``stock_uom`` (needed for the
    count-vs-mass auto-tag guard). For a Kyrgyz-shape formulation
    (~10 unique items across the stage graph) that adds up to ~10
    sequential HTTP round-trips just for stock UoM — 9+ seconds in
    dev, worse in prod with real latency.

    Cache eliminates the repeat cost across pushes AND deduplicates
    within the SAME push (the caller's per-push iteration already
    unique-ifies by ``Item.id``, but keying the cache on ``(org_pk,
    uuid)`` means a second stage push in the same request costs
    zero.

    Cached ``None`` for lookups PSP returned 404 on so a mistyped
    uuid doesn't retry every time. Callers that need cache
    invalidation (tests) can clear ``_PSP_ITEM_CACHE`` directly.
    """

    if client is None or organization is None or uuid in (None, ""):
        return None
    key = str(uuid).strip()
    if not key:
        return None
    org_key = getattr(organization, "pk", None) or getattr(organization, "id", None)
    cache_key = (org_key, key)
    if cache_key in _PSP_ITEM_CACHE:
        return _PSP_ITEM_CACHE[cache_key]
    try:
        item = client.get_item(key)
    except PspError:
        item = None
    except Exception:
        logger.exception(
            "PSP _get_psp_item_cached: unexpected error fetching PSP item %s",
            key,
        )
        item = None
    _PSP_ITEM_CACHE[cache_key] = item
    return item


def _psp_unit_info_by_uuid(
    client: "PspClient | None", organization: Any, uuid: Any
) -> dict[str, Any] | None:
    """Reverse lookup: UoM uuid → cache row. Used by the semi-stage
    SPOU auto-derivation which knows the stage's
    ``psp_item_stock_uom_uuid`` but not the symbol. Warms the catalog
    on first call, then scans (dozens of entries at most)."""

    if client is None or organization is None or uuid in (None, ""):
        return None
    key = str(uuid).strip()
    if not key:
        return None
    org_key = _load_psp_unit_catalog(client, organization)
    for (cache_org, _sym), info in _PSP_UNIT_INFO_CACHE.items():
        if cache_org == org_key and str(info.get("uuid")) == key:
            return info
    return None


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


def _convert_qty_to_target(
    qty: Decimal,
    source_symbol: str,
    target_symbol: str | None,
    *,
    client: "PspClient | None",
    organization: Any,
) -> tuple[Decimal, str | None, str | None]:
    """Convert ``(qty, source_symbol)`` into ``target_symbol`` — the
    child item's declared stock UoM. Returns
    ``(qty_in_target, target_symbol, target_uom_uuid)``.

    Fall-through chain (each preserves qty rather than dropping the
    line, so an integration hiccup never silently zeroes a recipe):

    * No target given / target unknown to PSP → normalise to the
      source dimension's base (legacy :func:`_convert_qty_to_base`
      behaviour) so the line still lands with a sensible UoM tag.
    * Source unknown to PSP → return the raw qty tagged with the
      target uuid so the display is at least labelled — quantity may
      be nominally wrong but the operator will see the mismatch and
      the PSP boundary check catches it on ingest.
    * Cross-dimension (source=mass, target=count) → return raw qty +
      source uuid; PSP's ``bom_line.changeset`` dimension guard
      rejects the mismatch loudly on ingest instead of us silently
      guessing a bridge.
    * Same-dimension → single multiply through the shared base
      (same math ``Backend.Units.convert/3`` uses).
    """

    if client is None or organization is None:
        return qty, target_symbol or source_symbol or None, None

    target_key = (target_symbol or "").strip().lower()
    tgt = (
        _psp_unit_info_for(client, organization, target_key)
        if target_key
        else None
    )
    if tgt is None:
        # No usable target — fall back to dimension-base normalisation.
        return _convert_qty_to_base(
            qty, source_symbol, client=client, organization=organization
        )

    src = _psp_unit_info_for(client, organization, source_symbol)
    if src is None or not src.get("dimension"):
        # Source is unrecognised. Ship as-is under the target label
        # so the UoM chip is at least honest — the boundary guard
        # will reject if it's actually wrong.
        return qty, tgt["symbol"], tgt["uuid"]

    if src["dimension"] != tgt["dimension"]:
        # Cross-dimension. Two branches:
        #
        # * mass ↔ volume — the only cross-dimension bridge we can
        #   safely apply is water density (1 g/mL). This is
        #   overwhelmingly the practical case: the compute layer
        #   emits water in mg (the gummy_water band's native
        #   ``waterMg``) but PSP tracks Deionised Water in L. Without
        #   this bridge every gummy BOM push post-water-auto-inject
        #   fails at PSP's boundary check → the whole cascade aborts
        #   → the finished-product BOM stays frozen → MO ships with
        #   the OLD packaging (MA01446 bit this today).
        #
        #   Density-1 assumption is water-density. Applied blindly for
        #   any non-water volume ingredient it'd produce numerically
        #   wrong figures — but supplements almost never use non-water
        #   volume ingredients, and the alternative (abort the whole
        #   push) is a worse silent-drift failure mode. Log a warning
        #   loud enough to spot in review if we ever have a
        #   non-water volume item.
        #
        # * mass ↔ count / volume ↔ count — no bridge. Return source-
        #   tagged qty and let PSP's dimension guard reject at the
        #   boundary, so the fault surfaces at the integration edge
        #   instead of deep in the MO parts table with a silently
        #   wrong unit.
        cross = tuple(sorted([src["dimension"], tgt["dimension"]]))
        if cross == ("mass", "volume"):
            # Density-1 bridge: 1 mL = 1 g (water assumption).
            #   qty_g = qty × factor_to_g   (source mass in g)
            #   qty_mL = qty_g              (density 1 g/mL)
            #   qty_target = qty_mL / target.factor_to_mL
            #
            # ``factor_to_base`` on mass uses g as base and on volume
            # uses mL as base per NPD's UoM seed (matches PSP's own
            # ``Backend.Units`` conversion table). Base-to-base is a
            # 1:1 exchange under density-1, so a single divide gets
            # us home.
            if src["dimension"] == "mass":
                base_mass_g = qty * src["factor_to_base"]
                converted_volume_ml = base_mass_g  # density 1 g/mL
                converted = converted_volume_ml / tgt["factor_to_base"]
            else:  # src is volume, tgt is mass
                base_volume_ml = qty * src["factor_to_base"]
                converted_mass_g = base_volume_ml  # density 1 g/mL
                converted = converted_mass_g / tgt["factor_to_base"]
            logger.info(
                "PSP push_bom: applied water-density (1 g/mL) bridge for "
                "%s (%s) → %s (%s). qty %s → %s.",
                source_symbol,
                src["dimension"],
                tgt["symbol"],
                tgt["dimension"],
                qty,
                converted,
            )
            return converted, tgt["symbol"], tgt["uuid"]

        logger.warning(
            "PSP push_bom: dimension mismatch — source %s (%s) → target %s (%s)."
            " Line will be rejected by PSP boundary check.",
            source_symbol,
            src["dimension"],
            tgt["symbol"],
            tgt["dimension"],
        )
        return qty, src["symbol"], src["uuid"]

    if src["uuid"] == tgt["uuid"]:
        # Source already in the target unit — skip the arithmetic.
        return qty, tgt["symbol"], tgt["uuid"]

    # Same-dimension convert: qty × source.factor_to_base / target.factor_to_base
    # gets us into the target unit exactly once. This mirrors
    # ``Backend.Units.convert/3`` on the PSP side.
    base_qty = qty * src["factor_to_base"]
    converted = base_qty / tgt["factor_to_base"]
    return converted, tgt["symbol"], tgt["uuid"]


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
        # Target unit = the child item's declared stock UoM. Every
        # line lands tagged in the item's own unit (kg powder → kg,
        # oil in ml → ml, capsule shell in pcs → pcs) instead of the
        # dimension base — so PSP's MO Parts table shows each item in
        # its native unit rather than everything homogenised to kg / L.
        target_symbol = _unit_symbol_for(item) or None
        source_kind = getattr(line, "source_kind", "active")
        if source_kind == "manual":
            # User typed qty in the item's native unit already —
            # source is the item's own unit, so the converter is a
            # no-op (or a same-dimension re-express if the operator
            # picked a display unit and the item is stored in a
            # sibling unit — rare but valid).
            source_qty = Decimal(str(raw_qty))
            source_symbol = target_symbol or "mg"
        else:
            # Actives + band picks: compute cascade is always mg per
            # serving. Scale to per-1-parent-unit then hand off to the
            # target-aware converter so mass items land in their own
            # mass unit (g / kg / mg) rather than being uniformly
            # collapsed to kg. Count / volume items are handled via
            # the source_unit-tagged override path — see
            # ``_override_to_bom_lines``.
            source_qty = Decimal(str(raw_qty)) * servings
            source_symbol = "mg"
        qty, _sym, uom_uuid = _convert_qty_to_target(
            source_qty,
            source_symbol,
            target_symbol,
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
        if uom_uuid:
            row["uom_uuid"] = uom_uuid
        elif client is not None and organization is not None:
            # Converter couldn't resolve either target or source
            # (dimension-less item + unknown source, or PSP catalog
            # unreachable). Fall back to the source-unit uuid so
            # downstream still gets a UoM label.
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
    shape.

    Each incoming row is
    ``{"item_id", "qty" | "mg", "source_unit"?, "sort_order"}``:

    * ``item_id`` — local ``catalogues.Item.id`` (mirrored so its
      ``psp_source_uuid`` is populated).
    * ``source_unit`` — ``"mg"`` for mass rows (actives, band picks,
      excipients), ``"pcs"`` for count rows (capsule shells, any
      packaging dropped into a stage), ``"ml"`` etc. Absent = legacy
      snapshot; interpreted as ``"mg"``.
    * ``qty`` — per-serving value in ``source_unit``. Legacy rows
      only carry ``mg``; new-shape rows use ``qty`` (with ``source_unit``
      naming the unit). Both keys are honoured so pre-refactor
      snapshots keep working.

    ``item_lookup_by_local_id`` maps each local id to
    ``{"psp_uuid": str, "unit": str}``. The child's declared ``unit``
    is the **target** we convert into — same-dimension source lands
    in the item's own unit (kg / g / mg / ml / pcs), so a powder with
    ``stock_uom=g`` lands as g and a capsule shell with
    ``stock_uom=pcs`` lands as pcs. Cross-dimension pairs (e.g. legacy
    mg row against a pcs item) fall through to PSP's boundary check
    rather than being silently converted through a guessed bridge.

    ``servings_per_output_unit`` scales per-serving value into the
    per-1-parent-unit that PSP's BOM math expects (defaults to 1.0).
    Works uniformly for mass (mg/serving × servings/pack = mg/pack)
    and count (1 shell/serving × 60 servings/pack = 60 shells/pack).

    ``client`` + ``organization`` — when both provided, each output
    line gets a ``uom_uuid`` tag so PSP renders the qty with its
    real unit label.

    Rows without a resolvable PSP uuid (unmirrored placeholders from
    empty picker bands) or with non-positive qty are dropped so the
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
        # Per-row source unit: ``mg`` for mass rows (actives, band
        # picks, excipients); ``pcs`` for count rows (capsule shells,
        # any packaging dropped into a stage BOM); ``ml`` etc. as
        # needed. Absent = legacy row, treat as mg — UNLESS the target
        # item's PSP stock UoM is count-dimension, in which case the
        # FE's "mg" field is actually the per-serving pcs count (the
        # compute path emits 1 for shells, 1/servings_per_pack for
        # packaging like bottles / closures / labels). Re-tag as pcs
        # so the target-aware converter doesn't ship a mass-tagged
        # line against a pcs item and hit PSP's boundary guard.
        #
        # This backend inference is load-bearing because the FE's
        # ``BomLine`` schema only tags ``sourceUnit=pcs`` on capsule
        # shells today — packaging rows arrive with no tag. Rather
        # than push a per-FE-branch fix (fragile, easy to miss for
        # future packaging types), we let PSP's authoritative
        # ``stock_uom.dimension`` drive the decision.
        raw_source_unit = str(row.get("source_unit") or "").strip().lower()
        if raw_source_unit:
            source_symbol = raw_source_unit
        else:
            target_dim = (info or {}).get("stock_uom_dimension", "").strip().lower()
            target_stock_symbol = (info or {}).get("stock_uom_symbol", "").strip().lower()
            if target_dim == "count" and target_stock_symbol:
                source_symbol = target_stock_symbol
            else:
                source_symbol = "mg"
        # ``qty`` is the new payload key (per-serving value in
        # ``source_unit``); ``mg`` is the legacy key retained for
        # backwards compat with pre-refactor snapshots. When the FE
        # emits an explicit ``source_unit`` it also sets ``qty``. When
        # source_unit is absent (legacy row OR auto-inferred pcs), the
        # value we care about lives on ``mg``.
        if raw_source_unit:
            raw_value = row.get("qty", row.get("mg"))
        else:
            raw_value = row.get("mg", row.get("qty"))
        try:
            value = (
                Decimal(str(raw_value)) if raw_value is not None else Decimal("0")
            )
        except (InvalidOperation, TypeError, ValueError):
            continue
        if value <= 0:
            continue
        # Per-serving → per-1-parent-unit. Works for both mass rows
        # (mg/serving × servings/pack = mg/pack) and count rows
        # where the qty scales with servings — capsule shells being
        # the canonical case (1 shell/serving × 60 servings/pack =
        # 60 shells/pack).
        #
        # ``is_per_output_unit`` opts a row OUT of that multiplication.
        # Set explicitly by the FE for :class:`FormulationLine` rows
        # whose ``stage_ratio_mode == "per_unit"`` — the operator has
        # explicitly said "this qty is per finished pack, not per
        # serving". Packaging is the canonical case: 1 pouch per pack,
        # NOT 1 pouch per serving.
        #
        # Belt-and-braces auto-detect: even without the explicit flag,
        # a target item whose ``psp_item_type == "packaging"`` gets
        # the same treatment. Packaging is definitionally per-pack
        # (bottle wraps 60 caps, pouch wraps 60 gummies, label sticks
        # on 1 container) — never per-serving. This defends against
        # the FE compensation math ever regressing (or a stale
        # pre-compensation snapshot being re-pushed like MA01446 v4
        # hit today). Without it, a 60-servings-per-pack gummy would
        # ship "60 pouches per pack" — exactly the bug the user
        # originally reported. The ``_bom_lines_from`` (non-override)
        # path already skips manual lines from the servings scaling
        # via its own manual branch; this keeps both entry points
        # aligned.
        is_per_output_unit = (
            bool(row.get("is_per_output_unit"))
            or (info or {}).get("item_type") == "packaging"
        )
        source_qty = value if is_per_output_unit else value * servings
        # Target UoM = child item's declared unit on NPD (which
        # mirrors its PSP stock_uom at item-push time). Same-dimension
        # source lands in the item's own unit; cross-dimension (e.g.
        # legacy mg row against a pcs item) surfaces at PSP's boundary
        # check instead of being silently kg-ified.
        target_symbol = info.get("unit") if info else None
        qty, _sym, uom_uuid = _convert_qty_to_target(
            source_qty,
            source_symbol,
            target_symbol or None,
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
        if uom_uuid:
            line_row["uom_uuid"] = uom_uuid
        elif client is not None and organization is not None:
            # Neither target nor source resolved. Tag with the source
            # unit's uuid so PSP still renders a label.
            fallback_uuid = _psp_uom_uuid_for(client, organization, source_symbol)
            if fallback_uuid:
                line_row["uom_uuid"] = fallback_uuid
        out.append(line_row)
    return out


def _bom_provenance(formulation: Any) -> dict:
    """Trust-card provenance for the BOM push payload.

    PSP records these fields on the ``boms`` row so its MO-create UI
    can prove which spec sheet the BOM was derived from and detect
    drift when a fresh push lands after the customer already signed.

    Latest customer-signed spec wins; otherwise fall back to the
    latest approved / sent sheet; otherwise leave the field null so
    PSP's trust card renders "No spec attached yet".
    """

    try:
        from apps.specifications.models import SpecificationSheet

        sheet = (
            SpecificationSheet.objects.filter(
                formulation_version__formulation=formulation,
                customer_signed_at__isnull=False,
            )
            .order_by("-customer_signed_at")
            .first()
        ) or (
            SpecificationSheet.objects.filter(
                formulation_version__formulation=formulation,
                director_signed_at__isnull=False,
            )
            .order_by("-director_signed_at")
            .first()
        )
    except Exception:  # noqa: BLE001 — silent-degrade
        sheet = None

    latest_version = (
        formulation.versions.order_by("-version_number").first()
        if hasattr(formulation, "versions")
        else None
    )

    return {
        "npd_spec_sheet_uuid": str(sheet.id) if sheet is not None else None,
        "npd_formulation_version_id": (
            str(latest_version.version_number)
            if latest_version is not None
            else None
        ),
    }


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
        **_bom_provenance(formulation),
    }
    return client.put_bom(formulation.psp_finished_product_uuid, payload)


def _persist_auto_derived_spou(stage: Any, derived: Decimal) -> None:
    """Write the derived SPOU back to
    :attr:`FormulationStage.servings_per_output_unit` when it differs
    from the stored value.

    Without this, the NPD builder's Routing preview keeps reading the
    stored default (usually 1) and mis-labels every downstream
    "stock-units for 1 finished unit" projection — even though the
    PSP-side cascade uses the correct auto-derived value at push time.
    Persisting closes the display / storage gap so the operator sees
    the same numbers on both surfaces.

    Silent no-op on any exception (missing pk, closed connection,
    schema drift) — we don't want a display-consistency helper to
    break a legit BOM push.
    """

    try:
        stored = getattr(stage, "servings_per_output_unit", None)
        current = Decimal(str(stored)) if stored is not None else Decimal("1")
    except (InvalidOperation, TypeError, ValueError):
        current = Decimal("1")

    if current == derived:
        return

    try:
        stage.servings_per_output_unit = derived
        stage.save(update_fields=["servings_per_output_unit"])
    except Exception:
        logger.exception(
            "PSP push_bom: failed to persist auto-derived SPOU on stage %s",
            getattr(stage, "id", "?"),
        )


def _is_pack_equivalent_semi(
    stage: Any,
    stages: list[Any] | None,
    finished_stage: Any | None,
) -> bool:
    """True when ``stage`` is the semi-finished stage that produces
    what the finished stage will label — i.e. its stock UoM matches
    the finished stage's AND no later semi in the chain also shares
    that UoM. In the classic capsules-in-a-bottle flow this identifies
    the Bottling stage (bottles) sitting just before a Labelling
    finished stage (bottles), while leaving the earlier Encapsulation
    stage (also stocked in ``pcs`` but per-capsule) at SPOU=1.

    Returns False when the chain isn't available (defensive path used
    by legacy callers that don't pass ``stages`` / ``finished_stage``).
    """

    if not stages or finished_stage is None:
        return False

    finished_uom = str(getattr(finished_stage, "psp_item_stock_uom_uuid", "") or "")
    stage_uom = str(getattr(stage, "psp_item_stock_uom_uuid", "") or "")
    if not finished_uom or stage_uom != finished_uom:
        return False

    stage_sort = getattr(stage, "sort_order", None)
    finished_sort = getattr(finished_stage, "sort_order", None)
    if stage_sort is None or finished_sort is None:
        return False
    if stage_sort >= finished_sort:
        # Only stages *before* the finished stage can be pack-equivalents.
        return False

    # Any OTHER semi with the same UoM that sits between this stage and
    # the finished stage? If yes, that later one is the real pack-
    # equivalent — this one is an earlier, per-unit stage.
    for other in stages:
        if getattr(other, "id", None) == getattr(stage, "id", None):
            continue
        if getattr(other, "psp_item_type", None) != "semi_finished":
            continue
        if str(getattr(other, "psp_item_stock_uom_uuid", "") or "") != finished_uom:
            continue
        other_sort = getattr(other, "sort_order", None)
        if other_sort is None:
            continue
        if stage_sort < other_sort < finished_sort:
            return False

    return True


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


def _semi_stage_servings(
    stage: Any,
    formulation: Any,
    *,
    stages: list[Any] | None = None,
    finished_stage: Any | None = None,
    client: "PspClient | None",
    organization: Any,
) -> Decimal:
    """Semi-finished stage's servings-per-output-unit — the number of
    servings that fit in 1 stock unit of the stage's PSP output item.

    Priority chain (each preserves the safest divisor for downstream
    prior-semi qty math, which is ``child_stage.SPOU / semi.SPOU``):

    1. Scientist explicitly set the value (> 1) on the stage → use it.
       They know the yield ratio for this specific batch, we don't
       overrule it.
    2. Semi's stock UoM is a mass unit and the formulation has a
       per-serving mass → derive
       ``SPOU = one_stock_unit_in_mg ÷ mg_per_serving``.
       (500 mg per capsule × 1 kg semi = 2000 caps ⇒ SPOU=2000.)
    3. Semi is the **pack-equivalent** in the chain — it shares the
       finished stage's stock UoM AND is the last such semi before
       the finished stage → inherit ``servings_per_pack``.
       (Bottling semi before a Labelling finished stage: 1 bottle =
       120 servings ⇒ SPOU=120.)
    4. Semi's stock UoM is count (``pcs``) → SPOU=1 (1 serving per
       piece — the natural convention for "each" / unit items like
       an Encapsulation stage that outputs individual capsules).
    5. Anything else (volume without a density bridge, missing catalog,
       unknown symbol, offline) → fall back to the raw stored value
       (default 1). Worst-case ships wrong qty like the old code did;
       the scientist fixes it on the Stages tab.

    Kills two classes of cascade error at once: the "3 kg of blend
    for 3 capsules" case (mass semi collapsing 1/1) AND the "120
    bottles per pack" case (pack-equivalent semi collapsing 120/1).
    """

    stored = _stage_servings(stage)
    if stored > Decimal("1"):
        return stored

    semi_uom_uuid = getattr(stage, "psp_item_stock_uom_uuid", None)
    if not semi_uom_uuid:
        return stored

    unit_info = _psp_unit_info_by_uuid(client, organization, semi_uom_uuid)
    if unit_info is None:
        return stored

    dimension = str(unit_info.get("dimension") or "").strip().lower()

    if dimension == "count":
        # Pack-equivalent check first: is this the last count semi
        # in the chain whose stock UoM matches the finished stage's
        # (a "Bottling" before a "Labelling" finished)? If so, 1
        # stock-unit of this semi IS one pack — inherit
        # ``servings_per_pack``. Earlier same-UoM semis
        # (Encapsulation before Bottling) are per-capsule ⇒ SPOU=1.
        if _is_pack_equivalent_semi(stage, stages, finished_stage):
            derived = _finished_stage_servings(formulation)
            _persist_auto_derived_spou(stage, derived)
            logger.info(
                "PSP push_bom: auto-derived pack-equivalent SPOU=%s for"
                " count-semi stage %s (%s) — inherited from finished stage",
                derived,
                getattr(stage, "id", "?"),
                unit_info.get("symbol"),
            )
            return derived

        # Individual-unit convention: 1 pc = 1 serving.
        derived = Decimal("1")
        _persist_auto_derived_spou(stage, derived)
        logger.info(
            "PSP push_bom: auto-derived SPOU=1 for count-semi stage %s (%s)",
            getattr(stage, "id", "?"),
            unit_info.get("symbol"),
        )
        return derived

    if dimension != "mass":
        # Volume / length / area / time — we'd need an item-specific
        # bridge (density for volume, etc.) to derive honestly. Bail
        # to the stored value rather than guessing.
        return stored

    # Mass path: convert 1 semi-stock-unit → mg via the shared
    # converter, then divide by per-serving mg.
    from apps.formulations.services import compute_formulation_totals

    try:
        totals = compute_formulation_totals(formulation=formulation)
    except Exception:
        logger.exception(
            "PSP push_bom: compute_formulation_totals failed for formulation %s;"
            " skipping SPOU auto-derive on stage %s",
            getattr(formulation, "pk", "?"),
            getattr(stage, "id", "?"),
        )
        return stored

    raw_mg = getattr(totals, "total_weight_mg", None)
    if raw_mg is None:
        return stored
    try:
        mg_per_serving = Decimal(str(raw_mg))
    except (InvalidOperation, TypeError, ValueError):
        return stored
    if mg_per_serving <= 0:
        return stored

    stock_unit_in_mg, _sym, _uuid = _convert_qty_to_target(
        Decimal("1"),
        unit_info["symbol"],
        "mg",
        client=client,
        organization=organization,
    )
    if stock_unit_in_mg is None or stock_unit_in_mg <= 0:
        return stored

    derived = stock_unit_in_mg / mg_per_serving
    if derived <= 0:
        return stored

    _persist_auto_derived_spou(stage, derived)
    logger.info(
        "PSP push_bom: auto-derived SPOU=%s for mass-semi stage %s"
        " (1 %s = %s mg ÷ %s mg/serving)",
        derived,
        getattr(stage, "id", "?"),
        unit_info["symbol"],
        stock_unit_in_mg,
        mg_per_serving,
    )
    return derived


def _finished_stage_servings(formulation: Any) -> Decimal:
    """Servings-per-output-unit for the FINISHED stage — always the
    formulation's ``servings_per_pack``.

    This helper enforces the contract that "1 finished stock unit on
    PSP == 1 pack (bottle / pouch / jar) on NPD." A finished stage's
    ``servings_per_output_unit`` field is redundant with
    ``servings_per_pack`` — they describe the same physical
    quantity ("how many servings inside one shippable pack"). The
    stage field was a per-stage-configurable escape hatch that
    scientists never touch, so it usually defaults to 1 → PSP thinks
    the MO produces N capsules instead of N packs and every
    downstream number looks 60× too big.

    By always deriving from ``servings_per_pack`` at push-time we:
    * make ``mo.quantity`` land on PSP as an honest pack count
      (15 for a 15-bottle sample, 0.01667 for a 1-capsule trial);
    * make BOM lines scale per-pack (60 caps × 30 mg = 1800 mg
      5-HTP per bottle);
    * eliminate the "must set SPOU manually on the finished stage"
      foot-gun forever.

    Semi-finished stages keep their own ``_stage_servings`` — the
    yield ratio there is a legitimate per-stage decision (a bulk-
    powder intermediate at 1 kg → N bottles depending on fill).

    Fallback to 1 for truly-flat formulations (bulk products with no
    pack concept). ``servings_per_pack = None`` shouldn't happen in
    practice for RTG products, but the fallback keeps the divisor
    safe on legacy rows.
    """

    raw = getattr(formulation, "servings_per_pack", None)
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

    # Build the local-item-id → {psp_uuid, unit, stock_uom_symbol,
    # stock_uom_dimension} lookup once, spanning every id referenced
    # across all overrides. One query beats N Item.get calls in the
    # per-stage loop. The unit fields feed ``_override_to_bom_lines``:
    #
    # * ``unit`` — local NPD Item.unit (frequently empty in practice
    #   because the mirror doesn't populate it).
    # * ``stock_uom_symbol`` / ``_dimension`` — pulled from PSP's item
    #   read shape and used as authoritative when local unit is
    #   empty. Count-dimension items (bottle, closure, shell, label)
    #   need the row shipped as ``source_unit=pcs`` or the boundary
    #   dimension guard rejects it — this is the load-bearing bit
    #   for packaging pushes.
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

            local_items = list(
                Item.objects.filter(
                    id__in=wanted_ids, psp_source_uuid__isnull=False
                ).only("id", "psp_source_uuid", "unit", "attributes")
            )
            # PSP-side stock UoM fetch — via a per-process cache so a
            # push referencing the same items again (retry, next cycle
            # slot, next stage) doesn't pay another PSP round-trip.
            # Local NPD ``Item.unit`` is frequently empty (mirror
            # doesn't persist it); when it IS set we skip the PSP
            # call entirely — the mass items path only needs to know
            # the item isn't count-dimension, which the presence of a
            # mass-shape local unit ("kg" / "g" / "mg" / "l" / "ml")
            # already tells us. Silent-degrade per item: a fetch
            # failure leaves that item's stock_uom_* empty, falling
            # back to the legacy "assume mg" behaviour rather than
            # blocking the push.
            MASS_VOL_UNITS = {"kg", "g", "mg", "l", "ml"}
            for item in local_items:
                local_unit = str(item.unit or "").strip().lower()
                stock_symbol: str | None = None
                stock_dimension: str | None = None

                # Fast path: local unit is a mass/volume symbol we
                # already recognise. No PSP fetch needed — the
                # dimension is unambiguous from the symbol itself.
                if local_unit in MASS_VOL_UNITS:
                    stock_symbol = local_unit
                    stock_dimension = "mass" if local_unit in {"kg", "g", "mg"} else "volume"
                elif client is not None:
                    psp_item = _get_psp_item_cached(
                        client, formulation.organization, item.psp_source_uuid
                    )
                    if psp_item is not None:
                        stock_symbol = getattr(psp_item, "stock_uom_symbol", None)
                        stock_dimension = getattr(psp_item, "stock_uom_dimension", None)

                # PSP item type — inferred from the local ``Item.attributes.
                # psp_item_type`` mirror (set by the item-import sync).
                # Load-bearing for the packaging autodetect below:
                # backend infers ``is_per_output_unit`` when the target
                # is a packaging item, so an overlooked ``per_unit``
                # FE row (mg field only, no compensation) still ships
                # to PSP as 1 pouch per pack instead of 60. Defense in
                # depth against the FE compensation math ever silently
                # regressing.
                attrs = item.attributes if isinstance(item.attributes, dict) else {}
                item_type = str(attrs.get("psp_item_type") or "").strip().lower()

                override_item_lookup[str(item.id)] = {
                    "psp_uuid": str(item.psp_source_uuid),
                    "unit": local_unit or (stock_symbol or ""),
                    "stock_uom_symbol": stock_symbol or "",
                    "stock_uom_dimension": stock_dimension or "",
                    "item_type": item_type,
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
        #
        # SPOU selection: finished stages are always keyed off
        # ``formulation.servings_per_pack`` (the "1 pack = 1 finished
        # stock unit" contract). Semi-finished stages use their own
        # per-stage yield ratio. Reading the finished stage's stored
        # SPOU used to leak the field's default of 1 into PSP,
        # producing per-capsule BOM scale instead of per-pack.
        # Finished stage always keys off ``servings_per_pack`` (see
        # ``_finished_stage_servings``). Semi stages route through
        # ``_semi_stage_servings`` which auto-derives from the semi's
        # stock UoM + formulation per-serving mass when the scientist
        # hasn't explicitly set it — otherwise the default-1 SPOU
        # collapses the prior-semi qty formula and every intermediate
        # MO inherits "1 stock-unit per 1 output-unit" (e.g. "3 kg of
        # blend for 3 capsules").
        stage_servings = (
            _finished_stage_servings(formulation)
            if is_finished
            else _semi_stage_servings(
                stage,
                formulation,
                stages=stages,
                finished_stage=finished_stage,
                client=client,
                organization=formulation.organization,
            )
        )
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
        #
        # Dedup guard — if the scientist has already added an explicit
        # ingredient line for the prior semi (a legitimate move for
        # multi-branch flows where auto-linear-chaining doesn't fit),
        # their line's qty is authoritative. Skip the auto-inject
        # rather than double-count. Without this guard, a scientist
        # who ever manually picked the prior semi in the Routing tab
        # picker would ship two lines for the same part_uuid to PSP,
        # sum-doubling every downstream MO Parts row for that part.
        if previous_semi_uuid is not None:
            already_present = any(
                str(line.get("part_uuid") or "") == str(previous_semi_uuid)
                for line in bom_lines
            )
            if not already_present:
                if previous_servings > 0:
                    prior_qty = stage_servings / previous_servings
                else:
                    prior_qty = Decimal("1")
                prior_line: dict[str, Any] = {
                    "part_uuid": previous_semi_uuid,
                    "qty": str(prior_qty),
                    "sort_order": -1,
                }
                # Tag with the semi item's declared stock UoM so the
                # parent MO Parts table renders "0.03 L" instead of
                # "0.03 ?".
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
                **_bom_provenance(formulation),
            }
            # Per-stage try/except so a single stage's BOM PUT failure
            # (e.g. a dimension mismatch PSP's boundary check rejects,
            # a stale item UoM, a rate limit) doesn't abort the whole
            # cascade and leave downstream stages — including the
            # finished-product BOM — frozen at their pre-change state.
            #
            # Bug this closes (MA01446, 2026-09-02): scientist swapped
            # bottles → pouches. Save v4 → blend-stage BOM push failed
            # at PSP boundary because a legacy water line was tagged
            # mg (mass) against a volume-dimension item. Cascade
            # aborted before the finished-product BOM push. PSP's item
            # 1446 BOM stayed at yesterday's snapshot (bottles + lids)
            # and the MO created off that BOM shipped with bottles
            # even though the FINAL spec said pouches. Silent drift
            # is exactly what the audit trail can't survive.
            #
            # Continuing past a failed BOM push is safe: the semi-
            # finished ITEM was already ensured before this call, so
            # downstream stages can still link to its uuid — they just
            # link to a semi that carries a stale BOM. That's a
            # smaller, more localised badness than silently drifting
            # the whole finished-product BOM.
            try:
                response = client.put_bom(output_uuid, payload)
            except PspError:
                logger.exception(
                    "PSP push_bom: stage %s (%s) BOM PUT failed for "
                    "formulation %s. Continuing cascade so downstream "
                    "stages (incl. finished-product) still get their "
                    "updates.",
                    stage.id,
                    stage_label,
                    formulation.pk,
                )
                response = None
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
        #
        # Same per-stage try/except as the BOM PUT above — a failing
        # routing shouldn't take down the cascade so downstream
        # stages still receive their updates.
        if stage.workstation_group_uuid:
            _stringify_decimal = (
                lambda v: str(v) if v is not None else None  # noqa: E731
            )
            try:
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
            except PspError:
                logger.exception(
                    "PSP push_routing: stage %s (%s) routing PUT failed "
                    "for formulation %s. Continuing cascade.",
                    stage.id,
                    stage_label,
                    formulation.pk,
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


def _human_readable_formulation_name(formulation: Any) -> str:
    """Pick the operator-facing name for a formulation when pushing
    its identity to PSP.

    Custom projects: ``formulation.name`` is the product name the
    scientist typed at CFF-attach time ("ImpHowr Gummies") — use it.

    RTG projects: ``formulation.name`` is a system-generated code
    ("RTG00001") that reads as noise on the shop-floor. The customer-
    facing display name lives on ``rtg_display_name`` ("Vitamin C
    Capsules 60s") and IS what operators need to see next to a MO
    parts table. Prefer that when set; fall back to ``name`` when
    the display name hasn't been filled in yet (fresh RTG draft).

    Empty string return means the caller should walk its own fallback
    ladder (stage name, formulation.code, etc.).
    """

    project_type = str(getattr(formulation, "project_type", "") or "").strip()
    if project_type == "ready_to_go":
        display = (getattr(formulation, "rtg_display_name", "") or "").strip()
        if display:
            return display
    return (getattr(formulation, "name", "") or "").strip()


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
    # Auto-derived form uses the human-readable product name (RTG
    # display name for RTG, project name for Custom) as the parent
    # anchor so operators see "Vitamin C Capsules 60s — Blend"
    # instead of the system-code "RTG00001 — Blend".
    parent_label = (
        _human_readable_formulation_name(formulation) or formulation.code
    )
    name = stage.psp_item_name or (
        f"{parent_label} — {stage.name or f'Stage {stage.sort_order + 1}'}"
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
    # SKU resolution — priority order:
    #   1. Scientist-supplied override on the stage (rare).
    #   2. Existing PSP item's SKU, when the formulation already carries
    #      a linked ``psp_finished_product_uuid``. Fetches the row from
    #      PSP to read its real ``external_sku``. This bridges the two
    #      historical SKU conventions:
    #        * ``NPD-FP-<random-hex>`` — minted by
    #          ``create_psp_finished_product`` at CFF-attach / new-
    #          formulation modal time.
    #        * ``NPD-FINISHED-<formulation.id>`` — auto-derived by this
    #          function on first BOM push when no link exists yet.
    #      Without step 2 the two paths never converged: the modal
    #      created an item with the random-hex SKU, then this function
    #      later tried to create ANOTHER item with the
    #      ``NPD-FINISHED-<uuid>`` SKU, hit PSP's ``(company_id, name)``
    #      unique-name constraint (both items would be named after the
    #      formulation), and silently fell back to the name-lookup path
    #      which returned the existing item WITHOUT the UOM /
    #      product_family / finished_product_spec update the caller
    #      wanted to apply. Net effect: the CFF-attach-created item
    #      stayed forever without a ``stock_uom_id``, and downstream
    #      trial-batch MO creation on PSP failed with a
    #      ``unit_of_measurement_id can't be blank`` validation error
    #      when the reservation changeset tried to stamp the item's UOM
    #      onto the output lot.
    #   3. Auto-derived ``NPD-FINISHED-<formulation.id>`` fallback.
    linked_uuid = str(getattr(formulation, "psp_finished_product_uuid", "") or "")
    existing_sku = ""
    if not stage_sku and linked_uuid:
        try:
            existing_item = client.get_item(linked_uuid)
        except PspError:
            # Soft failure — fall through to the derived SKU so the
            # sync still tries. Worst case: same silent-collision as
            # before; best case: PSP is momentarily unreachable and
            # the next push resolves it.
            existing_item = None
        if existing_item is not None:
            existing_sku = getattr(existing_item, "external_sku", "") or ""
    external_sku = stage_sku or existing_sku or f"NPD-FINISHED-{formulation.id}"
    # Priority ladder:
    #   1. ``rtg_display_name`` when the project is RTG and it's set —
    #      this is the customer-facing product name ("Vitamin C
    #      Capsules 60s") which is what shop-floor operators need to
    #      see on the MO parts table. Wins over any stage-level
    #      ``psp_item_name`` because that field is auto-seeded from
    #      ``formulation.name`` at stage-create time, and for RTG
    #      ``formulation.name`` is the system-generated code
    #      ("RTG00001") — piping that through means every RTG MO
    #      reads as noise on the shop floor. If a scientist has
    #      typed an explicit non-placeholder override on the stage
    #      (i.e. it's genuinely DIFFERENT from the auto-copied
    #      formulation.name / .code / rtg_display_name), that survives.
    #   2. Scientist-typed ``psp_item_name`` on the stage (used mostly
    #      for Custom projects where formulation.name IS the product
    #      name and the stage-level override is a deliberate rename).
    #   3. Formulation's human-readable name (formulation.name for
    #      Custom, rtg_display_name for RTG — same helper).
    #   4. Auto-derived "{code} — {stage_name}" — defensive fallback
    #      for the tiny historical set of nameless legacy rows.
    human_name = _human_readable_formulation_name(formulation)
    is_rtg = str(getattr(formulation, "project_type", "") or "") == "ready_to_go"
    placeholder_overrides = {
        (formulation.name or "").strip(),
        (formulation.code or "").strip(),
    }
    stage_override_is_placeholder = (
        stage_name_override or ""
    ).strip() in placeholder_overrides

    if is_rtg and human_name and (
        not stage_name_override or stage_override_is_placeholder
    ):
        # RTG with a display name — always beats the auto-seeded
        # stage placeholder. A genuine scientist override (non-
        # placeholder) still wins.
        name = human_name
    elif stage_name_override:
        name = stage_name_override
    elif human_name:
        name = human_name
    elif stage_name:
        name = f"{formulation.code} — {stage_name}"
    else:
        name = formulation.code or f"NPD-{formulation.id}"
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
    ``mo.quantity`` — always expressed in PACKS (finished stock units).

    Contract:

    * ``sample`` kind — ``batch_size_units`` is already in packs.
      User types "15" → PSP MO produces 15 packs. Direct passthrough.
    * ``trial`` kind — ``batch_size_units`` is in individual servings
      (capsules / gummies / doses). User types "1" → PSP MO produces
      ``1 / servings_per_pack`` packs = fractional pack for bench-
      scale runs. Matches the operator's mental model: a 1-capsule
      trial for a 60-cap bottle produces 0.01667 packs; a 1-capsule
      trial for a 10-cap bottle produces 0.1 packs.

    Both branches route through the same divisor
    (``_finished_stage_servings``) which is ALWAYS the formulation's
    ``servings_per_pack`` — the finished stage's stored SPOU is
    ignored because it's redundant with ``servings_per_pack`` and
    defaults to 1 (the historical foot-gun that produced
    ``mo.quantity = 900`` for a 15-bottle MO).

    Cases collapse to:

    * sample: ``batch_size × servings_per_pack ÷ servings_per_pack
              = batch_size`` (exact packs)
    * trial:  ``batch_size ÷ servings_per_pack`` (fractional packs)
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

    formulation = trial_batch.formulation_version.formulation
    servings_per_pack = _finished_stage_servings(formulation)

    kind = getattr(trial_batch, "kind", None) or "sample"
    if kind == "sample":
        # ``batch_size`` already in packs. target_servings is only
        # computed for symmetry with the ``trial`` branch — the
        # division below collapses it back to ``batch_size``.
        target_servings = batch_size * servings_per_pack
    else:  # "trial" — batch_size is in individual servings
        target_servings = batch_size

    return target_servings / servings_per_pack


def _build_packaging_overlay(
    trial_batch: Any,
    kind: str,
    *,
    organization: Any,
    actor: Any,
    client: Any,
    size_mode: str = "packs",
) -> Any:
    """Translate ``TrialBatch.packaging_combo`` into the payload PSP
    expects on the MO create endpoint.

    Return values follow the three-state contract on
    :meth:`PspClient.create_manufacturing_order`:

    * ``None`` — no overlay. Trial-kind batches always hit this branch
      (bench-scale, packaging not applicable) so the MO consumes the
      finished item's default packaging BOM lines.
    * ``[]`` — sample with no combo, OR sample with a combo but
      ``size_mode == "units"`` (loose individual units — 5 capsules
      shipped as a sample don't need a bottle + label + carton). PSP
      skips packaging-typed BOM lines and books nothing in their
      place (loose bulk output).
    * populated list — combo picked AND ``size_mode == "packs"``.
      Each row is ``{"item_uuid": <psp uuid>, "quantity": str}``.

    Unmirrored items (NPD-native rows imported before PSP was
    connected, or created directly in NPD's local catalogue) are
    reverse-mirrored on the fly via :func:`ensure_psp_item` — a
    push-create against PSP that returns the freshly-minted PSP uuid
    and pins it on the local row. This keeps legacy combos flowing
    through the overlay as if they'd always been PSP-native, so the
    scientist doesn't have to re-key each packaging item on PSP
    before a sample MO can run.
    """
    if kind == "trial":
        return None

    # Individual-units mode ships loose finished units (5 capsules /
    # 5 scoops of powder in a Ziploc / 5 gummies in a paper sleeve).
    # No commercial packaging — force empty overlay so PSP doesn't
    # book bottles + caps + labels for a scientist's evaluation
    # sample. Toggle on the Create-MO modal drives this.
    if size_mode == "units":
        return []

    combo = getattr(trial_batch, "packaging_combo", None)
    if combo is None:
        # Two very different "no combo picked" cases, and PSP treats
        # ``[]`` as "hide the finished-stage packaging BOM lines,
        # nothing takes their place" (loose bulk output):
        #
        #   * RTG formulation with combos defined but scientist
        #     forgot to pick → correct to return ``[]``. The
        #     formulation *has* an alternative packaging path
        #     (combos); an empty overlay signals "operator opted
        #     out of all of them".
        #   * Custom formulation with packaging embedded directly in
        #     the finished-stage BOM (no combos defined at all) →
        #     return ``None`` so PSP keeps the BOM's packaging lines.
        #     Returning ``[]`` here silently strips the bottle + cap
        #     + label rows the scientist wired into the stage builder,
        #     which is the whole "packaging is missing" bug on custom
        #     samples.
        formulation = trial_batch.formulation_version.formulation
        has_combos = formulation.packaging_combos.exists()
        return [] if has_combos else None

    # Contract shift: overlay ``quantity`` is now the ABSOLUTE TOTAL
    # for the whole MO — not a per-mo-unit multiplier.
    #
    # Previous design multiplied per-unit qty × mo.quantity on PSP,
    # which forced repeating-decimal drift for count items (a "1 pouch
    # per pack" combo on 900 capsules with 60/pack computed as
    # 0.0166666667 × 900 = 15.00000003 — an unbookable phantom
    # shortage). Sending the total straight — and ceiling for count
    # items — kills the drift AND matches the physical reality: you
    # can't book 15.03 bottles.
    #
    # Total math:
    #   total_packs = ceil(mo.quantity_in_stock_units / stock_units_per_pack)
    #                   for sample batches, batch_size_units is already
    #                   in packs so total_packs = batch_size_units.
    #   row_total   = per_pack_qty × total_packs
    #                   ceil-ed to whole units when the item's stock UoM
    #                   is a count (packaging, pcs, each). Decimal
    #                   items (rare in packaging combos — a bulk
    #                   silica gel by weight, say) keep exact math.
    from decimal import Decimal, InvalidOperation, ROUND_CEILING

    # Sample batches: batch_size_units IS the pack count. Trial
    # batches don't hit this branch (kind == "trial" returned above),
    # but if the enum ever grows we fall back to 1 pack so any
    # divergent behaviour is loud not silent.
    try:
        total_packs = Decimal(str(getattr(trial_batch, "batch_size_units", 1) or 1))
    except (InvalidOperation, TypeError, ValueError):
        total_packs = Decimal("1")
    if total_packs <= 0:
        total_packs = Decimal("1")

    payload: list[dict[str, Any]] = []
    unresolved: list[str] = []
    # Combo-level default stage on the PSP side. Items inherit this
    # when they haven't set their own override. ``None`` on combos
    # bound to the finished-product stage or on combos still without
    # a stage assignment (preserves legacy behaviour — the item lands
    # on the root MO).
    combo_formulation = trial_batch.formulation_version.formulation
    combo_stage_psp_uuid = _resolve_stage_psp_uuid(
        combo.stage, combo_formulation
    )
    for row in combo.items.select_related("item", "stage").all():
        item = row.item
        psp_uuid = getattr(item, "psp_source_uuid", None) if item else None
        if not psp_uuid and item is not None:
            # Reverse-mirror on demand — pushes the local packaging /
            # raw-material row to PSP, pins the returned uuid on
            # ``item.psp_source_uuid``, and returns it. Any failure
            # (PSP unreachable, name conflict fallback couldn't
            # resolve, etc.) returns ``None`` and the row surfaces as
            # unresolved below — no silent drop.
            psp_uuid = ensure_psp_item(
                organization=organization, actor=actor, item=item, client=client
            )
        if not psp_uuid:
            unresolved.append(
                (item.name if item and item.name else "(unnamed item)")
            )
            continue

        try:
            per_pack_qty = Decimal(str(row.quantity or 0))
        except (InvalidOperation, TypeError, ValueError):
            per_pack_qty = Decimal("0")

        raw_total = per_pack_qty * total_packs

        # Count items get ceil-rounded to whole units — you can't book
        # half a pouch. Detection heuristic: the local item's ``unit``
        # is count-like (pcs / each / dozen / empty) OR the parent
        # combo item is packaging (the overwhelmingly common case).
        # If we ever add liquid packaging (e.g. a shrink-wrap volume
        # in mL), the else branch preserves the exact decimal.
        unit_symbol = str(getattr(item, "unit", "") or "").strip().lower()
        count_like = unit_symbol in ("", "pcs", "each", "ea", "dozen", "pack")

        if count_like:
            row_total = raw_total.to_integral_value(rounding=ROUND_CEILING)
        else:
            row_total = raw_total

        # Per-item stage override, else combo default. PSP resolves
        # the stage uuid to a specific MO in the tree; ``None`` (or a
        # uuid PSP doesn't recognise) falls back to booking against
        # the root MO — matches legacy behaviour for pre-Option-A
        # combos.
        item_stage_psp_uuid: str | None = None
        if row.stage_id is not None:
            item_stage_psp_uuid = _resolve_stage_psp_uuid(
                row.stage, combo_formulation
            )
        effective_stage_uuid = (
            item_stage_psp_uuid or combo_stage_psp_uuid
        )

        payload.append(
            {
                "item_uuid": str(psp_uuid),
                "quantity": str(row_total),
                "psp_stage_uuid": effective_stage_uuid,
            }
        )

    if unresolved:
        # Reverse-mirror couldn't pin a PSP uuid on one or more items —
        # keep the loud fail so the scientist knows the sample isn't
        # about to ship without packaging. This branch only fires on
        # true edge cases now (PSP outage during MO create, or an item
        # that's malformed enough that PSP refuses even the reverse-
        # mirror), so the message stays as-is.
        raise PspPackagingComboItemsNotMirrored(
            combo_name=combo.name or "(unnamed combo)",
            missing_item_names=unresolved,
        )

    return payload


def create_psp_manufacturing_order_for_trial_batch(
    *,
    organization: Any,
    actor: Any,
    trial_batch: Any,
    quantity: Any,
    warehouse_uuid: Any,
    item_uuid: Any = None,
    due_date: Any = None,
    notes: str = "",
    size_mode: str = "packs",
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
    * ``project_type`` — **derived from ``trial_batch.kind``**, not a
      caller kwarg. ``trial`` batches produce ``project_type=trial``
      MOs (bypass Final Release); ``sample`` batches produce
      ``project_type=sample`` MOs (commercial-path release).
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
    # packs OR individual servings depending on ``kind``, so we
    # normalise both branches to a servings target first, then
    # divide by the finished stage's ``servings_per_output_unit`` so
    # the number PSP sees means the same thing as PSP's BOM lines
    # (which are per-1-stock-unit).
    if quantity in (None, ""):
        quantity = _derive_psp_mo_quantity(trial_batch)
        # When we fell back to the batch's planned scale, we already
        # applied kind-based pack conversion inside
        # ``_derive_psp_mo_quantity``. Force ``size_mode = "packs"``
        # so the branch below doesn't re-divide.
        size_mode = "packs"

    try:
        qty_dec = Decimal(str(quantity))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError("quantity must be a positive number") from exc
    if qty_dec <= 0:
        raise ValueError("quantity must be a positive number")

    # ``size_mode = "units"`` — the caller entered raw finished units
    # (e.g. "5 capsules" for a sample-batch MO). PSP's ``mo.quantity``
    # is expressed in the finished-product's stock unit (packs), so
    # divide by ``servings_per_pack`` before sending. Common cycle-
    # slot flow: scientist wants to ship 5-8 loose capsules from a
    # 60-cap bottle formulation → PSP MO produces
    # 5/60 = 0.083333 packs, BOM scales proportionally.
    #
    # ``size_mode = "packs"`` (default) — caller entered pack count;
    # passthrough. Same behaviour as before this override existed.
    if size_mode == "units":
        formulation = trial_batch.formulation_version.formulation
        divisor = _finished_stage_servings(formulation)
        if divisor > 0:
            qty_dec = qty_dec / divisor
        if qty_dec <= 0:
            raise ValueError("quantity must be a positive number")

    # Cap at 6 dp so a fractional-pack MO (e.g. 10 servings / 60 =
    # 0.16666666… packs) reaches PSP with clean digits.
    qty_dec = qty_dec.quantize(Decimal("0.000001"))

    # Derive from batch.kind — same field the BOM scale-up reads,
    # so trial vs sample is decided once at batch-create time and
    # every downstream leg (BOM, MO, release flow) reads from it.
    # Falls back to ``sample`` on legacy rows that were created
    # before ``kind`` existed.
    kind = getattr(trial_batch, "kind", None) or "sample"
    project_type = "trial" if kind == "trial" else "sample"

    # Customer-paid sample fulfilment override: when the batch came
    # from the /samples fulfilment queue (``source_payment_id`` set
    # OR ``cycle_slot`` set — either is a real customer commitment
    # attached to a CO), FORCE ``project_type = "sample"`` regardless
    # of what the scientist picked for ``batch.kind``. Reason: PSP
    # tags MO outputs as ``is_rnd = true`` when ``project_type == "trial"``,
    # which correctly parks bench-scale R&D lots on the R&D floor.
    # But a customer-paid sample must ship to that customer — it
    # needs the commercial release + dispatch path (``is_rnd = false``),
    # not the R&D floor. Historically, scientists commonly picked
    # ``trial`` on customer sample runs too (bench-scale of a
    # customer's kit), producing R&D lots the wizard couldn't ship.
    # This override respects the customer commitment over the kind
    # label — same rule as the sample-CO ``sample_kind`` flag on
    # PSP and the ``is_customer_sample_fulfilment`` FE gate.
    is_customer_fulfilment = (
        getattr(trial_batch, "source_payment_id", None) is not None
    )
    if not is_customer_fulfilment:
        # ``trial_batch.cycle_slot`` is a reverse OneToOne (defined
        # on ``CycleSlot`` with ``related_name="cycle_slot"``) so
        # accessing it raises ``RelatedObjectDoesNotExist`` when
        # no slot points at this batch. Try/except beats a
        # separate ``.objects.filter(trial_batch=...).exists()``
        # round-trip — the accessor path is preferred when the
        # attr already got prefetched somewhere upstream.
        try:
            is_customer_fulfilment = trial_batch.cycle_slot is not None
        except Exception:  # noqa: BLE001 — reverse-OneToOne miss
            is_customer_fulfilment = False
    if is_customer_fulfilment:
        project_type = "sample"

    # Packaging overlay — only for sample batches, and only sent
    # when the scientist opted into one. Three legal states:
    #
    #   * kind == "trial"                  → None (default packaging
    #                                        BOM), same as pre-overlay
    #                                        behaviour
    #   * kind == "sample", no combo       → [] (overlay active but
    #                                        empty; PSP skips
    #                                        packaging-typed BOM
    #                                        lines and books nothing
    #                                        in their place — loose
    #                                        bulk output)
    #   * kind == "sample", combo picked   → populated list, each
    #                                        row ``{item_uuid,
    #                                        quantity}``, resolved to
    #                                        PSP's mirrored item uuid
    #
    # Client is built up-front so ``_build_packaging_overlay`` can
    # reverse-mirror unmirrored combo items through the same
    # connection instead of spinning up its own. Reverse-mirror
    # is the swap for the previous "raise on missing psp_source_uuid"
    # behaviour — legacy combos with NPD-native items now flow
    # through as if they'd always been PSP-native.
    client = _client_factory(config)

    # Refresh the finished-product item's name / description / spec on
    # every MO create so PSP mirrors whatever the scientist most
    # recently set on the formulation's finished stage (project name,
    # PSP name override, dosage form, capsule size, storage tags,
    # etc.). Without this the item name is baked at first-push and
    # only refreshes when someone hits Save Version or Sync PSP on
    # the builder — meaning a scientist could rename the project on
    # NPD, spawn a new MO, and see the STALE name on PSP forever.
    # PSP's integration item POST handles name-collision retries
    # server-side (see items_company_id_name_index disambiguator) so
    # a repeat push with a colliding name still lands cleanly.
    # Silent-degrade on any failure so a slow / flaky PSP item
    # refresh never blocks the MO create itself.
    try:
        formulation = trial_batch.formulation_version.formulation
        finished_stage = next(
            (
                s
                for s in formulation.stages.order_by("sort_order")
                if s.psp_item_type == "finished_product"
            ),
            None,
        )
        _ensure_finished_product(
            client=client, formulation=formulation, stage=finished_stage
        )
    except Exception:  # noqa: BLE001 — silent-degrade, never block MO create
        logger.exception(
            "MO create: finished-product refresh failed for trial batch %s "
            "(silent-degraded)",
            getattr(trial_batch, "id", None),
        )

    # Refresh the whole stage BOM cascade on PSP using the latest saved
    # version's snapshot as the override. Without this, a scientist who
    # attaches a capsule shell / picks packaging / re-routes bands and
    # then clicks "Create MO" without first clicking Sync PSP would
    # spawn an MO against a stale BOM (missing shell, missing packaging,
    # wrong stage assignments). The snapshot on ``FormulationVersion``
    # is written on every save_version, so it always reflects the
    # scientist's most recent saved state. Silent-degrade — a PSP
    # hiccup shouldn't block the MO create itself; the operator can
    # click Sync PSP to retry the BOM push.
    try:
        formulation = trial_batch.formulation_version.formulation
        latest_version = (
            formulation.versions.order_by("-version_number").first()
        )
        snapshot_overrides = None
        if latest_version is not None:
            snapshot_overrides = latest_version.snapshot_stage_boms or None
        push_bom_to_psp(
            formulation=formulation,
            stage_bom_overrides=snapshot_overrides,
        )
    except Exception:  # noqa: BLE001 — silent-degrade, never block MO create
        logger.exception(
            "MO create: BOM refresh failed for trial batch %s "
            "(silent-degraded)",
            getattr(trial_batch, "id", None),
        )

    packaging_overlay = _build_packaging_overlay(
        trial_batch,
        kind,
        organization=organization,
        actor=actor,
        client=client,
        size_mode=size_mode,
    )

    # Sample-fulfilment CO sync: for sample-kind batches with a
    # source payment (came from the R&D /samples fulfilment queue),
    # push a per-customer CO to PSP FIRST so the MO create can
    # link back to it. Uses the sample payment uuid as identity so
    # each customer gets their own CO even when the underlying RTG
    # formulation is shared. Failure here is soft — the MO still
    # gets pushed, it just won't land on /projects attached to a
    # customer (the scientist can retry Create MO after fixing the
    # PSP connectivity issue).
    npd_sample_payment_uuid: str | None = None
    source_payment_id = getattr(trial_batch, "source_payment_id", None)
    cycle_slot = getattr(trial_batch, "cycle_slot", None)
    # Presence of a source_payment OR cycle_slot means "this is a
    # customer-facing run" (storefront sample kit or cycle-slot
    # sample) — the customer commitment is what makes the batch
    # kanban-worthy, not the batch's ``kind`` label. Previously
    # gated on ``kind == "sample"`` too, but that silently dropped
    # the sync for batches with the wrong kind (e.g. scientist
    # picked ``trial`` at Plan-Batch time on a payment-sourced
    # batch — batch fcd8593c was the reproducer), leaving the
    # customer's paid MO orphaned off /projects. The customer
    # commitment wins over the kind label here.
    if source_payment_id is not None or cycle_slot is not None:
        # Fires for BOTH storefront samples (source_payment set) and
        # cycle-slot samples (cycle_slot set, source_payment None).
        # The sync inside now branches on which identity to use and
        # pulls the customer from the parent formulation for cycle
        # slots — see ``sync_sample_customer_order_to_psp`` for the
        # branch logic.
        #
        # Pass the resolved PSP MO qty (``qty_dec`` — already
        # size_mode + servings-per-pack normalised at the
        # ``if size_mode == "units"`` branch above) so the sample
        # CO line's ``qty_ordered`` matches the physical run. Fixes
        # the "cycle-slot batch defaulted to 20 packs but the
        # scientist ran 3 gummies loose = 0.05 packs" mismatch
        # where the CO line kept 20 and the wizard read the gap as
        # a shortfall.
        sync_sample_customer_order_to_psp(
            trial_batch=trial_batch, mo_quantity=qty_dec
        )
        # We stamp the uuid on the payload regardless of the sync's
        # return value — the sync is idempotent + silent-degrade, so
        # if it succeeded PSP has the CO ready; if it soft-failed the
        # MO create will surface ``sample_co_not_found`` (400) and the
        # scientist retries. That's a better UX than silently pushing
        # the MO orphaned.
        #
        # Identity source MUST match the sync's internal branch or
        # PSP's ``resolve_sample_co_line_id`` will 400 with
        # "sample_co_not_found":
        #   * source_payment_id for storefront sample-kit batches
        #   * cycle_slot.id for cycle-slot batches (stable across
        #     batch delete/recreate — see the identity change in
        #     sync_sample_customer_order_to_psp)
        # Legacy fallback to trial_batch.id only when we somehow have
        # neither, which shouldn't happen post the guard above but
        # keeps the value non-None for defensive safety.
        if source_payment_id is not None:
            npd_sample_payment_uuid = str(source_payment_id)
        elif cycle_slot is not None:
            npd_sample_payment_uuid = str(cycle_slot.id)
        else:
            npd_sample_payment_uuid = str(trial_batch.id)

    try:
        mo = client.create_manufacturing_order(
            item_uuid=resolved_item_uuid,
            warehouse_uuid=resolved_warehouse_uuid,
            quantity=qty_dec,
            npd_trial_batch_uuid=str(trial_batch.id),
            # Pass the parent formulation uuid so PSP's Output QC page
            # can deep-link back into this NPD formulation's QC tab.
            npd_formulation_uuid=str(
                trial_batch.formulation_version.formulation.id
            ),
            project_type=project_type,
            due_date=due_date,
            notes=notes or "",
            packaging_combo_items=packaging_overlay,
            npd_sample_payment_uuid=npd_sample_payment_uuid,
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
        if '"sample_co_not_found"' in message:
            # Sample-CO sync soft-failed earlier (PSP unreachable /
            # rate-limited at that step) so PSP couldn't find the CO
            # this MO wants to link to. Actionable: retry Create MO;
            # the sync fires again on the second attempt.
            raise PspCreateManufacturingOrderFailed(
                "PSP couldn't find the sample customer order. This "
                "usually means the sample-CO sync soft-failed on the "
                "first attempt — retry Create MO and it should land.",
                psp_error="sample_co_not_found",
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
        # Slot promotion — "IN_PRODUCTION" fires here (real PSP MO
        # exists) rather than at ``link_slot_to_trial_batch`` (which
        # just attaches an NPD-side scale-up recipe with nothing
        # actually being made yet). Portal card + scientist dashboard
        # both key off ``slot.status`` so a slot with no MO reads as
        # "awaiting" instead of the misleading "in production".
        from apps.trial_batches.cycle_services import (
            promote_slot_to_in_production,
        )

        promote_slot_to_in_production(trial_batch=trial_batch)
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


def list_psp_invoices_for_payment(*, payment: Any) -> list[dict]:
    """List PSP CustomerInvoices attached to the CO that mirrors this
    NPD Payment.

    CO-uuid resolution (matches the sync-side conventions):

    * Sample payment (``kind=final`` + RTG formulation) → PSP CO uuid
      == ``payment.id`` (planted by ``NpdSync.upsert_sample_from_npd``).
    * Custom-formulation payment (``kind=final`` + custom
      formulation) → PSP CO uuid == ``formulation.id`` (planted by
      ``NpdSync.upsert_from_npd``).
    * Deposit payment → not supported yet (proposal-level, walks
      through multiple COs); returns ``[]``.

    Silent-degrade — returns ``[]`` if PSP integration is off, the
    payment doesn't have a resolvable CO, or PSP is unreachable.
    """

    if payment is None:
        return []
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return []

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return []

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return []
    client = _client_factory(config)
    try:
        return client.list_customer_order_invoices(co_uuid)
    except PspError:
        return []


def list_psp_release_documents_for_payment(*, payment: Any) -> list[dict]:
    """List Final Product Release documents attached to the PSP CO that
    mirrors this NPD Payment.

    Same CO-uuid resolution as :func:`list_psp_invoices_for_payment` —
    sample-payment CO uuid = payment.id, custom-formulation CO uuid =
    formulation.id. Silent-degrade returns ``[]`` on any failure
    (PSP off, unreachable, unknown CO, release ceremony not done
    yet). Powers the "Release documents" card on the customer portal
    sample detail page.

    Shape: ``[{uuid, kind, filename, mime, byte_size, uploaded_at}, ...]``.
    """

    if payment is None:
        return []
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return []

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return []

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return []
    client = _client_factory(config)
    try:
        return client.list_customer_order_release_documents(co_uuid)
    except PspError:
        return []


def fetch_psp_release_document_for_payment(
    *, payment: Any, file_uuid: Any
) -> tuple[bytes, str, str] | None:
    """Proxy-download one Final Release document. Returns
    ``(bytes, mime, filename)`` or ``None`` on any failure.

    The portal proxy calls this to stream the file to the customer —
    file bytes stay on PSP (source of truth), NPD is a pass-through
    with the customer's ownership check bolted on at the portal-view
    layer above this call.
    """

    if payment is None:
        return None
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return None

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.fetch_customer_order_release_document(co_uuid, file_uuid)
    except PspError:
        return None


def get_psp_dispatch_for_co(
    *, organization: Any, co_uuid: Any
) -> dict | None:
    """Fetch the PSP dispatch-confirmation snapshot for a CO by uuid.

    Used by the cycle-slot portal path where the Sample CO on PSP is
    keyed by ``slot.id`` (not a payment id). Silent-degrade to
    ``None`` on any failure / integration off / shipment not yet
    ``picked_up`` — the portal FE renders the card only when the
    value is a non-null dict.
    """

    if organization is None or not is_psp_live(organization):
        return None
    cleaned = str(co_uuid or "").strip()
    if not cleaned:
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.get_customer_order_dispatch(cleaned)
    except PspError:
        return None


def get_psp_dispatch_for_payment(*, payment: Any) -> dict | None:
    """Fetch the PSP dispatch-confirmation snapshot for the CO that
    mirrors this NPD Payment. Returns ``None`` on any failure or
    when the shipment hasn't been ``picked_up`` yet — the portal
    hides the card in that case rather than showing a placeholder.

    Same CO-uuid resolution as :func:`list_psp_release_documents_for_payment`.
    """

    if payment is None:
        return None
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return None

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.get_customer_order_dispatch(co_uuid)
    except PspError:
        return None


def confirm_psp_dispatch_delivery_for_payment(
    *, payment: Any, recipient_signatory: str, delivery_notes: str = ""
) -> dict | None:
    """Customer-driven POD. Forwards to PSP's
    ``confirm_delivery`` integration endpoint for this payment's CO.

    Returns PSP's response dict on success or ``None`` on any
    failure — the caller (portal view) turns that into a 502
    response so the customer sees a clear "couldn't reach fulfilment"
    message rather than a silent no-op. Ownership is enforced one
    layer up at the portal view (payment must belong to the account's
    Customer id union).
    """

    if payment is None:
        return None
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return None

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.confirm_customer_order_delivery(
            co_uuid,
            recipient_signatory=recipient_signatory,
            delivery_notes=delivery_notes,
        )
    except PspError:
        return None


def confirm_psp_dispatch_event_delivery_for_payment(
    *,
    payment: Any,
    event_uuid: Any,
    recipient_signatory: str,
    delivery_notes: str = "",
) -> dict | None:
    """Per-event customer-driven POD (multi-visit shipments). Same
    silent-degrade contract as
    :func:`confirm_psp_dispatch_delivery_for_payment`, but confirms
    ONE pickup event on the CO's shipment rather than the whole
    shipment.
    """

    if payment is None:
        return None
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return None

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.confirm_customer_order_event_delivery(
            co_uuid,
            event_uuid,
            recipient_signatory=recipient_signatory,
            delivery_notes=delivery_notes,
        )
    except PspError:
        return None


def confirm_psp_dispatch_event_delivery_for_co(
    *,
    organization: Any,
    co_uuid: Any,
    event_uuid: Any,
    recipient_signatory: str,
    delivery_notes: str = "",
) -> dict | None:
    """Per-event customer-driven POD, keyed by CO uuid + event uuid.
    Custom-formulation counterpart to
    :func:`confirm_psp_dispatch_event_delivery_for_payment` — used by
    the projects portal path where the CO on PSP is keyed by the
    formulation's linked ``psp_customer_order_uuid`` (not a payment).

    Silent-degrade to ``None`` on any failure (same contract as its
    payment-keyed sibling).
    """

    if organization is None or not is_psp_live(organization):
        return None
    cleaned_co = str(co_uuid or "").strip()
    cleaned_event = str(event_uuid or "").strip()
    if not cleaned_co or not cleaned_event:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.confirm_customer_order_event_delivery(
            cleaned_co,
            cleaned_event,
            recipient_signatory=recipient_signatory,
            delivery_notes=delivery_notes,
        )
    except PspError:
        return None


def confirm_psp_dispatch_delivery_for_co(
    *,
    organization: Any,
    co_uuid: Any,
    recipient_signatory: str,
    delivery_notes: str = "",
) -> dict | None:
    """Payment-agnostic counterpart to
    :func:`confirm_psp_dispatch_delivery_for_payment`. Forwards the
    customer's POD to PSP for a CO looked up by uuid directly —
    used by the cycle-slot portal path where the Sample CO on PSP is
    keyed by ``slot.id`` rather than a Payment id.

    Silent-degrade to ``None`` on any failure. Callers should treat
    None as "PSP wasn't reached, retry / reconcile later" rather
    than as a hard error — the customer-visible NPD state has
    already been updated and the reconcile loop on portal reads
    will catch up the PSP side on the next visit.
    """

    if organization is None or not is_psp_live(organization):
        return None
    cleaned = str(co_uuid or "").strip()
    if not cleaned:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.confirm_customer_order_delivery(
            cleaned,
            recipient_signatory=recipient_signatory,
            delivery_notes=delivery_notes,
        )
    except PspError:
        return None


def list_psp_release_documents_for_co(
    *, organization: Any, co_uuid: Any
) -> list[dict]:
    """List Final Product Release documents for a CO by uuid.

    Payment-agnostic counterpart to
    :func:`list_psp_release_documents_for_payment` — used by the
    cycle-slot portal path where the Sample CO on PSP is keyed by
    ``slot.id`` (not a payment id). Silent-degrade: ``[]`` on any
    failure / integration off / release ceremony not yet done.
    """

    if organization is None or not is_psp_live(organization):
        return []
    cleaned = str(co_uuid or "").strip()
    if not cleaned:
        return []
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return []
    client = _client_factory(config)
    try:
        return client.list_customer_order_release_documents(cleaned)
    except PspError:
        return []


def fetch_psp_release_document_for_co(
    *, organization: Any, co_uuid: Any, file_uuid: Any
) -> tuple[bytes, str, str] | None:
    """Proxy-download one release document by CO uuid + file uuid.
    Same silent-degrade contract as
    :func:`fetch_psp_dispatch_photo_for_co`. Callers upstream enforce
    ownership before hitting this.
    """

    if organization is None or not is_psp_live(organization):
        return None
    cleaned = str(co_uuid or "").strip()
    if not cleaned:
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.fetch_customer_order_release_document(cleaned, file_uuid)
    except PspError:
        return None


def fetch_psp_dispatch_photo_for_co(
    *, organization: Any, co_uuid: Any, file_uuid: Any
) -> tuple[bytes, str, str] | None:
    """Proxy-download one dispatch photo by CO uuid + file uuid.

    Payment-agnostic counterpart to
    :func:`fetch_psp_dispatch_photo_for_payment` — used by the
    cycle-slot portal path where the Sample CO on PSP is keyed by
    ``slot.id`` (not a payment id). Same silent-degrade contract:
    ``None`` on any failure / integration off. Callers upstream
    enforce ownership before hitting this.
    """

    if organization is None or not is_psp_live(organization):
        return None
    cleaned = str(co_uuid or "").strip()
    if not cleaned:
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.fetch_customer_order_dispatch_photo(cleaned, file_uuid)
    except PspError:
        return None


def fetch_psp_dispatch_photo_for_payment(
    *, payment: Any, file_uuid: Any
) -> tuple[bytes, str, str] | None:
    """Proxy-download one dispatch photo. Returns ``(bytes, mime,
    filename)`` or ``None`` on any failure. File bytes stay on PSP;
    NPD is a pass-through with the customer's ownership check bolted
    on at the portal-view layer above this call.
    """

    if payment is None:
        return None
    organization = getattr(payment, "organization", None)
    if organization is None or not is_psp_live(organization):
        return None

    co_uuid = _resolve_co_uuid_for_payment(payment)
    if not co_uuid:
        return None

    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.fetch_customer_order_dispatch_photo(co_uuid, file_uuid)
    except PspError:
        return None


# Minimal RFC-6266 filename parser — pulls the filename out of a
# Content-Disposition header. Falls back to "release-document" when
# missing. Handles the two forms PSP emits:
#   * ``inline; filename="coa-batch-42.pdf"``  (ASCII)
#   * ``inline; filename*=UTF-8''coa-%20%E2%98%83.pdf`` (RFC-5987)
def _parse_filename_from_content_disposition(header: str) -> str:
    import re
    import urllib.parse as _urllib_parse

    if not header:
        return "release-document"

    # RFC-5987 extended form wins when both are present.
    star = re.search(r"filename\*\s*=\s*[^']*'[^']*'([^;]+)", header)
    if star:
        try:
            return _urllib_parse.unquote(star.group(1)).strip()
        except Exception:
            pass

    plain = re.search(r'filename\s*=\s*"?([^";]+)"?', header)
    if plain:
        return plain.group(1).strip()

    return "release-document"


def _resolve_co_uuid_for_payment(payment: Any) -> str | None:
    """Map an NPD Payment to the PSP CO uuid we planted at sync time.

    Sample payments (RTG + kind=final) → CO uuid == payment.id.
    Custom-formulation payments → CO uuid == formulation.id.
    Anything else (deposit / no formulation) → None.
    """

    from apps.payments.constants import PaymentKind
    from apps.formulations.models import ProjectType

    if getattr(payment, "kind", None) != PaymentKind.FINAL:
        return None

    formulation = getattr(payment, "formulation", None)
    if formulation is None:
        return None

    project_type = getattr(formulation, "project_type", None)
    if project_type == ProjectType.READY_TO_GO:
        # Sample fulfilment path: the CO's uuid was planted from the
        # payment id at sync time so it's unique per customer-sample
        # pair. Custom formulations plant it from formulation.id.
        return str(payment.id)
    return str(formulation.id)


def get_psp_customer_order_snapshot(
    *,
    organization: Any,
    co_uuid: Any,
) -> dict | None:
    """Fetch PSP's OrderWizard snapshot for a customer order (uuid).

    Powers the portal sample-detail page — the returned ``phase`` +
    ``next_action`` are what let the customer see "Sourcing your
    ingredients — waiting on 3 items" instead of a generic
    "In production". Silent-degrade to ``None`` if the integration
    isn't live, the token can't be decrypted, or PSP is unreachable /
    doesn't know this uuid. The portal falls back to the payment-
    lifecycle-only pipeline in that case so the customer still sees
    something meaningful.
    """

    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.get_customer_order_snapshot(co_uuid)
    except PspError:
        return None


def create_psp_customer_fulfilment_request(
    *,
    organization: Any,
    customer_uuid: Any,
    lot_uuid: Any,
    qty: Any,
    reference: str | None = None,
    notes: str | None = None,
    source: str = "portal",
    external_reference: str | None = None,
) -> tuple[dict | None, str | None]:
    """Push a portal-triggered dispatch request into PSP.

    Returns ``(payload, error_code)``:

    * On success: ``(dict, None)`` where dict is PSP's dispatch
      snapshot (uuid, status, qty, requested_at, source, etc.).
    * On PSP validation error (4xx): ``(None, error_code)`` where
      error_code is PSP's ``detail`` string ("insufficient_qty",
      "bad_qty", "lot_not_found", …) so the portal view can render
      a customer-safe validation message.
    * On PSP unavailable / decrypt failed / transport error:
      ``(None, "psp_unavailable")`` — the portal view surfaces the
      "we couldn't reach the warehouse system" copy.

    Silent-degrade is NOT the right posture on the write path — a
    customer clicking "Request dispatch" needs to know whether it
    landed or not. Different from Phase 1's inventory read, which
    treats an unreachable PSP as "no stock on hand".
    """

    if not is_psp_live(organization):
        return None, "psp_unavailable"
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None, "psp_unavailable"

    payload = {
        "customer_uuid": str(customer_uuid),
        "lot_uuid": str(lot_uuid),
        "qty": str(qty),
        "reference": reference,
        "notes": notes,
        "source": source,
        "external_reference": external_reference,
    }

    client = _client_factory(config)
    try:
        response = client.create_customer_fulfilment_request(payload)
    except PspError as exc:
        # ``_request`` embeds PSP's response body in the exception
        # message for 4xx responses ("HTTP 422. Body: {...detail...}").
        # Sniff for the known detail codes so the portal view can
        # render a specific message; anything unrecognised falls back
        # to the generic "psp_error" bucket.
        detail = _sniff_psp_error_detail(exc)
        return None, detail or "psp_error"

    if not isinstance(response, dict):
        return None, "psp_error"
    return response, None


_KNOWN_DISPATCH_ERROR_CODES = (
    "lot_not_found",
    "bad_qty",
    "no_bailee_placement",
    "insufficient_qty",
    "missing_key",
    "validation_error",
)


def _sniff_psp_error_detail(exc: PspError) -> str | None:
    """Best-effort extraction of PSP's ``detail`` code from the
    exception message. ``_request`` doesn't expose the raw body as a
    dict on the exception, but it does inline it into the message
    string for 4xx responses, so a substring scan is fine here."""

    msg = str(exc)
    for code in _KNOWN_DISPATCH_ERROR_CODES:
        if f'"detail":"{code}"' in msg or f'"detail": "{code}"' in msg:
            return code
    return None


def get_psp_customer_bailee_inventory(
    *,
    organization: Any,
    customer_uuid: Any,
) -> dict | None:
    """Fetch the customer's bailee-custody inventory snapshot from PSP.

    Powers Phase 1 of the 3PL portal integration — the customer's
    warehouse-visibility page reads this to render the "here's what
    we're holding for you + how much storage is accruing" surface.

    Silent-degrade posture — returns ``None`` when the integration
    isn't live, the token can't be decrypted, PSP is unreachable, or
    PSP doesn't recognise the customer uuid. The portal treats the
    empty response as "no held stock" and shows the empty-state
    copy, not an error banner.
    """

    if not is_psp_live(organization):
        return None
    try:
        config = get_psp_config(organization=organization)
    except PspDecryptionFailed:
        return None
    client = _client_factory(config)
    try:
        return client.get_customer_bailee_inventory(customer_uuid)
    except PspError:
        return None


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


#: Local catalogue slug → PSP ``item_type`` mapping for the reverse-
#: mirror path. Only slugs that map to a PSP-side type are eligible;
#: custom org catalogues stay local (there's no PSP twin to push to).
_PSP_ITEM_TYPE_FOR_SLUG: dict[str, str] = {
    "raw_materials": "raw_material",
    "packaging": "packaging",
    "consumables": "consumable",
}


def ensure_psp_item(
    *,
    organization: Any,
    actor: Any,
    item: Any,
    client: Any | None = None,
) -> str | None:
    """Guarantee the local ``catalogues.Item`` has a corresponding row
    on PSP + return that PSP uuid.

    Fast path: if ``item.psp_source_uuid`` is already set, return it
    without a round-trip. Otherwise push-create the item on PSP via
    ``POST /api/integration/items`` (idempotent by
    ``external_sku=NPD-<prefix>-<local uuid>``), pin the returned
    uuid on ``item.psp_source_uuid``, and return it.

    Reverse-mirror is the opposite direction of :func:`mirror_psp_item`
    (which pulls PSP → local). It's the escape hatch for legacy NPD-
    native items — rows imported before PSP was connected, or created
    directly against NPD's local catalogue — so downstream flows
    (packaging overlay, formulation sync, MO create) can find a PSP
    uuid on every referenced item without asking the operator to
    re-key each one on PSP by hand.

    Compliance note: PSP-side compliance sub-tables (allergens,
    certificates, storage tags) stay operator-owned. Reverse-mirror
    seeds the base row only. Operators hydrate the sub-tables on
    PSP after the row lands.

    Returns the PSP uuid on success, or ``None`` on soft failure
    (unknown catalogue slug, PSP unreachable, create rejected). The
    caller decides how to react — the packaging overlay path treats
    ``None`` as unresolved and surfaces a loud fail.
    """

    from django.db import transaction

    from apps.audit.services import record as record_audit
    from apps.catalogues.models import PSP_MIRROR_SLUG

    if item is None:
        return None

    existing = getattr(item, "psp_source_uuid", None)
    if existing:
        return str(existing)

    if not is_psp_live(organization):
        return None

    # Resolve the PSP item_type from the item's catalogue slug. A
    # psp_mirror row without a psp_source_uuid is a bug (mirror path
    # should have pinned one), but treat it as a raw material to keep
    # the fallback benign. Unknown slugs (custom org catalogues) skip
    # — there's no meaningful PSP twin for a bespoke catalogue.
    catalogue = getattr(item, "catalogue", None)
    slug = getattr(catalogue, "slug", None) if catalogue else None
    if slug == PSP_MIRROR_SLUG:
        item_type = "raw_material"
    else:
        item_type = _PSP_ITEM_TYPE_FOR_SLUG.get(str(slug or ""))
    if not item_type:
        return None

    # External sku carries the "NPD-owned" ownership signal PSP looks
    # for on the safe-delete path. Format mirrors the stage-item
    # convention (``NPD-STAGE-…``) so the pattern is consistent across
    # every reverse-mirrored row on PSP.
    prefix_by_type = {
        "raw_material": "RM",
        "packaging": "PKG",
        "consumable": "CONS",
    }
    external_sku = f"NPD-{prefix_by_type[item_type]}-{item.id}"

    if client is None:
        try:
            config = get_psp_config(organization=organization)
        except PspError:
            return None
        client = _client_factory(config)

    # Resolve the item's stock UoM against PSP's registry. Without
    # this the reverse-mirrored row lands on PSP with ``stock_uom_id
    # = NULL`` — every downstream surface that reads the item (parts
    # table, BOM push, cost calculator) then falls back to "unknown
    # unit" and renders quantities with a "?" marker.
    #
    # Silent-degrade on lookup failure: an unknown unit symbol (or a
    # PSP unit catalog we can't reach) returns ``None`` and we push
    # the item without a UoM — operators can set it on PSP's item
    # form after. Better a bare row than a hard fail here.
    stock_uom_uuid: str | None = None
    try:
        symbol = _unit_symbol_for(item)
        # Fallback: packaging / consumable items on NPD often ship
        # without an explicit unit (a bottle is "a bottle", not a
        # weight). Default those to ``pcs`` — PSP's count-base UoM —
        # so the reverse-mirrored row lands with a usable unit
        # rather than the "?" fallback. Raw materials get no
        # fallback because guessing mg / g / mL for an ingredient
        # would silently misconvert every downstream BOM math.
        if not symbol and item_type in ("packaging", "consumable"):
            symbol = "pcs"
        if symbol:
            stock_uom_uuid = _psp_uom_uuid_for(client, organization, symbol)
    except PspError:
        stock_uom_uuid = None

    # Barcode (typically packaging + some raw materials carry one).
    # Pulled off ``item.attributes`` when the NPD-side attribute
    # definition wired one up; empty otherwise.
    barcode_raw = ""
    attrs = getattr(item, "attributes", None) or {}
    if isinstance(attrs, dict):
        for key in ("barcode", "gtin", "ean", "upc"):
            v = attrs.get(key)
            if isinstance(v, str) and v.strip():
                barcode_raw = v.strip()
                break

    try:
        # Free-form ``attributes`` are deliberately dropped on the
        # reverse-mirror. NPD's ``Item.attributes`` bag isn't
        # constrained; PSP's items table validates every attribute
        # key against its ``attribute_definitions`` table and 422s
        # on unknown keys. Ops-defined packaging attributes
        # (``dimension``, ``material``, ``resealable``) rarely map
        # one-for-one across systems. Base row + UoM + barcode seed
        # cleanly; operators hydrate PSP-side attributes / allergens
        # / certificates / storage tags after.
        response = client.create_item(
            name=(item.name or "").strip() or f"NPD item {item.id}",
            item_type=item_type,
            external_sku=external_sku,
            description=(getattr(item, "description", "") or "").strip(),
            stock_uom_uuid=stock_uom_uuid,
            barcode=barcode_raw,
        )
    except PspError:
        return None

    if not isinstance(response, dict):
        return None
    psp_uuid = response.get("uuid")
    if not psp_uuid:
        return None
    psp_uuid = str(psp_uuid)

    with transaction.atomic():
        # Pin the returned uuid on the local row so subsequent flows
        # (formulation sync, another combo overlay) skip the reverse-
        # mirror round-trip on the fast path. ``updated_by`` records
        # the actor that triggered the mirror.
        item.psp_source_uuid = psp_uuid
        if actor is not None and hasattr(item, "updated_by"):
            item.updated_by = actor
        item.save(update_fields=["psp_source_uuid", "updated_by", "updated_at"])
        record_audit(
            organization=organization,
            actor=actor,
            action="catalogue_item.psp_reverse_mirror",
            target=item,
            after={
                "psp_source_uuid": psp_uuid,
                "external_sku": external_sku,
                "item_type": item_type,
                "created": bool(response.get("created")),
            },
        )

    return psp_uuid


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
