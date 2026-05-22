"""Microsoft Dynamics 365 (Sales / CE) Dataverse client.

Two implementations behind a single :class:`DataverseClient` shape:

* :class:`MockDataverseClient` — canned responses, used in dev and
  every test. Set ``DATAVERSE_MOCK=true`` (or call ``with_mock(True)``
  in tests) to opt in. Lets us build and integration-test the entire
  customer-picker → import flow without ever touching a real
  Dynamics tenant. Critical because no sandbox is available on this
  account: the only real-tenant traffic we ship is the one
  ``test_connection()`` an admin triggers from Settings.

* :class:`HttpDataverseClient` — real OAuth2 client-credentials
  flow against Azure AD + OData v9.2 calls against Dataverse. Used
  in production when an org has saved their config and an operator
  picks from the Dynamics picker.

Both raise typed exceptions (:class:`DataverseAuthFailed`,
:class:`DataverseUnreachable`, :class:`DataverseRateLimited`) so the
service layer can map them onto user-facing UI states without
catching bare ``requests.exceptions.*``. The customer picker
silently degrades to "local results only" on every failure mode so
a Dynamics outage never blocks the rest of the app.
"""

from __future__ import annotations

import os
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DynamicsContact:
    """One contact / account row returned by a Dataverse search.

    Field naming follows the local :class:`Customer` model so the
    import service can map fields 1:1 without a translation layer.

    Two Dataverse identifiers travel together now:

    * :attr:`account_id` — the **company** GUID (Dataverse account
      row). New imports anchor on this so the same business can
      never duplicate into two local rows whether the operator
      picked the contact or the account. ``None`` only when the
      picked entity is a contact with no parent account (rare —
      freelancer-ish records).
    * :attr:`contact_id` — the **person** GUID (Dataverse contact
      row). ``None`` when the picked entity was an account row
      directly with no contact selected.

    :attr:`dynamics_id` is the legacy combined field — whatever
    GUID the search row carried. Kept so old call sites that only
    know about the single GUID still work; new code should prefer
    the explicit ``account_id`` / ``contact_id`` pair.
    """

    dynamics_id: str
    name: str
    company: str
    email: str
    phone: str
    address: str
    account_id: str | None = None
    contact_id: str | None = None


@dataclass(frozen=True)
class DynamicsConfig:
    """In-memory shape of an org's Dynamics integration config.

    Source of truth lives on :attr:`Organization.dynamics_config`
    (JSONField) — this dataclass is a typed view for the service +
    client layers so callers don't sprinkle ``dict.get`` everywhere.
    """

    enabled: bool
    dataverse_url: str
    tenant_id: str
    client_id: str
    #: Plaintext secret — only present in-memory inside the service
    #: layer after a fresh ``decrypt_secret`` call. NEVER serialised
    #: back to the wire — the API surfaces a ``has_secret`` flag
    #: instead so the form can show "●●●●●●●" without leaking.
    client_secret: str

    @property
    def is_complete(self) -> bool:
        """True when every required field has a non-empty value.

        The integration is only usable when complete; the settings
        UI gates "Test Connection" and the customer picker on this.
        """

        return bool(
            self.enabled
            and self.dataverse_url
            and self.tenant_id
            and self.client_id
            and self.client_secret
        )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DataverseError(Exception):
    """Base class for every Dynamics-side failure.

    The service layer catches the base class to silently degrade
    the picker; the API layer catches specific subclasses to map
    onto distinct UI states ("Bad credentials" vs "Unreachable").
    """


class DataverseAuthFailed(DataverseError):
    code = "dynamics_auth_failed"


class DataverseUnreachable(DataverseError):
    code = "dynamics_unreachable"


class DataverseRateLimited(DataverseError):
    code = "dynamics_rate_limited"


class DataverseInvalidConfig(DataverseError):
    code = "dynamics_invalid_config"


# ---------------------------------------------------------------------------
# Mock client — every test + every dev runs this
# ---------------------------------------------------------------------------


_MOCK_CONTACTS: tuple[DynamicsContact, ...] = (
    DynamicsContact(
        dynamics_id="11111111-1111-1111-1111-111111111111",
        name="James Brown",
        company="ACME Wellness Ltd",
        email="james.brown@acme-wellness.example",
        phone="+44 20 7946 0100",
        address="221B Baker Street, London NW1 6XE, UK",
    ),
    DynamicsContact(
        dynamics_id="22222222-2222-2222-2222-222222222222",
        name="Sophia Lee",
        company="Nutrivate GmbH",
        email="sophia.lee@nutrivate.example",
        phone="+49 30 1234 5678",
        address="Friedrichstraße 1, 10117 Berlin, DE",
    ),
    DynamicsContact(
        dynamics_id="33333333-3333-3333-3333-333333333333",
        name="Diego Hernández",
        company="Vitalia Health SA",
        email="diego.hernandez@vitalia.example",
        phone="+34 91 123 4567",
        address="Calle Gran Vía 28, 28013 Madrid, ES",
    ),
    DynamicsContact(
        dynamics_id="44444444-4444-4444-4444-444444444444",
        name="Hiroshi Tanaka",
        company="Sakura Supplements KK",
        email="h.tanaka@sakura-sup.example",
        phone="+81 3 1234 5678",
        address="2-1-1 Shibuya, Shibuya-ku, Tokyo 150-0002, JP",
    ),
    DynamicsContact(
        dynamics_id="55555555-5555-5555-5555-555555555555",
        name="Aoife O'Reilly",
        company="Celtic Wellness Co",
        email="aoife@celtic-wellness.example",
        phone="+353 1 234 5678",
        address="1 St Stephen's Green, Dublin D02, IE",
    ),
)


class MockDataverseClient:
    """Returns canned Dynamics contacts for any query.

    Substring-matches against the contact name, company, and email
    so the picker behaves the same as the real backend for typeahead
    testing. ``test_connection`` always succeeds.

    The mock NEVER touches the network — safe to use in CI and on a
    dev laptop with zero credentials.
    """

    def __init__(self, config: DynamicsConfig | None = None) -> None:
        self._config = config

    def test_connection(self) -> None:
        # Mock is always "reachable". Real client raises on auth /
        # network failure.
        return None

    def search_contacts(self, query: str, *, limit: int = 10) -> list[DynamicsContact]:
        needle = (query or "").strip().lower()
        if not needle:
            return list(_MOCK_CONTACTS[:limit])
        return [
            contact
            for contact in _MOCK_CONTACTS
            if needle in contact.name.lower()
            or needle in contact.company.lower()
            or needle in contact.email.lower()
        ][:limit]


# ---------------------------------------------------------------------------
# Real HTTP client
# ---------------------------------------------------------------------------


class HttpDataverseClient:
    """Real Dataverse client — OAuth2 client-credentials + OData v9.2.

    Lazy auth: the access token is fetched on the first call and
    cached in-memory for its TTL. Each instance is bound to one
    org's config; the service layer instantiates a fresh client per
    request because :class:`Organization` reads are cheap and we
    don't want stale tokens persisting across config edits.

    Network calls use the stdlib :mod:`urllib` instead of pulling
    ``requests`` to keep this file dependency-free; Dataverse's API
    is plain JSON over HTTPS so the convenience layer isn't worth
    a new requirement.
    """

    #: Hard cap on the HTTP timeout so a hung Dynamics tenant cannot
    #: block the customer picker's response. The picker silently
    #: degrades to local-only results when this fires.
    DEFAULT_TIMEOUT_SECONDS: float = 4.0

    def __init__(self, config: DynamicsConfig) -> None:
        if not config.is_complete:
            raise DataverseInvalidConfig(
                "Dynamics integration is missing required fields."
            )
        self._config = config
        self._token: str | None = None
        self._token_expires_at: float = 0.0

    # ---- OAuth ----------------------------------------------------------

    def _token_endpoint(self) -> str:
        return (
            f"https://login.microsoftonline.com/{self._config.tenant_id}"
            f"/oauth2/v2.0/token"
        )

    def _resource_scope(self) -> str:
        # Dataverse expects the resource URL + ``/.default``.
        base = self._config.dataverse_url.rstrip("/")
        return f"{base}/.default"

    def _fetch_token(self) -> str:
        body = urllib.parse.urlencode(
            {
                "client_id": self._config.client_id,
                "client_secret": self._config.client_secret,
                "scope": self._resource_scope(),
                "grant_type": "client_credentials",
            }
        ).encode("utf-8")
        request = Request(
            self._token_endpoint(),
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.DEFAULT_TIMEOUT_SECONDS) as response:
                payload = _parse_json(response.read())
        except HTTPError as exc:
            # 4xx from the token endpoint = bad client_id / secret /
            # tenant. Raise specific auth error so the settings UI
            # surfaces "Invalid client secret" rather than a generic
            # network error.
            if 400 <= exc.code < 500:
                raise DataverseAuthFailed(
                    _extract_aad_error(exc) or "Azure AD rejected the credentials."
                ) from exc
            raise DataverseUnreachable(
                f"Azure AD token endpoint returned {exc.code}."
            ) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise DataverseUnreachable(
                "Could not reach Azure AD token endpoint."
            ) from exc
        token = payload.get("access_token") if isinstance(payload, dict) else None
        if not isinstance(token, str) or not token:
            raise DataverseAuthFailed(
                "Azure AD response did not include an access token."
            )
        # Refresh ~5 min before expiry so a long-running request
        # never trips on a just-expired token.
        expires_in = int(payload.get("expires_in", 3600))
        self._token = token
        self._token_expires_at = time.monotonic() + max(60, expires_in - 300)
        return token

    def _access_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        return self._fetch_token()

    # ---- HTTP helpers ---------------------------------------------------

    def _dataverse_url(self, path: str) -> str:
        base = self._config.dataverse_url.rstrip("/")
        suffix = path if path.startswith("/") else f"/{path}"
        return f"{base}/api/data/v9.2{suffix}"

    def _get(self, path: str) -> dict[str, Any]:
        request = Request(
            self._dataverse_url(path),
            headers={
                "Authorization": f"Bearer {self._access_token()}",
                "Accept": "application/json",
                "OData-MaxVersion": "4.0",
                "OData-Version": "4.0",
                "Prefer": 'odata.include-annotations="*"',
            },
        )
        try:
            with urlopen(request, timeout=self.DEFAULT_TIMEOUT_SECONDS) as response:
                payload = _parse_json(response.read())
        except HTTPError as exc:
            if exc.code == 401 or exc.code == 403:
                raise DataverseAuthFailed(
                    "Dataverse rejected the access token."
                ) from exc
            if exc.code == 429:
                raise DataverseRateLimited(
                    "Dataverse rate limit hit — try again in a moment."
                ) from exc
            # Surface Dataverse's own error message — 400s mean the
            # query is rejected, and the body explains which column /
            # filter syntax is wrong. Without this the picker silently
            # swallows the failure and gives the developer nothing
            # actionable.
            detail = _extract_dataverse_error(exc)
            suffix = f" {detail}" if detail else ""
            raise DataverseUnreachable(
                f"Dataverse returned {exc.code}.{suffix}"
            ) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise DataverseUnreachable(
                "Could not reach the Dataverse endpoint."
            ) from exc
        if not isinstance(payload, dict):
            raise DataverseUnreachable("Unexpected Dataverse response shape.")
        return payload

    # ---- Public API -----------------------------------------------------

    def test_connection(self) -> None:
        """Issue a single low-cost call so the settings UI can verify
        the credentials. We ask for ``whoami`` — costs nothing,
        validates auth, and confirms the Dataverse URL is reachable.
        Returns silently on success; raises on any failure mode.
        """

        self._get("/WhoAmI")

    def search_contacts(
        self, query: str, *, limit: int = 10
    ) -> list[DynamicsContact]:
        """Type-ahead search across Dataverse contacts AND accounts.

        Most B2B customers in Dynamics live under the ``accounts``
        table (companies); the people you actually deal with live
        under ``contacts`` and lookup back to their account. We
        query both in parallel and merge the results so the picker
        can match either side of that split — typing "ACME" finds
        the company; typing "Linda" finds the person.

        Empty query returns recently-modified records from both
        tables (capped). Limit is split between the two so the
        total result count matches the caller's request.
        """

        capped = max(1, min(limit, 25))
        per_table = max(1, capped // 2)
        merged: list[DynamicsContact] = []
        merged.extend(self._search_contacts_table(query, limit=per_table))
        merged.extend(self._search_accounts_table(query, limit=per_table))
        # Dedup by dynamics_id (a contact and its parent account
        # would never share a GUID, so this is a defensive measure
        # for re-merges across pages).
        seen: set[str] = set()
        unique: list[DynamicsContact] = []
        for c in merged:
            if c.dynamics_id in seen:
                continue
            seen.add(c.dynamics_id)
            unique.append(c)
        return unique[:capped]

    def _search_contacts_table(
        self, query: str, *, limit: int
    ) -> list[DynamicsContact]:
        """Query the OOB ``contacts`` entity (people).

        Selects the full set of identity / contact / address columns
        we want on the local :class:`Customer` row. ``mobilephone``
        falls back to ``telephone1`` when blank — many sales people
        only fill one or the other.
        """

        params: dict[str, str] = {
            "$select": ",".join(
                [
                    "contactid",
                    "fullname",
                    "firstname",
                    "lastname",
                    "emailaddress1",
                    "telephone1",
                    "mobilephone",
                    "address1_line1",
                    "address1_line2",
                    "address1_city",
                    "address1_stateorprovince",
                    "address1_country",
                    "address1_postalcode",
                    # The parent-account GUID column. Some tenants
                    # don't expose the ``parentcustomeridname``
                    # virtual property at all (rejects with 400),
                    # so we read the formatted display name from
                    # the OData annotation header instead — see
                    # the row-decode block below.
                    "_parentcustomerid_value",
                ]
            ),
            "$top": str(limit),
        }
        term = (query or "").strip().replace("'", "''")
        if term:
            # Dataverse rejects ``contains(...)`` on many tenants
            # (501 "The 'contains' function isn't supported") and
            # ``fullname`` is a calculated column you can't put in
            # ``$filter`` at all — so we fall back to ``startswith``
            # against the underlying ``firstname`` + ``lastname`` +
            # ``emailaddress1`` columns. Less forgiving than the
            # ideal "substring anywhere" — a search for "brown"
            # won't match "Mr Brown" — but works on every Dataverse
            # configuration we've encountered. Dataverse string
            # filters are case-insensitive by default on most
            # collations so we send the term verbatim.
            params["$filter"] = (
                f"(startswith(firstname,'{term}') or "
                f"startswith(lastname,'{term}') or "
                f"startswith(emailaddress1,'{term}'))"
            )
        query_string = urllib.parse.urlencode(
            params, quote_via=urllib.parse.quote
        )
        path = f"/contacts?{query_string}"
        payload = self._get(path)
        rows = payload.get("value") or []
        contacts: list[DynamicsContact] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            # Compose a single-line address from the parts so the
            # local Customer's free-text address column reads well.
            # Dropping empty parts keeps the spacing tight even when
            # the contact is missing half the address fields.
            address = _join_address_parts(
                row.get("address1_line1"),
                row.get("address1_line2"),
                row.get("address1_city"),
                row.get("address1_stateorprovince"),
                row.get("address1_postalcode"),
                row.get("address1_country"),
            )
            # Fall back from fullname → "first last" when fullname
            # is blank (some tenants disable the calculated column).
            name = str(row.get("fullname") or "").strip()
            if not name:
                first = str(row.get("firstname") or "").strip()
                last = str(row.get("lastname") or "").strip()
                name = " ".join(p for p in (first, last) if p)
            # Phone: prefer landline; fall back to mobile.
            phone = str(
                row.get("telephone1") or row.get("mobilephone") or ""
            ).strip()
            company = _lookup_formatted(row, "_parentcustomerid_value")
            contact_id = str(row.get("contactid") or "").strip()
            # Parent account GUID (the company this contact belongs
            # to). ``_parentcustomerid_value`` is the FK column; when
            # the contact has no parent account on file, this is
            # blank and we leave ``account_id`` as ``None``. The
            # import resolver falls back to the legacy
            # ``dynamics_id`` path for such records.
            account_id_raw = str(
                row.get("_parentcustomerid_value") or ""
            ).strip()
            account_id = account_id_raw or None
            contacts.append(
                DynamicsContact(
                    dynamics_id=contact_id,
                    name=name,
                    company=company,
                    email=str(row.get("emailaddress1") or "").strip(),
                    phone=phone,
                    address=address,
                    account_id=account_id,
                    contact_id=contact_id or None,
                )
            )
        return [c for c in contacts if c.dynamics_id]

    def _search_accounts_table(
        self, query: str, *, limit: int
    ) -> list[DynamicsContact]:
        """Query the OOB ``accounts`` entity (companies / orgs).

        Most B2B customer relationships in Dynamics live on the
        account record — the name on the contract, the billing
        address, the primary email. Our local ``Customer`` model
        has both a ``name`` (contact person) and ``company`` field,
        so an account row maps in as ``company=<account.name>`` with
        the account's primary phone / email / address surfaced. The
        primary contact's name (when set on the account) becomes the
        Customer's ``name``.
        """

        params: dict[str, str] = {
            "$select": ",".join(
                [
                    "accountid",
                    "name",
                    "emailaddress1",
                    "telephone1",
                    "address1_line1",
                    "address1_line2",
                    "address1_city",
                    "address1_stateorprovince",
                    "address1_country",
                    "address1_postalcode",
                    # Primary-contact GUID column — we read the
                    # formatted person name from the OData
                    # annotation header rather than from the
                    # ``primarycontactidname`` virtual property,
                    # which not every Dataverse tenant exposes.
                    "_primarycontactid_value",
                ]
            ),
            "$top": str(limit),
        }
        term = (query or "").strip().replace("'", "''")
        if term:
            # ``name`` is the company name column on accounts.
            # Falls back to email so users can paste a domain.
            params["$filter"] = (
                f"(startswith(name,'{term}') or "
                f"startswith(emailaddress1,'{term}'))"
            )
        query_string = urllib.parse.urlencode(
            params, quote_via=urllib.parse.quote
        )
        path = f"/accounts?{query_string}"
        payload = self._get(path)
        rows = payload.get("value") or []
        contacts: list[DynamicsContact] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            address = _join_address_parts(
                row.get("address1_line1"),
                row.get("address1_line2"),
                row.get("address1_city"),
                row.get("address1_stateorprovince"),
                row.get("address1_postalcode"),
                row.get("address1_country"),
            )
            account_id = str(row.get("accountid") or "").strip()
            contacts.append(
                DynamicsContact(
                    dynamics_id=account_id,
                    name=_lookup_formatted(row, "_primarycontactid_value"),
                    company=str(row.get("name") or "").strip(),
                    email=str(row.get("emailaddress1") or "").strip(),
                    phone=str(row.get("telephone1") or "").strip(),
                    address=address,
                    # Account rows carry only the account GUID; the
                    # primary-contact GUID is intentionally left blank
                    # so the import treats this as "no contact picked
                    # yet" (the operator picked the company directly).
                    account_id=account_id or None,
                    contact_id=None,
                )
            )
        return [c for c in contacts if c.dynamics_id]


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def get_client(config: DynamicsConfig) -> MockDataverseClient | HttpDataverseClient:
    """Return the right client for the current environment.

    * Tests + ``DATAVERSE_MOCK=true`` → :class:`MockDataverseClient`
    * Otherwise → :class:`HttpDataverseClient`

    Callers should treat the return type as the protocol
    (``test_connection`` + ``search_contacts``) — both implementations
    expose the same methods.
    """

    if _mock_enabled():
        return MockDataverseClient(config)
    return HttpDataverseClient(config)


def _mock_enabled() -> bool:
    raw = os.environ.get("DATAVERSE_MOCK", "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _parse_json(raw: bytes) -> Any:
    import json

    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _extract_aad_error(exc: HTTPError) -> str:
    """Pull the human-readable ``error_description`` out of an AAD
    failure response so the settings UI can show it verbatim. Falls
    back to the HTTP status when the body isn't parseable."""

    try:
        body = exc.read()
    except Exception:
        return ""
    payload = _parse_json(body)
    if isinstance(payload, dict):
        return str(payload.get("error_description") or "").strip()
    return ""


def _lookup_formatted(row: dict[str, Any], lookup_column: str) -> str:
    """Pull the human-readable display name out of a Dataverse
    lookup column's OData annotation.

    Dataverse returns lookup columns under the underscored name
    (e.g. ``_parentcustomerid_value``) carrying the target row's
    GUID. The display name comes as a sibling property with the
    ``@OData.Community.Display.V1.FormattedValue`` suffix, but
    only when the request sends ``Prefer:
    odata.include-annotations="*"`` (which our ``_get`` does).

    Returns empty string when the lookup is blank or the
    annotation is missing — both treated identically by callers,
    so the local Customer's company / name field stays empty
    rather than carrying a stray GUID.
    """

    annotation_key = (
        f"{lookup_column}@OData.Community.Display.V1.FormattedValue"
    )
    raw = row.get(annotation_key)
    if raw is None:
        return ""
    return str(raw).strip()


def _join_address_parts(*parts: Any) -> str:
    """Compose a single-line postal address from Dataverse's
    ``address1_*`` columns. Empty / ``None`` parts drop out so the
    string never has dangling commas like "ACME, , London".
    """

    cleaned = []
    for p in parts:
        if p is None:
            continue
        text = str(p).strip()
        if text:
            cleaned.append(text)
    return ", ".join(cleaned)


def _extract_dataverse_error(exc: HTTPError) -> str:
    """Extract the inner error message from a Dataverse error
    response. Dataverse follows the OData v4 error envelope:

    .. code-block:: json

        {"error": {"code": "0x...", "message": "..."}}

    Falls back to the raw body text (truncated) if the JSON parse
    fails — the operator still wants to see something rather than
    a bare HTTP status code."""

    try:
        body = exc.read()
    except Exception:
        return ""
    payload = _parse_json(body)
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or "").strip()
    try:
        text = body.decode("utf-8", errors="replace").strip()
    except Exception:
        return ""
    if len(text) > 200:
        text = text[:200] + "…"
    return text
