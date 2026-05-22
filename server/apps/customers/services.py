"""Service layer for the customers app.

The address-book is deliberately thin: CRUD plus a search helper the
proposal picker hits to populate its typeahead. Keeping this module
tiny lets us evolve ``Customer`` without touching proposal code.

The Microsoft Dynamics integration (config CRUD + on-demand import)
also lives here so the customer surface stays the single source of
truth for what a "customer" means inside the app.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Exists, OuterRef, Q, QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.customers.dynamics import (
    DataverseError,
    DynamicsConfig,
    DynamicsContact,
    get_client,
)
from apps.customers.models import Customer
from apps.organizations.encryption import (
    DecryptionFailed,
    decrypt_secret,
    encrypt_secret,
)
from apps.organizations.models import Organization


class CustomerNotFound(Exception):
    code = "customer_not_found"


class CustomerHasPortalAccount(Exception):
    """Raised when trying to delete a customer that still has at
    least one :class:`ClientAccount` pointing at it.

    A linked portal account means the customer has activated (or
    been issued) a login for the customer portal — deleting the
    Customer row would orphan their sessions and break their
    proposal / spec access. The staff side has to revoke or move
    the portal account first.

    The frontend maps this to a 409 with a clear error toast;
    deletion is silently refused without this guard because the
    DB-level ``on_delete=PROTECT`` raises ``ProtectedError`` which
    surfaces as an opaque 500.
    """

    code = "customer_has_portal_account"


class CustomerCreationDisabledByDynamics(Exception):
    """The org is wired up to Microsoft Dynamics and manual customer
    creation is disabled — every customer for these orgs must enter
    the system through the Dynamics import path so Dataverse stays
    the source of truth.

    The API layer maps this to a 409 with a codified error so the
    frontend banner ("customers are managed via Dynamics") matches
    the server response when a buggy / outdated client tries to POST
    anyway.
    """

    code = "customer_creation_disabled_by_dynamics"


def is_dynamics_live(organization: Organization) -> bool:
    """Return True when the org has an actually-usable Dynamics
    integration.

    "Live" = the owner has flipped ``enabled`` AND a client secret
    is stored. ``last_tested_at`` is a UX hint (when did we last
    confirm credentials work) and is deliberately *not* part of
    the gate — a re-keyed integration that hasn't been re-tested
    yet shouldn't silently let manual customer rows back into the
    DB. Conversely, if ``enabled`` is off (operator paused the
    integration) the gate releases so the team isn't locked out.

    Single source of truth for every "is Dynamics on?" branch in
    this app — both the customer-create guard below and the
    organization serializer's read-only flag read from this helper
    so they can never drift.
    """

    raw = organization.dynamics_config or {}
    return bool(raw.get("enabled")) and bool(
        raw.get("client_secret_ciphertext")
    )


class DynamicsNotConfigured(Exception):
    """The org has no usable Dynamics config (missing fields, or the
    integration was disabled). The API layer maps this to a 400 so
    the picker can surface a "set up Dynamics first" hint."""

    code = "dynamics_not_configured"


class DynamicsConfigInvalid(Exception):
    """A required field was missing in the config payload. Caller
    is expected to pass a dict from the trusted API serializer, so
    this is a developer error rather than a user-facing validation
    failure."""

    code = "dynamics_config_invalid"


class DynamicsContactEmailCollision(Exception):
    """A Dataverse contact tried to import with an email that an
    existing local Customer already holds — and that local row is
    already linked to a *different* Dynamics contact.

    The integration refuses to silently pick a winner. The operator
    has to reconcile on the Dynamics side (merge contacts, or fix
    whichever address is wrong) before the import will land.
    """

    code = "dynamics_contact_email_collision"


class CustomerEmailAlreadyExists(Exception):
    """An operator tried to create a new Customer at an email
    another row in the same org already uses.

    Forward-only safeguard: existing duplicates in the database
    keep working untouched, but no new rows can be added to the
    pile. The API layer maps this to a 409 with the conflicting
    customer's id so the FE can offer "open existing customer"
    instead of letting the operator create a second row.
    """

    code = "customer_email_already_exists"

    def __init__(self, message: str, *, existing_customer_id: Any) -> None:
        super().__init__(message)
        self.existing_customer_id = existing_customer_id


def _with_portal_account_annotation(qs: QuerySet[Customer]) -> QuerySet[Customer]:
    """Annotate each row with two booleans the FE renders:

    * ``_has_portal_account`` — any :class:`ClientAccount` exists
      for this customer (pending OR activated).
    * ``_portal_account_activated`` — at least one of those
      accounts has set a password (``activated_at IS NOT NULL``).

    Two ``Exists`` subqueries are cheaper than a join + GROUP BY
    and they cap at one row each, so the cost stays bounded on
    customers with multiple linked accounts.

    Lazy import keeps the cff / customers apps importable in any
    order during migrations — the client portal app pulls a wider
    auth dep graph that would otherwise tie the customers app
    boot to it.
    """

    from apps.client_portal.models import ClientAccount

    return qs.annotate(
        _has_portal_account=Exists(
            ClientAccount.objects.filter(customer_id=OuterRef("pk"))
        ),
        _portal_account_activated=Exists(
            ClientAccount.objects.filter(
                customer_id=OuterRef("pk"),
                activated_at__isnull=False,
            )
        ),
    )


def list_customers(
    *,
    organization: Organization,
    search: str = "",
) -> QuerySet[Customer]:
    """Return the org's customers, newest first when unfiltered.

    ``search`` runs a case-insensitive prefix + substring match
    across name / company / email so the proposal picker's
    typeahead finds a client regardless of which field the user
    types first.

    Every row is annotated with portal-account presence so the
    customers list page can render a "Has portal login" badge
    and hide the delete affordance without a second round-trip.
    """

    queryset = Customer.objects.filter(organization=organization)
    if search:
        term = search.strip()
        if term:
            queryset = queryset.filter(
                Q(name__icontains=term)
                | Q(company__icontains=term)
                | Q(email__icontains=term)
            )
    return _with_portal_account_annotation(queryset).order_by(
        "company", "name",
    )


def get_customer(
    *, organization: Organization, customer_id: Any
) -> Customer:
    obj = (
        _with_portal_account_annotation(
            Customer.objects.filter(
                organization=organization, id=customer_id,
            )
        )
        .first()
    )
    if obj is None:
        raise CustomerNotFound()
    return obj


@transaction.atomic
def create_customer(
    *,
    organization: Organization,
    actor: Any,
    name: str = "",
    company: str = "",
    email: str = "",
    phone: str = "",
    invoice_address: str = "",
    delivery_address: str = "",
    notes: str = "",
) -> Customer:
    # Dynamics-managed orgs must import from Dataverse — manual rows
    # would create a second source of truth and silently diverge from
    # the CRM the rest of the company runs on. Edit is *not* blocked
    # (no auto-sync today, so local tweaks to a previously-imported
    # row are still meaningful); only the create path is gated. The
    # ``import_from_dynamics`` flow bypasses this guard because it
    # calls ``Customer.objects.create`` directly — that's intentional
    # so the picker still works.
    if is_dynamics_live(organization):
        raise CustomerCreationDisabledByDynamics()

    # Forward-only duplicate guard. Existing rows that share an
    # email keep coexisting (the audit doesn't touch them), but no
    # NEW row can land at an email another row in this org already
    # uses. Surface the conflicting row's id so the FE can offer
    # "open existing customer" instead of forcing the operator to
    # search by hand. Case-insensitive match because address books
    # historically carry mixed-case dupes ("Alex@..." vs "alex@..."
    # are the same person).
    cleaned_email = (email or "").strip()
    if cleaned_email:
        conflicting = (
            Customer.objects
            .filter(
                organization=organization,
                email__iexact=cleaned_email,
            )
            .only("id")
            .first()
        )
        if conflicting is not None:
            raise CustomerEmailAlreadyExists(
                "Another customer in this organization already uses "
                "this email.",
                existing_customer_id=conflicting.id,
            )

    customer = Customer.objects.create(
        organization=organization,
        name=name,
        company=company,
        email=email,
        phone=phone,
        invoice_address=invoice_address,
        delivery_address=delivery_address,
        notes=notes,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="customer.create",
        target=customer,
        after=snapshot(customer),
    )
    return customer


_UPDATABLE_FIELDS = (
    "name",
    "company",
    "email",
    "phone",
    "invoice_address",
    "delivery_address",
    "notes",
)


@transaction.atomic
def update_customer(
    *, customer: Customer, actor: Any, **changes: Any
) -> Customer:
    before = snapshot(customer)
    old_email = (customer.email or "").strip().lower()

    for key, value in changes.items():
        if key in _UPDATABLE_FIELDS and value is not None:
            setattr(customer, key, value)
    customer.updated_by = actor
    customer.save()

    # If the email actually changed, invalidate any open portal
    # invites — they were issued against the previous address (their
    # ``email_snapshot`` is pinned at creation time) and would let
    # anyone holding the old link + code activate the account at the
    # stale email. The customers page hides re-issue affordances when
    # an activated account already exists, so this only fires for the
    # "still unverified" cases the user explicitly asked us to keep
    # editable.
    new_email = (customer.email or "").strip().lower()
    if new_email != old_email:
        from apps.client_portal.models import CustomerPortalInvite
        from django.utils import timezone

        CustomerPortalInvite.objects.filter(
            customer=customer,
            used_at__isnull=True,
            invalidated_at__isnull=True,
        ).update(invalidated_at=timezone.now())

    record_audit(
        organization=customer.organization,
        actor=actor,
        action="customer.update",
        target=customer,
        before=before,
        after=snapshot(customer),
    )
    return customer


@transaction.atomic
def delete_customer(*, customer: Customer, actor: Any) -> None:
    """Delete ``customer`` and any unactivated portal stubs hanging
    off them.

    The gate is on **activated** accounts only. The kiosk flow
    pre-creates :class:`ClientAccount` rows ahead of the customer
    actually setting a password, and the customers-page invite flow
    can leave a similar unverified stub. Those stubs were never
    "real" portal logins, so deleting the customer record sweeps
    them out of the way before the FK guard can refuse the delete.

    Activated accounts (``activated_at`` populated) are still
    protected — that's the case where the customer is using the
    portal in earnest and a delete would orphan a live session.
    """

    activated_qs = customer.client_accounts.filter(
        activated_at__isnull=False,
    )
    if activated_qs.exists():
        raise CustomerHasPortalAccount()

    # Sweep any unactivated stubs first so the FK's
    # ``on_delete=PROTECT`` doesn't refuse the customer delete. Open
    # ``CustomerPortalInvite`` rows are already CASCADE'd by the FK,
    # so we don't need to clean them up here.
    customer.client_accounts.filter(activated_at__isnull=True).delete()

    before = snapshot(customer)
    target_id = str(customer.pk)
    organization = customer.organization
    customer.delete()
    record_audit(
        organization=organization,
        actor=actor,
        action="customer.delete",
        target=None,
        target_type="customer",
        target_id=target_id,
        before=before,
    )


# ---------------------------------------------------------------------------
# Microsoft Dynamics integration — config + on-demand contact import
# ---------------------------------------------------------------------------


def _decode_dynamics_config(raw: dict[str, Any] | None) -> DynamicsConfig:
    """Decode the JSON-on-disk shape into the typed
    :class:`DynamicsConfig` the client + service layers consume.

    Decryption failures bubble up as :class:`DecryptionFailed` —
    handled at the API boundary by surfacing a "re-enter credentials"
    error rather than crashing the request.
    """

    data = raw or {}
    ciphertext = str(data.get("client_secret_ciphertext") or "")
    return DynamicsConfig(
        enabled=bool(data.get("enabled")),
        dataverse_url=str(data.get("dataverse_url") or "").strip(),
        tenant_id=str(data.get("tenant_id") or "").strip(),
        client_id=str(data.get("client_id") or "").strip(),
        client_secret=decrypt_secret(ciphertext) if ciphertext else "",
    )


def get_dynamics_config(*, organization: Organization) -> DynamicsConfig:
    """Decode and return the org's Dynamics config — secret in
    plaintext. Used internally for picker / import calls. Do NOT
    return this directly from an API endpoint — the wire shape
    uses :func:`serialize_dynamics_config_for_api` which redacts
    the secret."""

    return _decode_dynamics_config(organization.dynamics_config or {})


def serialize_dynamics_config_for_api(
    organization: Organization,
) -> dict[str, Any]:
    """Wire shape for ``GET /integrations/dynamics/``. Surfaces
    every field EXCEPT the plaintext client secret — that field
    becomes a boolean ``has_secret`` so the form can render a
    "●●●●●●●" placeholder without leaking the value."""

    raw = organization.dynamics_config or {}
    return {
        "enabled": bool(raw.get("enabled")),
        "dataverse_url": str(raw.get("dataverse_url") or ""),
        "tenant_id": str(raw.get("tenant_id") or ""),
        "client_id": str(raw.get("client_id") or ""),
        "has_secret": bool(raw.get("client_secret_ciphertext")),
        "last_tested_at": raw.get("last_tested_at") or None,
    }


@transaction.atomic
def set_dynamics_config(
    *,
    organization: Organization,
    actor: Any,
    enabled: bool,
    dataverse_url: str,
    tenant_id: str,
    client_id: str,
    client_secret: str | None,
) -> dict[str, Any]:
    """Persist a new Dynamics integration config.

    ``client_secret=None`` (or empty string) means "keep the
    previously stored secret". Passing a non-empty string rotates
    the secret; passing the literal empty string AFTER explicitly
    clearing (``enabled=False``) wipes it.

    Returns the API-serialized config so the caller can echo
    immediately without a second query.
    """

    existing = organization.dynamics_config or {}
    existing_cipher = str(existing.get("client_secret_ciphertext") or "")

    if client_secret is None or client_secret == "":
        # No new secret provided — keep whatever's already on disk.
        # Lets the admin edit the dataverse_url / tenant_id without
        # re-pasting the secret every time.
        ciphertext = existing_cipher
    else:
        ciphertext = encrypt_secret(client_secret)

    payload: dict[str, Any] = {
        "enabled": bool(enabled),
        "dataverse_url": dataverse_url.strip(),
        "tenant_id": tenant_id.strip(),
        "client_id": client_id.strip(),
        "client_secret_ciphertext": ciphertext,
        # Reset the test timestamp on every save — admin must re-run
        # "Test Connection" to confirm the new values work.
        "last_tested_at": None,
    }
    organization.dynamics_config = payload
    organization.save(update_fields=["dynamics_config", "updated_at"])
    record_audit(
        organization=organization,
        actor=actor,
        action="organization.dynamics_config.update",
        target=organization,
        # NEVER include the secret (cipher or plain) in audit logs.
        after={
            "enabled": payload["enabled"],
            "dataverse_url": payload["dataverse_url"],
            "tenant_id": payload["tenant_id"],
            "client_id": payload["client_id"],
            "has_secret": bool(ciphertext),
        },
    )
    return serialize_dynamics_config_for_api(organization)


@transaction.atomic
def clear_dynamics_config(
    *, organization: Organization, actor: Any
) -> dict[str, Any]:
    """Wipe the org's Dynamics config — turns the integration off
    and forgets the credentials. Does NOT delete imported
    customers; they stay (with ``dynamics_id`` still set) so
    historical proposals keep working."""

    organization.dynamics_config = {}
    organization.save(update_fields=["dynamics_config", "updated_at"])
    record_audit(
        organization=organization,
        actor=actor,
        action="organization.dynamics_config.clear",
        target=organization,
    )
    return serialize_dynamics_config_for_api(organization)


def test_dynamics_connection(*, organization: Organization, actor: Any) -> None:
    """Round-trip the org's Dynamics config through a single low-
    cost API call (``WhoAmI``) to confirm auth + reachability.

    Raises :class:`DynamicsNotConfigured` if the config is missing
    or incomplete, or a :class:`DataverseError` subclass on any
    Dynamics-side failure. On success persists ``last_tested_at``
    and returns silently — the caller renders a "✓ Connected" badge
    in the settings UI.
    """

    config = get_dynamics_config(organization=organization)
    if not config.is_complete:
        raise DynamicsNotConfigured()
    client = get_client(config)
    client.test_connection()  # raises DataverseError on failure

    # Mark the timestamp so the settings page can render "Tested 2
    # minutes ago" — gives the admin confidence that the saved
    # config still works without re-clicking.
    raw = dict(organization.dynamics_config or {})
    raw["last_tested_at"] = timezone.now().isoformat()
    organization.dynamics_config = raw
    organization.save(update_fields=["dynamics_config", "updated_at"])
    record_audit(
        organization=organization,
        actor=actor,
        action="organization.dynamics_config.tested",
        target=organization,
        after={"ok": True},
    )


def search_dynamics_contacts(
    *, organization: Organization, query: str, limit: int = 10
) -> list[DynamicsContact]:
    """Search the org's Dynamics tenant for contacts matching
    ``query``.

    Raises :class:`DynamicsNotConfigured` when the integration is
    off / incomplete, or a :class:`DataverseError` subclass on any
    Dynamics-side failure. Picker callers catch the base
    :class:`DataverseError` and silently return an empty list so a
    Dynamics outage never blocks the local search.
    """

    config = get_dynamics_config(organization=organization)
    if not config.is_complete:
        raise DynamicsNotConfigured()
    client = get_client(config)
    return client.search_contacts(query=query, limit=limit)


#: Identity fields Dynamics is legitimately authoritative on —
#: re-imports always refresh these from the Dataverse payload because
#: the same Dynamics contact getting renamed is a normal operation
#: the CRM owns. Email is deliberately *not* here; see the in-line
#: rule in :func:`import_customer_from_dynamics` for why.
_DYNAMICS_IDENTITY_FIELDS = (
    "name",
    "company",
)

#: Soft-overwrite fields: Dynamics fills these only when the local
#: value is blank. Switched from aggressive overwrite to fill-empty
#: because the previous behaviour silently wiped manual fixes (a
#: scientist correcting a phone typo would see their edit undone on
#: the next sync). Aligns with the proposal-create back-fill rule —
#: the address book stays authoritative once a value is set.
_DYNAMICS_SOFT_FIELDS = (
    "phone",
    "invoice_address",
    "delivery_address",
)


@transaction.atomic
def import_customer_from_dynamics(
    *,
    organization: Organization,
    actor: Any,
    contact: DynamicsContact,
) -> Customer:
    """Idempotent import keyed on Dynamics GUID, with two new
    safety rules layered on the historical behaviour:

    1. **Email is portal-protected.** When the resolved local
       Customer has an activated :class:`ClientAccount`, the
       ``email`` column is never overwritten from Dataverse. The
       portal login owns that field once a customer has set a
       password — letting Dynamics stomp it would silently
       desynchronise the staff-visible address from the address
       the customer actually logs in with. Customers without a
       portal account still get the freshest Dynamics email.

    2. **Phone + addresses fill empties only.** Switched from
       aggressive overwrite to "patch blanks only" so a manual
       fix by sales/scientists (correcting a typo, fixing a
       stale shipping address) doesn't get silently undone on
       the next sync. Identity fields (``name``, ``company``)
       keep aggressive overwrite — that's what Dynamics is
       legitimately authoritative on.

    Resolution order:

    * Match by ``(organization, dynamics_id)`` first — the
       canonical refresh path.
    * If no match, also look up by ``(organization,
      lower(email))``. If a local row exists with no
      ``dynamics_id``, **adopt** it — attach ``dynamics_id`` to
      the existing row so we don't accumulate a duplicate. A
      collision with a *different* dynamics_id on the same email
      is refused (two Dataverse contacts can't legitimately share
      an email locally).
    * Otherwise create a new Customer.

    Atomic. Audit-logged in every branch so a 1-row rollback is
    one query.
    """

    if not contact.dynamics_id:
        raise DynamicsConfigInvalid(
            "Dynamics contact payload is missing the source id."
        )

    existing = (
        Customer.objects.select_for_update()
        .filter(organization=organization, dynamics_id=contact.dynamics_id)
        .first()
    )

    # Adopt-by-email path — only runs when the Dataverse GUID
    # doesn't match anything yet. Catches the common
    # manually-created-then-Dynamics-came-along case: staff typed
    # the customer locally before integration was wired up; later
    # Dynamics is enabled and imports the same person. Without this
    # path, we'd create a second row with the same email — exactly
    # the duplicate-customer trap the audit flagged.
    if existing is None and (contact.email or "").strip():
        candidate = (
            Customer.objects.select_for_update()
            .filter(
                organization=organization,
                email__iexact=contact.email.strip(),
            )
            .first()
        )
        if candidate is not None:
            if candidate.dynamics_id is None:
                # Adopt — attach the Dataverse GUID to the manual
                # row. The local FKs (proposals, client_accounts,
                # CFFs) stay where they are; we only set the link.
                candidate.dynamics_id = contact.dynamics_id
                # The save below records this via the standard
                # refresh path so the audit row also captures the
                # adoption.
                existing = candidate
            else:
                # Two Dataverse contacts can't share an email
                # locally — refuse rather than silently picking a
                # winner. Operator has to reconcile on the
                # Dynamics side.
                raise DynamicsContactEmailCollision(
                    "Another local customer already links to a "
                    "different Dynamics contact at this email.",
                )

    if existing is not None:
        before = snapshot(existing)

        # Identity fields — always refresh from Dataverse.
        existing.name = contact.name
        existing.company = contact.company

        # Email — portal-protected. If the customer has any
        # activated portal account on this row, the local email is
        # the login identity and we never touch it from Dynamics.
        # Without an activated account, the local email is just
        # the address book entry and Dataverse owns it.
        from apps.client_portal.models import ClientAccount  # local import

        portal_locked = ClientAccount.objects.filter(
            customer=existing,
            activated_at__isnull=False,
        ).exists()
        if not portal_locked:
            existing.email = contact.email

        # Soft fields — patch blanks only. A locally-curated value
        # wins over the Dataverse value forever; Dataverse only
        # fills the gap when local is empty.
        dataverse_phone = (contact.phone or "").strip()
        if dataverse_phone and not (existing.phone or "").strip():
            existing.phone = dataverse_phone
        dataverse_address = (contact.address or "").strip()
        if dataverse_address and not (existing.invoice_address or "").strip():
            existing.invoice_address = dataverse_address
        if dataverse_address and not (existing.delivery_address or "").strip():
            existing.delivery_address = dataverse_address

        existing.dynamics_synced_at = timezone.now()
        existing.updated_by = actor
        # Always include ``dynamics_id`` in update_fields because the
        # adopt path may have just set it; in the canonical refresh
        # path this is a no-op write.
        existing.save(
            update_fields=(
                *_DYNAMICS_IDENTITY_FIELDS,
                "email",
                *_DYNAMICS_SOFT_FIELDS,
                "dynamics_id",
                "dynamics_synced_at",
                "updated_by",
                "updated_at",
            )
        )
        record_audit(
            organization=organization,
            actor=actor,
            action="customer.dynamics_refreshed",
            target=existing,
            before=before,
            after=snapshot(existing),
        )
        return existing

    customer = Customer.objects.create(
        organization=organization,
        name=contact.name,
        company=contact.company,
        email=contact.email,
        phone=contact.phone,
        invoice_address=contact.address,
        delivery_address=contact.address,
        notes="",
        dynamics_id=contact.dynamics_id,
        dynamics_synced_at=timezone.now(),
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="customer.dynamics_imported",
        target=customer,
        after=snapshot(customer),
    )
    return customer


# Re-export decryption error so the API layer can map it without
# importing from the org app directly — keeps the customer-side
# error vocabulary self-contained.
DynamicsDecryptionFailed = DecryptionFailed
DataverseFailure = DataverseError
