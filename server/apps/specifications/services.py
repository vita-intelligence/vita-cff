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

from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet

from apps.formulations.constants import DosageForm, capsule_size_by_key
from apps.formulations.models import FormulationVersion
from apps.formulations.services import instantiate_active_label
from apps.organizations.models import Organization
from apps.specifications.constants import (
    DEFAULT_SAFETY_LIMITS,
    DEFAULT_WEIGHT_UNIFORMITY_PCT,
    PACKAGING_PLACEHOLDER,
)
from apps.specifications.models import SpecificationSheet, SpecificationStatus


class SpecificationNotFound(Exception):
    code = "specification_not_found"


class SpecificationCodeConflict(Exception):
    code = "specification_code_conflict"


class FormulationVersionNotInOrg(Exception):
    code = "formulation_version_not_in_org"


class InvalidStatusTransition(Exception):
    code = "invalid_status_transition"


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
) -> SpecificationSheet:
    if next_status == sheet.status:
        return sheet
    allowed = ALLOWED_TRANSITIONS.get(sheet.status, frozenset())
    if next_status not in allowed:
        raise InvalidStatusTransition()
    sheet.status = next_status
    sheet.updated_by = actor
    sheet.save(update_fields=["status", "updated_by", "updated_at"])
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
