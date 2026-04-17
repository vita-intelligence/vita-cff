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

from apps.formulations.constants import DosageForm, capsule_size_by_key
from apps.formulations.models import FormulationVersion
from apps.formulations.services import instantiate_active_label
from apps.organizations.models import Organization
from apps.specifications.constants import (
    DEFAULT_SAFETY_LIMITS,
    DEFAULT_WEIGHT_UNIFORMITY_PCT,
    PACKAGING_PLACEHOLDER,
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


class InvalidStatusTransition(Exception):
    code = "invalid_status_transition"


class PublicLinkNotEnabled(Exception):
    """The sheet the caller looked up by token has had its public link
    revoked or never had one issued. Surfaces as 404 — we deliberately
    do not distinguish between "never shared" and "link revoked" so a
    stale link leaks no information about what the sheet became."""

    code = "public_link_not_enabled"


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


def list_sheets(*, organization: Organization) -> QuerySet[SpecificationSheet]:
    return (
        SpecificationSheet.objects.filter(organization=organization)
        .select_related("formulation_version__formulation")
        .order_by("-updated_at")
    )


def get_sheet(
    *, organization: Organization, sheet_id: Any
) -> SpecificationSheet:
    sheet = (
        SpecificationSheet.objects.select_related(
            "formulation_version__formulation"
        )
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

    return SpecificationSheet.objects.create(
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

    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(sheet, key, value)

    sheet.updated_by = actor
    sheet.save()
    return sheet


@transaction.atomic
def transition_status(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    next_status: str,
    notes: str = "",
) -> SpecificationSheet:
    """Move the sheet one state forward and stamp an audit row.

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

    previous_status = sheet.status
    sheet.status = next_status
    sheet.updated_by = actor
    sheet.save(update_fields=["status", "updated_by", "updated_at"])

    SpecificationTransition.objects.create(
        sheet=sheet,
        from_status=previous_status,
        to_status=next_status,
        actor=actor,
        notes=(notes or "").strip(),
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
    """

    sheet.public_token = uuid.uuid4()
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
    return sheet


@transaction.atomic
def revoke_public_token(
    *, sheet: SpecificationSheet, actor: Any
) -> SpecificationSheet:
    """Clear the sheet's public token so no one can hit the preview
    URL. Idempotent — calling on an already-revoked sheet is a no-op
    for the token but still bumps ``updated_by``/``updated_at``."""

    sheet.public_token = None
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
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
            "formulation_version__formulation",
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
            "status": sheet.status,
            "created_at": sheet.created_at.isoformat(),
            "updated_at": sheet.updated_at.isoformat(),
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
        "nutrition": nutrition,
        "amino_acids": amino_acids,
        "history": history,
        "packaging": {
            "lid_description": PACKAGING_PLACEHOLDER,
            "bottle_pouch_tub": PACKAGING_PLACEHOLDER,
            "label_size": PACKAGING_PLACEHOLDER,
            "antitemper": PACKAGING_PLACEHOLDER,
            "unit_quantity": metadata.get("servings_per_pack"),
        },
        "limits": [
            {"name": name, "value": value}
            for name, value in DEFAULT_SAFETY_LIMITS
        ],
        "weight_uniformity": DEFAULT_WEIGHT_UNIFORMITY_PCT,
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


def _prepare_template_context(context: dict[str, Any]) -> dict[str, Any]:
    """Shape the flat ``render_context`` payload into the extra
    fields the PDF template relies on (labelled nutrition rows,
    ordered amino groups, the resolved Total Weight cell)."""

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

    return {
        **context,
        "nutrition_rows": nutrition_rows,
        "amino_groups": amino_groups,
        "nutrition_has_data": nutrition_has_data,
        "nutrition_contributor_count": contributor_count,
        "total_weight_display": _resolve_total_weight_display(context),
    }


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
    template_context = _prepare_template_context(context)
    html_string = render_to_string(
        "specifications/sheet.html", template_context
    )
    pdf_bytes = HTML(string=html_string).write_pdf()

    code = (sheet.code or str(sheet.id)[:8]).strip().replace(" ", "-")
    version_number = sheet.formulation_version.version_number
    filename = f"{code}-v{version_number}.pdf"
    return pdf_bytes, filename
