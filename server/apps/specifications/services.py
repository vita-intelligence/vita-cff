"""Service layer for the specifications app.

Views never touch the ORM directly; they call these functions. The
workflow:

* ``create_sheet`` — wraps a :class:`FormulationVersion` the caller
  has access to. Validates that the version belongs to the same org.
* ``update_sheet`` — patch-style metadata edits.
* ``transition_status`` — enforces a whitelist of allowed transitions
  so the UI cannot put the sheet into a malformed state.
* ``render_context`` — pure function that turns a sheet + its version
  snapshot into the view-model the frontend renders. The frontend
  does not re-parse ``snapshot_totals``; it walks the flat dict this
  function produces.
"""

from __future__ import annotations

import uuid
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.template.loader import render_to_string
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from config.signatures import (
    SignatureImageInvalid,
    validate_signature_image,
)
from apps.catalogues.models import Catalogue, Item, PACKAGING_SLUG
from apps.formulations.constants import DosageForm, capsule_size_by_key
from apps.formulations.models import FormulationVersion
from apps.formulations.services import instantiate_active_label
from apps.organizations.models import Organization
from apps.specifications.constants import (
    DEFAULT_SAFETY_LIMITS,
    DEFAULT_WEIGHT_UNIFORMITY_PCT,
    PACKAGING_PLACEHOLDER,
    SAFETY_LIMIT_ROWS,
    SECTION_SLUGS,
)
from apps.specifications.models import (
    SpecificationSheet,
    SpecificationStatus,
    SpecificationTransition,
)


class SpecificationNotFound(Exception):
    code = "specification_not_found"


class SpecificationCodeConflict(Exception):
    code = "specification_code_conflict"


class FormulationVersionNotInOrg(Exception):
    code = "formulation_version_not_in_org"


class SignatureRequired(Exception):
    """A transition that demands a drawn signature was attempted
    without one (or with a malformed image payload)."""

    code = "signature_required"


class InvalidStatusTransition(Exception):
    code = "invalid_status_transition"


class PublicLinkNotEnabled(Exception):
    """The sheet the caller looked up by token has had its public link
    revoked or never had one issued. Surfaces as 404 — we deliberately
    do not distinguish between "never shared" and "link revoked" so a
    stale link leaks no information about what the sheet became."""

    code = "public_link_not_enabled"


class PackagingItemNotAllowed(Exception):
    """The caller tried to pin a packaging slot to an item that either
    does not live in the sheet's org packaging catalogue or has the
    wrong ``packaging_type`` attribute (e.g. a label selected as the
    lid)."""

    code = "packaging_item_not_allowed"


#: Map each FK slot on :class:`SpecificationSheet` to the
#: ``packaging_type`` value the selected ``Item`` must carry in its
#: dynamic attributes. Validated at every ``set_packaging`` call so
#: the spec sheet can never accidentally render a closure where the
#: bottle should be, or vice-versa. The four types come from the
#: packaging catalogue's controlled vocabulary seeded during import.
PACKAGING_SLOT_TYPES: dict[str, str] = {
    "packaging_lid": "closure",
    "packaging_container": "material",
    "packaging_label": "label",
    "packaging_antitemper": "tamper_proof",
}


#: Allowed status moves. The spec sheet cannot jump arbitrarily; the
#: scientist walks it forward through draft → in-review → approved
#: → sent → accepted / rejected. The UI disables buttons that are
#: not in the outbound set for the current status.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    SpecificationStatus.DRAFT: frozenset({SpecificationStatus.IN_REVIEW}),
    SpecificationStatus.IN_REVIEW: frozenset(
        {SpecificationStatus.APPROVED, SpecificationStatus.DRAFT}
    ),
    SpecificationStatus.APPROVED: frozenset(
        {SpecificationStatus.SENT, SpecificationStatus.DRAFT}
    ),
    SpecificationStatus.SENT: frozenset(
        {SpecificationStatus.ACCEPTED, SpecificationStatus.REJECTED}
    ),
    SpecificationStatus.ACCEPTED: frozenset(),
    SpecificationStatus.REJECTED: frozenset({SpecificationStatus.DRAFT}),
}


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


#: Foreign-key paths that every sheet-fetching query needs to pre-fetch
#: so the render path can dereference the four packaging slots without
#: an extra round-trip per slot per sheet.
_SHEET_RELATED: tuple[str, ...] = (
    "formulation_version__formulation",
    "packaging_lid",
    "packaging_container",
    "packaging_label",
    "packaging_antitemper",
)


def list_sheets(
    *,
    organization: Organization,
    formulation_id: Any | None = None,
) -> QuerySet[SpecificationSheet]:
    """List spec sheets newest-first, optionally scoped to a single
    formulation. The project workspace's Spec Sheets tab passes
    ``formulation_id`` so it only surfaces sheets hanging off this
    project's versions; the global list page omits it."""

    queryset = SpecificationSheet.objects.filter(organization=organization)
    if formulation_id is not None:
        queryset = queryset.filter(
            formulation_version__formulation_id=formulation_id
        )
    return queryset.select_related(*_SHEET_RELATED).order_by("-updated_at")


def get_sheet(
    *, organization: Organization, sheet_id: Any
) -> SpecificationSheet:
    sheet = (
        SpecificationSheet.objects.select_related(*_SHEET_RELATED)
        .filter(organization=organization, id=sheet_id)
        .first()
    )
    if sheet is None:
        raise SpecificationNotFound()
    return sheet


@transaction.atomic
def create_sheet(
    *,
    organization: Organization,
    actor: Any,
    formulation_version_id: Any,
    code: str = "",
    client_name: str = "",
    client_email: str = "",
    client_company: str = "",
    margin_percent: Any = None,
    final_price: Any = None,
    cover_notes: str = "",
    total_weight_label: str = "",
) -> SpecificationSheet:
    """Create a specification sheet locked to a formulation version.

    The version must belong to the caller's organization; crossing
    tenants is the loudest possible failure and we refuse rather than
    silently attach someone else's snapshot to an unrelated client.
    """

    version = (
        FormulationVersion.objects.select_related("formulation")
        .filter(id=formulation_version_id)
        .first()
    )
    if version is None or version.formulation.organization_id != organization.id:
        raise FormulationVersionNotInOrg()

    if code:
        duplicate = SpecificationSheet.objects.filter(
            organization=organization, code=code
        ).exists()
        if duplicate:
            raise SpecificationCodeConflict()

    sheet = SpecificationSheet.objects.create(
        organization=organization,
        formulation_version=version,
        code=code,
        client_name=client_name,
        client_email=client_email,
        client_company=client_company,
        margin_percent=margin_percent,
        final_price=final_price,
        cover_notes=cover_notes,
        total_weight_label=total_weight_label,
        status=SpecificationStatus.DRAFT,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="spec_sheet.create",
        target=sheet,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def update_sheet(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    **changes: Any,
) -> SpecificationSheet:
    mutable = {
        "code",
        "client_name",
        "client_email",
        "client_company",
        "margin_percent",
        "final_price",
        "cover_notes",
        "total_weight_label",
        # Extra packaging-spec strings from the reference workbook —
        # renderable on the customer PDF, editable through the same
        # PATCH the existing UI uses, so no new endpoint required.
        "unit_quantity",
        "food_contact_status",
        "shelf_life",
        "storage_conditions",
        "weight_uniformity",
        # ``limits_override`` is a JSON object; the serializer clamps
        # the shape before we see it here, so assignment is safe.
        "limits_override",
    }
    new_code = changes.get("code")
    if new_code and new_code != sheet.code:
        duplicate = (
            SpecificationSheet.objects.filter(
                organization=sheet.organization, code=new_code
            )
            .exclude(pk=sheet.pk)
            .exists()
        )
        if duplicate:
            raise SpecificationCodeConflict()

    before = snapshot(sheet)
    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(sheet, key, value)

    sheet.updated_by = actor
    sheet.save()
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.update",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_packaging(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    selections: dict[str, Any],
) -> SpecificationSheet:
    """Assign or clear one or more packaging slots on ``sheet``.

    ``selections`` is a dict keyed by the FK slot name
    (``packaging_lid``, ``packaging_container``, ``packaging_label``,
    ``packaging_antitemper``). Each value is either a packaging
    ``Item`` UUID or ``None`` to clear that slot. Slots not present in
    the dict are untouched — the caller can update a single slot
    without re-sending the others.

    Every non-null selection is validated twice: the item must live in
    the sheet's org ``packaging`` catalogue (prevents cross-tenant
    attach), and its ``packaging_type`` attribute must match the slot
    (prevents selecting a closure for the bottle row). Both failures
    surface as :class:`PackagingItemNotAllowed` with a single error
    code so the API layer can translate them uniformly.
    """

    before = snapshot(sheet)
    catalogue: Catalogue | None = None

    for slot, raw_id in selections.items():
        if slot not in PACKAGING_SLOT_TYPES:
            raise PackagingItemNotAllowed()

        if raw_id is None or raw_id == "":
            setattr(sheet, slot, None)
            continue

        if catalogue is None:
            catalogue = Catalogue.objects.filter(
                organization=sheet.organization, slug=PACKAGING_SLUG
            ).first()
            if catalogue is None:
                raise PackagingItemNotAllowed()

        item = Item.objects.filter(catalogue=catalogue, id=raw_id).first()
        if item is None:
            raise PackagingItemNotAllowed()

        expected_type = PACKAGING_SLOT_TYPES[slot]
        actual_type = (item.attributes or {}).get("packaging_type")
        if actual_type != expected_type:
            raise PackagingItemNotAllowed()

        setattr(sheet, slot, item)

    sheet.updated_by = actor
    sheet.save()
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_packaging",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_section_order(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    order: list[str],
) -> SpecificationSheet:
    """Persist the preferred render order for the customer-facing sheet.

    ``order`` is the full desired top-down sequence of section slugs.
    Unknown slugs are dropped rather than raising so the write
    tolerates a stale client that was loaded before a schema migration
    added or removed a section. Duplicates are deduped. The result is
    persisted verbatim — ``resolve_section_order`` does the canonical
    backfill at render time so newly-added sections still appear.
    """

    before = snapshot(sheet)
    seen: set[str] = set()
    cleaned: list[str] = []
    for slug in order:
        if not isinstance(slug, str) or slug in seen:
            continue
        if slug not in SECTION_SLUGS:
            continue
        cleaned.append(slug)
        seen.add(slug)
    sheet.section_order = cleaned
    sheet.updated_by = actor
    sheet.save(update_fields=["section_order", "updated_by", "updated_at"])
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_section_order",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_section_visibility(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    visibility: dict[str, bool],
) -> SpecificationSheet:
    """Persist ``section_visibility`` overrides on the sheet.

    ``visibility`` is a partial ``{section_slug: bool}`` map — any
    key the caller omits is left untouched on the stored dict, so a
    single toggle does not unintentionally re-expose other sections
    the customer had flagged off. Unknown slugs are silently
    dropped: the canonical list lives in
    :data:`SECTION_SLUGS` and drives both the frontend UI and the
    renderer, so tolerating stale payloads is safer than 400-ing a
    request that is otherwise valid.
    """

    before = snapshot(sheet)
    stored = dict(sheet.section_visibility or {})
    for slug, value in visibility.items():
        if slug not in SECTION_SLUGS:
            continue
        stored[slug] = bool(value)
    sheet.section_visibility = stored
    sheet.updated_by = actor
    sheet.save(
        update_fields=["section_visibility", "updated_by", "updated_at"]
    )
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_visibility",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


#: Transitions that require a captured signature before the sheet
#: can move forward. Maps ``(from_status, to_status)`` to the slot
#: the drawn image lands in. Customer sign-off (``sent → accepted``)
#: happens on the kiosk path and is handled by a dedicated endpoint
#: that binds the signature to the visitor's kiosk session — it is
#: intentionally absent from this map so the internal transition
#: view cannot be used to fake a customer signature.
_INTERNAL_SIGNATURE_SLOT: dict[tuple[str, str], str] = {
    (SpecificationStatus.DRAFT, SpecificationStatus.IN_REVIEW): "prepared_by",
    (SpecificationStatus.IN_REVIEW, SpecificationStatus.APPROVED): "director",
}


@transaction.atomic
def transition_status(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    next_status: str,
    notes: str = "",
    signature_image: str | None = None,
) -> SpecificationSheet:
    """Move the sheet one state forward and stamp an audit row.

    Certain transitions require a drawn signature captured on the
    signature pad:

    * ``draft → in_review`` — **prepared-by** (scientist who
      drafted the sheet).
    * ``in_review → approved`` — **director** / commercial owner.

    Customer sign-off (``sent → accepted``) lives on a separate
    kiosk endpoint and is rejected here — an internal actor cannot
    sign on the customer's behalf.

    The :class:`SpecificationTransition` insert and the sheet's
    ``status`` write share a single transaction — if either fails,
    neither lands, so the audit log cannot drift behind the sheet's
    headline status. Same-state transitions are a no-op (no row
    written) to keep the history clean of accidental re-clicks.
    """

    if next_status == sheet.status:
        return sheet
    allowed = ALLOWED_TRANSITIONS.get(sheet.status, frozenset())
    if next_status not in allowed:
        raise InvalidStatusTransition()
    if next_status == SpecificationStatus.ACCEPTED:
        # Block the internal path to ``accepted`` entirely — that
        # state is reserved for the kiosk sign-off flow.
        raise InvalidStatusTransition()

    previous_status = sheet.status
    slot = _INTERNAL_SIGNATURE_SLOT.get((previous_status, next_status))
    normalised_image: str | None = None
    if slot is not None:
        try:
            normalised_image = validate_signature_image(signature_image)
        except SignatureImageInvalid as exc:
            raise SignatureRequired() from exc

    sheet.status = next_status
    sheet.updated_by = actor
    update_fields = ["status", "updated_by", "updated_at"]
    now = timezone.now()

    if slot == "prepared_by":
        sheet.prepared_by_user = actor
        sheet.prepared_by_signed_at = now
        sheet.prepared_by_signature_image = normalised_image or ""
        update_fields += [
            "prepared_by_user",
            "prepared_by_signed_at",
            "prepared_by_signature_image",
        ]
    elif slot == "director":
        sheet.director_user = actor
        sheet.director_signed_at = now
        sheet.director_signature_image = normalised_image or ""
        update_fields += [
            "director_user",
            "director_signed_at",
            "director_signature_image",
        ]

    sheet.save(update_fields=update_fields)

    SpecificationTransition.objects.create(
        sheet=sheet,
        from_status=previous_status,
        to_status=next_status,
        actor=actor,
        notes=(notes or "").strip(),
    )
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.status_transition",
        target=sheet,
        before={"status": previous_status},
        after={"status": next_status, "notes": (notes or "").strip()},
    )
    return sheet


# ---------------------------------------------------------------------------
# Public preview link (F3.2) — token-gated read-only sharing
# ---------------------------------------------------------------------------


@transaction.atomic
def rotate_public_token(
    *, sheet: SpecificationSheet, actor: Any
) -> SpecificationSheet:
    """Issue a fresh opaque UUID as the sheet's public token.

    Calling this on a sheet that already had a token invalidates the
    previous one in the same write — useful when a client shares a
    link more widely than intended and the scientist wants to cut off
    access without deleting the sheet.

    Also revokes every :class:`apps.comments.models.KioskSession`
    that was issued against the old token so any still-open
    public-comment browser immediately gets bounced on its next
    request.
    """

    previous_token = sheet.public_token
    sheet.public_token = uuid.uuid4()
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
    if previous_token is not None:
        from apps.comments.kiosk import revoke_sessions_for_token

        revoke_sessions_for_token(previous_token)
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.rotate_public_token",
        target=sheet,
    )
    return sheet


@transaction.atomic
def revoke_public_token(
    *, sheet: SpecificationSheet, actor: Any
) -> SpecificationSheet:
    """Clear the sheet's public token so no one can hit the preview
    URL. Idempotent — calling on an already-revoked sheet is a no-op
    for the token but still bumps ``updated_by``/``updated_at``.

    Also revokes every kiosk session that was bound to that token.
    """

    had_token = sheet.public_token is not None
    previous_token = sheet.public_token
    sheet.public_token = None
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
    if had_token:
        from apps.comments.kiosk import revoke_sessions_for_token

        if previous_token is not None:
            revoke_sessions_for_token(previous_token)
        record_audit(
            organization=sheet.organization,
            actor=actor,
            action="spec_sheet.revoke_public_token",
            target=sheet,
        )
    return sheet


@transaction.atomic
def accept_as_customer(
    *,
    sheet: SpecificationSheet,
    signer_name: str,
    signer_email: str,
    signer_company: str,
    signature_image: str,
) -> SpecificationSheet:
    """Move a ``sent`` sheet to ``accepted`` with a customer signature.

    This is the kiosk path — the signer is not a platform user, so
    the API layer pulls identity off the active kiosk session
    (established when the visitor first opened the public link) and
    hands the name / email / company strings to this service. Those
    strings stamp onto the sheet alongside the drawn signature.

    Rejects:
    * Sheets whose status is not ``sent`` (any other state already
      landed somewhere the customer should not be able to push).
    * A missing / malformed signature image.
    * A blank signer name — we refuse to record an anonymous
      signature.
    """

    if sheet.status != SpecificationStatus.SENT:
        raise InvalidStatusTransition()

    normalised_image = validate_signature_image(signature_image)
    name = (signer_name or "").strip()
    if not name:
        raise SignatureRequired()

    previous_status = sheet.status
    sheet.status = SpecificationStatus.ACCEPTED
    sheet.customer_name = name
    sheet.customer_email = (signer_email or "").strip()
    sheet.customer_company = (signer_company or "").strip()
    sheet.customer_signature_image = normalised_image
    sheet.customer_signed_at = timezone.now()
    sheet.save(
        update_fields=[
            "status",
            "customer_name",
            "customer_email",
            "customer_company",
            "customer_signature_image",
            "customer_signed_at",
            "updated_at",
        ]
    )
    SpecificationTransition.objects.create(
        sheet=sheet,
        from_status=previous_status,
        to_status=SpecificationStatus.ACCEPTED,
        # Kiosk signers are not platform users; the audit row keeps
        # ``actor`` pointing at the sheet's last internal editor so
        # the foreign key stays satisfied, and the captured signer
        # identity lives on the sheet's ``customer_*`` columns.
        actor=sheet.updated_by,
        notes=f"Accepted by {name}".strip(),
    )
    record_audit(
        organization=sheet.organization,
        actor=sheet.updated_by,
        action="spec_sheet.customer_accept",
        target=sheet,
        before={"status": previous_status},
        after={
            "status": SpecificationStatus.ACCEPTED,
            "signer_name": name,
            "signer_email": sheet.customer_email,
            "signer_company": sheet.customer_company,
        },
    )
    return sheet


def get_by_public_token(token: Any) -> SpecificationSheet:
    """Look up a sheet by its public token.

    Raises :class:`PublicLinkNotEnabled` both when the token is
    malformed, when no sheet matches, and when a sheet exists but its
    token has since been revoked. A single error code keeps the public
    endpoint from leaking "this sheet exists but you can't see it".
    """

    try:
        token_uuid = uuid.UUID(str(token))
    except (ValueError, TypeError) as exc:
        raise PublicLinkNotEnabled() from exc

    sheet = (
        SpecificationSheet.objects.select_related(
            *_SHEET_RELATED,
            "organization",
        )
        .filter(public_token=token_uuid)
        .first()
    )
    if sheet is None:
        raise PublicLinkNotEnabled()
    return sheet


# ---------------------------------------------------------------------------
# Render context — the flat view-model the frontend renders
# ---------------------------------------------------------------------------


def _signature_payload(
    *, user, signed_at, image: str
) -> dict[str, Any] | None:
    """Shape an internal-role signature (prepared-by / director) for
    the render payload. ``None`` when no signature has landed yet so
    the UI can render the empty state instead of a name with no
    signed-at timestamp."""

    if user is None or signed_at is None:
        return None
    return {
        "user_id": str(user.id),
        "name": (user.get_full_name() or user.email or "").strip(),
        "email": user.email,
        "signed_at": signed_at.isoformat(),
        "image": image or "",
    }


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            return float(trimmed)
        except ValueError:
            return None
    return None


def _coerce_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _packaging_label(item: Item | None) -> str:
    """Render a packaging slot for the spec sheet.

    The slot shows the catalogue's internal code followed by the item
    name (e.g. ``MA203258 · Closure 38mm CT Metal Gold``) when one is
    picked, and falls back to the TBD placeholder when the slot is
    still empty. Keeping both the code and the name side by side lets
    procurement match the row against an SKU without opening the
    underlying catalogue.
    """

    if item is None:
        return PACKAGING_PLACEHOLDER
    code = (item.internal_code or "").strip()
    name = (item.name or "").strip()
    if code and name:
        return f"{code} · {name}"
    return name or code or PACKAGING_PLACEHOLDER


def _compute_filled_total_mg(
    *,
    dosage_form: str,
    size_key: Any,
    fill_weight_mg: Any,
) -> Decimal | None:
    """Return the **filled capsule / tablet weight** including the
    empty capsule shell for capsule products.

    Capsules: ``fill_weight + shell_weight`` where the shell weight is
    looked up from the snapshot's ``size_key``. Tablets, powders,
    gummies and liquids have no shell so the filled total equals the
    fill weight already reported by the formulation engine. Returns
    ``None`` when the fill weight itself is missing.
    """

    fill = _coerce_decimal(fill_weight_mg)
    if fill is None:
        return None
    if dosage_form == DosageForm.CAPSULE.value and isinstance(size_key, str):
        capsule = capsule_size_by_key(size_key)
        if capsule is not None:
            shell = Decimal(str(capsule.shell_weight_mg))
            return (fill + shell).quantize(Decimal("0.0001"))
    return fill


def _nrv_percent(
    claim_mg: Any, item_attributes: dict[str, Any] | None
) -> str | None:
    """Return the ``%NRV`` cell for one active row.

    Falls back to ``None`` when the raw material's ``nrv_mg`` is not a
    positive number — most botanicals and excipients have no
    regulatory NRV so the cell stays blank, matching the workbook's
    ``N/A`` convention.
    """

    nrv_mg = _coerce_float((item_attributes or {}).get("nrv_mg"))
    claim = _coerce_float(claim_mg)
    if not nrv_mg or nrv_mg <= 0 or claim is None or claim <= 0:
        return None
    return f"{(claim / nrv_mg) * 100:.1f}"


def resolve_limits(sheet: SpecificationSheet) -> list[dict[str, str]]:
    """Compute the Microbiological / PAH / Pesticides / Heavy Metal block.

    Precedence order (highest first):

    1. :attr:`SpecificationSheet.limits_override` — a per-sheet
       ``{slug: value}`` dict the scientist edited on this specific
       deliverable.
    2. :attr:`Organization.default_spec_limits` — the tenant-level
       defaults seeded on org creation and editable by an admin.
    3. :data:`DEFAULT_SAFETY_LIMITS` — canonical values from the
       Valley workbook, so a brand-new org with an empty dict still
       renders sane limits.

    Return order matches :data:`SAFETY_LIMIT_ROWS` so every spec
    sheet produced by the org lists the rows in the same top-down
    order the printed workbook uses.
    """

    organization = sheet.organization
    org_defaults = organization.default_spec_limits or {}
    overrides = sheet.limits_override or {}

    rows: list[dict[str, str]] = []
    for slug, label in SAFETY_LIMIT_ROWS:
        value = (
            overrides.get(slug)
            or org_defaults.get(slug)
            or DEFAULT_SAFETY_LIMITS.get(slug, "")
        )
        rows.append({"slug": slug, "name": label, "value": value})
    return rows


def resolve_visibility(sheet: SpecificationSheet) -> dict[str, bool]:
    """Return the fully-populated ``{section_slug: visible}`` map.

    Keys that the sheet's ``section_visibility`` JSON omits default
    to ``True`` so pre-feature sheets and freshly-created sheets both
    render in full — the only way to hide a section is to explicitly
    write ``False`` through the manage-visibility endpoint. The
    renderer consults this map; the frontend also receives it so the
    admin view can show a "hidden by you" badge next to each section.
    """

    stored = sheet.section_visibility or {}
    return {slug: bool(stored.get(slug, True)) for slug in SECTION_SLUGS}


def resolve_section_order(sheet: SpecificationSheet) -> list[str]:
    """Return the effective render order of section slugs.

    Honour ``sheet.section_order`` when present, dedupe against the
    canonical :data:`SECTION_SLUGS` tuple, and append any known
    sections the stored override forgot so a stale map cannot hide a
    newly-introduced section. Unknown slugs are silently dropped —
    the admin may have renamed a feature away.
    """

    stored = sheet.section_order or []
    seen: set[str] = set()
    ordered: list[str] = []
    for slug in stored:
        if not isinstance(slug, str):
            continue
        if slug not in SECTION_SLUGS or slug in seen:
            continue
        ordered.append(slug)
        seen.add(slug)
    for slug in SECTION_SLUGS:
        if slug in seen:
            continue
        ordered.append(slug)
    return ordered


def show_watermark_for(status: str) -> bool:
    """Decide whether the sheet should render its diagonal ``DRAFT``
    watermark. The rule: anything that is not yet customer-locked
    still looks like a working document. Final states
    (``approved``, ``sent``, ``accepted``) print clean."""

    final_states = {
        SpecificationStatus.APPROVED,
        SpecificationStatus.SENT,
        SpecificationStatus.ACCEPTED,
    }
    return status not in final_states


def render_context(sheet: SpecificationSheet) -> dict[str, Any]:
    """Turn a sheet + its snapshot into the flat dict the frontend
    renders. Pure function — no DB writes, no side effects."""

    version = sheet.formulation_version
    metadata = version.snapshot_metadata or {}
    totals = version.snapshot_totals or {}
    snapshot_lines = version.snapshot_lines or []

    actives = []
    for line in snapshot_lines:
        attrs = line.get("item_attributes") or {}
        raw_mg = _coerce_decimal(line.get("mg_per_serving"))
        actives.append(
            {
                "item_name": line.get("item_name", ""),
                "item_internal_code": line.get("item_internal_code", ""),
                "ingredient_list_name": instantiate_active_label(
                    nutrition_information_name=attrs.get(
                        "nutrition_information_name"
                    ),
                    ingredient_list_name=attrs.get("ingredient_list_name"),
                    item_name=line.get("item_name", ""),
                    raw_mg=raw_mg,
                ),
                "label_claim_mg": str(line.get("label_claim_mg") or ""),
                "mg_per_serving": str(line.get("mg_per_serving") or ""),
                "nrv_percent": _nrv_percent(
                    line.get("label_claim_mg"), attrs
                ),
            }
        )

    compliance = totals.get("compliance") or {"flags": []}
    declaration = totals.get("declaration") or {"text": "", "entries": []}
    allergens = totals.get("allergens") or {"sources": [], "allergen_count": 0}
    nutrition = totals.get("nutrition") or {"rows": []}
    amino_acids = totals.get("amino_acids") or {"groups": []}

    # Filled total weight = powder fill + capsule shell (if any). For
    # tablets the filled weight is just the fill weight (no shell), and
    # for powder/gummy/liquid the snapshot's total_weight_mg already
    # equals the total active — we pass it through unchanged.
    filled_total_mg = _compute_filled_total_mg(
        dosage_form=metadata.get("dosage_form", ""),
        size_key=totals.get("size_key"),
        fill_weight_mg=totals.get("total_weight_mg"),
    )

    # Transition history — newest first. Serialized inline rather
    # than behind a separate endpoint so the browser view and the PDF
    # render from the same payload without a second round-trip.
    history = [
        {
            "id": str(t.id),
            "from_status": t.from_status,
            "to_status": t.to_status,
            "actor_id": str(t.actor_id),
            "actor_name": (t.actor.get_full_name() or t.actor.email).strip(),
            "actor_email": t.actor.email,
            "notes": t.notes,
            "created_at": t.created_at.isoformat(),
        }
        for t in sheet.transitions.select_related("actor").all()
    ]

    return {
        "sheet": {
            "id": str(sheet.id),
            "code": sheet.code,
            "client_name": sheet.client_name,
            "client_email": sheet.client_email,
            "client_company": sheet.client_company,
            "margin_percent": (
                str(sheet.margin_percent) if sheet.margin_percent is not None else None
            ),
            "final_price": (
                str(sheet.final_price) if sheet.final_price is not None else None
            ),
            "cover_notes": sheet.cover_notes,
            "total_weight_label": sheet.total_weight_label,
            "unit_quantity": sheet.unit_quantity,
            "food_contact_status": sheet.food_contact_status,
            "shelf_life": sheet.shelf_life,
            "storage_conditions": sheet.storage_conditions,
            "status": sheet.status,
            "created_at": sheet.created_at.isoformat(),
            "updated_at": sheet.updated_at.isoformat(),
        },
        "signatures": {
            "prepared_by": _signature_payload(
                user=sheet.prepared_by_user,
                signed_at=sheet.prepared_by_signed_at,
                image=sheet.prepared_by_signature_image,
            ),
            "director": _signature_payload(
                user=sheet.director_user,
                signed_at=sheet.director_signed_at,
                image=sheet.director_signature_image,
            ),
            "customer": {
                "name": sheet.customer_name,
                "email": sheet.customer_email,
                "company": sheet.customer_company,
                "signed_at": (
                    sheet.customer_signed_at.isoformat()
                    if sheet.customer_signed_at is not None
                    else None
                ),
                "image": sheet.customer_signature_image,
            },
        },
        "formulation": {
            "id": str(version.formulation_id),
            "version_number": version.version_number,
            "version_label": version.label,
            "code": metadata.get("code", ""),
            "name": metadata.get("name", ""),
            "description": metadata.get("description", ""),
            "dosage_form": metadata.get("dosage_form", ""),
            "capsule_size": metadata.get("capsule_size", ""),
            "tablet_size": metadata.get("tablet_size", ""),
            "serving_size": metadata.get("serving_size", 1),
            "servings_per_pack": metadata.get("servings_per_pack", 0),
            "directions_of_use": metadata.get("directions_of_use", ""),
            "suggested_dosage": metadata.get("suggested_dosage", ""),
            "appearance": metadata.get("appearance", ""),
            "disintegration_spec": metadata.get("disintegration_spec", ""),
        },
        "totals": {
            "total_active_mg": totals.get("total_active_mg"),
            "total_weight_mg": totals.get("total_weight_mg"),
            "filled_total_mg": (
                str(filled_total_mg) if filled_total_mg is not None else None
            ),
            "max_weight_mg": totals.get("max_weight_mg"),
            "size_label": totals.get("size_label"),
            "excipients": totals.get("excipients"),
            "viability": totals.get("viability"),
        },
        "actives": actives,
        "compliance": compliance,
        "declaration": declaration,
        "allergens": allergens,
        "nutrition": nutrition,
        "amino_acids": amino_acids,
        "history": history,
        "packaging": {
            "lid_description": _packaging_label(sheet.packaging_lid),
            "bottle_pouch_tub": _packaging_label(sheet.packaging_container),
            "label_size": _packaging_label(sheet.packaging_label),
            "antitemper": _packaging_label(sheet.packaging_antitemper),
            # Unit Quantity is a sheet-level override (e.g. "28
            # sachets") that falls back to the formulation's
            # ``servings_per_pack`` snapshot when left blank. Keeps
            # the workbook's semantics where the spec sheet cell is
            # editable but usually mirrors the project setup.
            "unit_quantity": (
                sheet.unit_quantity or metadata.get("servings_per_pack") or ""
            ),
            "food_contact_status": sheet.food_contact_status,
            "shelf_life": sheet.shelf_life,
            "storage_conditions": sheet.storage_conditions,
        },
        "limits": resolve_limits(sheet),
        "weight_uniformity": (
            sheet.weight_uniformity or DEFAULT_WEIGHT_UNIFORMITY_PCT
        ),
        "visibility": resolve_visibility(sheet),
        "section_order": resolve_section_order(sheet),
        "watermark": show_watermark_for(sheet.status),
    }


# ---------------------------------------------------------------------------
# PDF rendering (F3.1) — WeasyPrint + Django template
# ---------------------------------------------------------------------------


#: Display labels for the nutrition rows, indexed by the catalogue key.
#: Mirrors the ``nutrition_rows.*`` translations the React view uses so
#: the PDF reads identically to the browser sheet.
_NUTRITION_ROW_LABELS: dict[str, str] = {
    "energy_kj": "Energy kJ",
    "energy_kcal": "Energy kcal",
    "fat": "Fat",
    "fat_saturated": "of which saturates",
    "carbohydrate": "Carbohydrate",
    "sugar": "of which sugar",
    "fibre": "Fibre",
    "protein": "Protein",
    "salt": "Salt",
}

#: The nine-row subset the browser view renders. Excludes the
#: ``fat_monounsaturated`` / ``fat_polyunsaturated`` aggregates which
#: are captured on the raw material but not surfaced on the client
#: sheet (they live in the snapshot for completeness, not display).
_NUTRITION_ROW_ORDER: tuple[str, ...] = (
    "energy_kj",
    "energy_kcal",
    "fat",
    "fat_saturated",
    "carbohydrate",
    "sugar",
    "fibre",
    "protein",
    "salt",
)

_AMINO_GROUP_LABELS: dict[str, str] = {
    "essential": "Essential Amino Acids",
    "conditionally_essential": "Conditionally Essential Amino Acids",
    "non_essential": "Non-Essential Amino Acids",
}

_AMINO_ACID_LABELS: dict[str, str] = {
    "isoleucine": "Isoleucine",
    "leucine": "Leucine",
    "lysine": "Lysine",
    "methionine": "Methionine",
    "phenylalanine": "Phenylalanine",
    "threonine": "Threonine",
    "tryptophan": "Tryptophan",
    "valine": "Valine",
    "arginine": "Arginine",
    "cystine": "Cystine",
    "glutamic_acid": "Glutamic acid",
    "histidine": "Histidine",
    "proline": "Proline",
    "tyrosine": "Tyrosine",
    "alanine": "Alanine",
    "asparatic_acid": "Aspartic acid",
    "glycine": "Glycine",
    "serine": "Serine",
}


def _resolve_total_weight_display(context: dict[str, Any]) -> str:
    """Mirror the React view's Total Weight (mg) resolution: explicit
    override wins → computed filled weight → ``TBC``."""

    override = (context["sheet"].get("total_weight_label") or "").strip()
    if override:
        return override
    filled = context["totals"].get("filled_total_mg")
    if filled:
        try:
            return f"{Decimal(str(filled)):.2f} mg"
        except (InvalidOperation, ValueError, TypeError):
            pass
    return "TBC"


def _prepare_template_context(
    context: dict[str, Any],
    sheet: SpecificationSheet | None = None,
) -> dict[str, Any]:
    """Shape the flat ``render_context`` payload into the extra
    fields the PDF template relies on (labelled nutrition rows,
    ordered amino groups, the resolved Total Weight cell,
    organization-level header + footer metadata)."""

    # Nutrition rows — map backend keys to display labels, preserving
    # the view order. Missing rows render as zero via the template
    # filter, matching the React view's behaviour.
    rows_by_key = {row["key"]: row for row in context["nutrition"].get("rows", [])}
    nutrition_rows = [
        {
            "key": key,
            "label": _NUTRITION_ROW_LABELS[key],
            "per_serving": rows_by_key.get(key, {}).get("per_serving"),
            "per_100g": rows_by_key.get(key, {}).get("per_100g"),
            "contributors": rows_by_key.get(key, {}).get("contributors", 0),
        }
        for key in _NUTRITION_ROW_ORDER
    ]

    amino_groups = []
    for group in context["amino_acids"].get("groups", []):
        amino_groups.append(
            {
                "key": group["key"],
                "label": _AMINO_GROUP_LABELS.get(group["key"], group["key"]),
                "acids": [
                    {
                        "key": acid["key"],
                        "label": _AMINO_ACID_LABELS.get(
                            acid["key"], acid["key"].replace("_", " ").title()
                        ),
                        "per_serving": acid.get("per_serving"),
                        "per_100g": acid.get("per_100g"),
                        "contributors": acid.get("contributors", 0),
                    }
                    for acid in group.get("acids", [])
                ],
            }
        )

    nutrition_has_data = any(
        row.get("contributors", 0) > 0 for row in context["nutrition"].get("rows", [])
    ) or any(
        acid.get("contributors", 0) > 0
        for group in context["amino_acids"].get("groups", [])
        for acid in group.get("acids", [])
    )
    contributor_count = max(
        (row.get("contributors", 0) for row in context["nutrition"].get("rows", [])),
        default=0,
    )

    # Header / footer metadata. The printable sheet carries the doc
    # code top-left, the update date top-right, and the organization
    # name + generic address across the bottom. Address line is left
    # as a single string so whoever curates the template can drop in
    # a real registered address without model work — the user will
    # supply this later; today the tenant name suffices to anchor the
    # footer and avoid looking unbranded.
    organization_name = sheet.organization.name if sheet is not None else ""
    report_date = _format_report_date(context.get("sheet", {}).get("updated_at"))

    return {
        **context,
        "nutrition_rows": nutrition_rows,
        "amino_groups": amino_groups,
        "nutrition_has_data": nutrition_has_data,
        "nutrition_contributor_count": contributor_count,
        "total_weight_display": _resolve_total_weight_display(context),
        "organization_name": organization_name,
        "organization_address": "",
        "report_date": report_date,
    }


def _format_report_date(iso: Any) -> str:
    """Render the top-right date as ``DD/MM/YYYY`` — the format the
    reference spec sheet uses. Accepts the ISO string the sheet's
    ``updated_at`` carries; invalid input yields the empty string so
    the header gracefully shows nothing rather than an error token.
    """

    if not isinstance(iso, str) or not iso:
        return ""
    try:
        # ``datetime.fromisoformat`` in 3.11+ parses the trailing ``+00:00``
        # that Django emits without needing a dedicated tz-aware parser.
        from datetime import datetime

        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    return parsed.strftime("%d/%m/%Y")


def render_pdf(sheet: SpecificationSheet) -> tuple[bytes, str]:
    """Render the spec sheet to a PDF byte string.

    Returns ``(pdf_bytes, suggested_filename)``. The filename mirrors
    the workbook's "``<sheet-code>`` v\\ ``<version>``" convention so a
    scientist filing the PDF on disk can trace it back to the sheet +
    version without opening it.
    """

    # Lazy import so missing system libraries do not break test
    # collection for unrelated apps — WeasyPrint imports cairo/pango
    # shared libraries at module load.
    from weasyprint import HTML  # noqa: WPS433

    context = render_context(sheet)
    template_context = _prepare_template_context(context, sheet=sheet)
    html_string = render_to_string(
        "specifications/sheet.html", template_context
    )
    pdf_bytes = HTML(string=html_string).write_pdf()

    code = (sheet.code or str(sheet.id)[:8]).strip().replace(" ", "-")
    version_number = sheet.formulation_version.version_number
    filename = f"{code}-v{version_number}.pdf"
    return pdf_bytes, filename
