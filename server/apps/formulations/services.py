"""Service layer for the formulations app.

The *pure* functions :func:`compute_line` and :func:`compute_totals`
mirror the Valley Low Fat Burner workbook's formulas line-for-line:

* ``compute_line`` is the Table3 ``mg/serving`` cascade:
  botanical → ``label_claim / extract_ratio``; everything else →
  ``label_claim / purity`` optionally scaled by overage.
* ``compute_totals`` is the ``Capsule Total Weight`` / ``Tablet Total
  Weight`` block plus the three traffic-light checks.

Every other function in this module is orchestration: CRUD on the
formulation workspace, version snapshotting, rollback.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Max, QuerySet

from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.formulations.constants import (
    CAPSULE_MG_STEARATE_PCT,
    CAPSULE_SILICA_PCT,
    CAPSULE_SIZES,
    DosageForm,
    TABLET_DCP_PCT,
    TABLET_MCC_PCT,
    TABLET_MG_STEARATE_PCT,
    TABLET_SILICA_PCT,
    TABLET_SIZES,
    auto_pick_capsule_size,
    capsule_size_by_key,
    tablet_size_by_key,
)
from apps.formulations.models import (
    Formulation,
    FormulationLine,
    FormulationVersion,
)
from apps.organizations.models import Organization


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FormulationNotFound(Exception):
    code = "formulation_not_found"


class FormulationCodeConflict(Exception):
    code = "formulation_code_conflict"


class FormulationVersionNotFound(Exception):
    code = "formulation_version_not_found"


class InvalidDosageForm(Exception):
    code = "invalid_dosage_form"


class InvalidCapsuleSize(Exception):
    code = "invalid_capsule_size"


class InvalidTabletSize(Exception):
    code = "invalid_tablet_size"


class RawMaterialNotInOrg(Exception):
    """Raised when a formulation line targets an item outside the
    organization's ``raw_materials`` catalogue."""

    code = "raw_material_not_in_org"


# ---------------------------------------------------------------------------
# Line math — ``Table3[mg/serving]`` in Excel
# ---------------------------------------------------------------------------


def _coerce_float(value: Any) -> float | None:
    """Parse an attribute value into a float, returning ``None`` when
    the value is missing, blank, or not a number.

    Necessary because the raw materials catalogue stores numeric
    columns (``purity``, ``nrv_mg``) as text — some source rows are
    ``N/A`` and the import auto-sniffed the column as text.
    """

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
            return float(Decimal(trimmed))
        except (InvalidOperation, ValueError):
            return None
    return None


def _is_botanical(item: Item) -> bool:
    raw = (item.attributes or {}).get("type")
    if not isinstance(raw, str):
        return False
    return raw.strip().lower() == "botanical"


def compute_line(
    *,
    item: Item,
    label_claim_mg: Decimal | float,
    serving_size: int = 1,
) -> Decimal | None:
    """Compute the raw-powder mg/serving for a single ingredient line.

    Returns ``None`` when the line cannot be computed — specifically:

    * ``label_claim_mg`` is zero or negative (caller should surface a
      validation error rather than hide it as ``None``), OR
    * the item is tagged non-botanical but has no parseable ``purity``,
      OR
    * the item is tagged botanical but has no parseable ``extract_ratio``.

    ``serving_size`` divides the label claim before the purity /
    extract-ratio scaling, matching the workbook's ``label_claim /
    serving_size`` intermediate column.
    """

    claim = float(label_claim_mg)
    if claim <= 0:
        return None
    if serving_size <= 0:
        return None

    per_unit_claim = claim / serving_size
    attributes = item.attributes or {}

    if _is_botanical(item):
        extract_ratio = _coerce_float(attributes.get("extract_ratio"))
        if extract_ratio is None or extract_ratio <= 0:
            return None
        raw_mg = per_unit_claim / extract_ratio
    else:
        purity = _coerce_float(attributes.get("purity"))
        if purity is None or purity <= 0:
            return None
        raw_mg = per_unit_claim / purity
        overage = _coerce_float(attributes.get("overage"))
        if overage is not None and overage > 0:
            raw_mg = raw_mg + (raw_mg * overage)

    # Quantise to the same 4-decimal precision as the DB column, which
    # matches the workbook's displayed precision for mg/serving values.
    return Decimal(str(raw_mg)).quantize(Decimal("0.0001"))


# ---------------------------------------------------------------------------
# Totals + viability — ``Capsule Total Weight`` / ``Tablet Total Weight``
# ---------------------------------------------------------------------------


@dataclass
class ExcipientBreakdown:
    mg_stearate_mg: Decimal
    silica_mg: Decimal
    mcc_mg: Decimal
    dcp_mg: Decimal | None = None  # tablet-only


@dataclass
class ViabilityResult:
    #: ``CAN MAKE`` when the target form's max weight covers the total;
    #: ``CANNOT MAKE`` when it doesn't.
    fits: bool
    #: ``LESS CHALLENGING`` when the excipient headroom is comfortable.
    #: Capsule rule: MCC remaining ≥ 1% of total active. Tablet rule:
    #: total weight ≤ 75% of the selected tablet's max fill weight.
    comfort_ok: bool
    #: Machine-readable codes the UI translates to locale copy.
    codes: tuple[str, ...]


@dataclass
class FormulationTotals:
    total_active_mg: Decimal
    dosage_form: str
    #: Selected size key (auto-picked when the scientist left it blank).
    size_key: str | None
    size_label: str | None
    max_weight_mg: Decimal | None
    total_weight_mg: Decimal | None
    excipients: ExcipientBreakdown | None
    viability: ViabilityResult
    #: Per-line computed mg/serving values, keyed by the caller's own
    #: stable identifier so the UI can reconcile them to the source row
    #: without relying on ordering.
    line_values: dict[str, Decimal] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


def _quantise(value: float) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.0001"))


def _empty_viability() -> ViabilityResult:
    return ViabilityResult(
        fits=False, comfort_ok=False, codes=("more_info_required",)
    )


def _compute_capsule(
    total_active: Decimal,
    requested_size_key: str | None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    warnings: list[str] = []

    if requested_size_key:
        size = capsule_size_by_key(requested_size_key)
        if size is None:
            raise InvalidCapsuleSize()
    else:
        size = auto_pick_capsule_size(float(total_active))
        if size is None:
            warnings.append("capsule_too_large")

    if size is None:
        # Cannot make — total active exceeds every auto-pickable size.
        return (
            None,
            None,
            None,
            None,
            None,
            ViabilityResult(
                fits=False,
                comfort_ok=False,
                codes=("cannot_make",),
            ),
            tuple(warnings),
        )

    stearate = float(total_active) * CAPSULE_MG_STEARATE_PCT
    silica = float(total_active) * CAPSULE_SILICA_PCT
    mcc = size.max_weight_mg - float(total_active) - stearate - silica
    # Total weight is defined as sum(active, excipients). When MCC is
    # positive this equals max_weight by construction. When MCC would
    # go negative (active + excipients overshoot max) the totals block
    # still reports the true sum so viability can flag "CANNOT MAKE".
    total_weight = float(total_active) + stearate + silica + max(mcc, 0.0)
    if mcc < 0:
        total_weight = float(total_active) + stearate + silica

    fits = size.max_weight_mg >= total_weight
    comfort_ok = fits and mcc >= (float(total_active) * 0.01)
    codes: list[str] = []
    if not fits:
        codes.append("cannot_make")
    else:
        codes.append("can_make")
        if comfort_ok:
            codes.extend(("less_challenging", "proceed_to_quote"))
        else:
            codes.extend(("more_challenging_to_make", "consult_r_and_d"))

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
    )

    return (
        size.key,
        size.label,
        _quantise(size.max_weight_mg),
        _quantise(total_weight),
        excipients,
        ViabilityResult(fits=fits, comfort_ok=comfort_ok, codes=tuple(codes)),
        tuple(warnings),
    )


def _compute_tablet(
    total_active: Decimal,
    requested_size_key: str | None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    active = float(total_active)
    stearate = active * TABLET_MG_STEARATE_PCT
    silica = active * TABLET_SILICA_PCT
    dcp = active * TABLET_DCP_PCT
    mcc = active * TABLET_MCC_PCT
    total_weight = active + stearate + silica + dcp + mcc

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
        dcp_mg=_quantise(dcp),
    )

    if not requested_size_key:
        # No tablet size chosen → we can still report the weight block
        # but viability is unknown. Caller surfaces as "select a size".
        return (
            None,
            None,
            None,
            _quantise(total_weight),
            excipients,
            ViabilityResult(
                fits=False, comfort_ok=False, codes=("tablet_size_required",)
            ),
            (),
        )

    size = tablet_size_by_key(requested_size_key)
    if size is None:
        raise InvalidTabletSize()

    fits = size.max_weight_mg >= total_weight
    comfort_ok = fits and total_weight <= (size.max_weight_mg * 0.75)
    codes: list[str] = []
    if not fits:
        codes.append("cannot_make")
    else:
        codes.append("can_make")
        if comfort_ok:
            codes.extend(("less_challenging", "proceed_to_quote"))
        else:
            codes.extend(("more_challenging_to_make", "consult_r_and_d"))

    return (
        size.key,
        size.label,
        _quantise(size.max_weight_mg),
        _quantise(total_weight),
        excipients,
        ViabilityResult(fits=fits, comfort_ok=comfort_ok, codes=tuple(codes)),
        (),
    )


def compute_totals(
    *,
    lines: Iterable[tuple[str, Item, Decimal | float, int | None]],
    dosage_form: str,
    capsule_size_key: str | None = None,
    tablet_size_key: str | None = None,
    default_serving_size: int = 1,
) -> FormulationTotals:
    """Compute the full totals block for a formulation.

    ``lines`` is an iterable of ``(external_id, item, label_claim_mg,
    serving_size_override)`` tuples. ``external_id`` is opaque to this
    function and just flows through to ``FormulationTotals.line_values``
    so callers can key the computed mg values back to their own rows.
    """

    total_active = Decimal("0")
    line_values: dict[str, Decimal] = {}

    for external_id, item, label_claim, override in lines:
        mg = compute_line(
            item=item,
            label_claim_mg=label_claim,
            serving_size=override if override is not None else default_serving_size,
        )
        if mg is not None:
            line_values[external_id] = mg
            total_active += mg

    total_active = total_active.quantize(Decimal("0.0001"))

    if total_active <= 0:
        return FormulationTotals(
            total_active_mg=total_active,
            dosage_form=dosage_form,
            size_key=None,
            size_label=None,
            max_weight_mg=None,
            total_weight_mg=None,
            excipients=None,
            viability=_empty_viability(),
            line_values=line_values,
        )

    if dosage_form == DosageForm.CAPSULE.value:
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_capsule(total_active, capsule_size_key or None)
    elif dosage_form == DosageForm.TABLET.value:
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_tablet(total_active, tablet_size_key or None)
    else:
        # Non-math dosage forms (powder, gummy, liquid, other_solid)
        # still report the total but skip the excipient block.
        return FormulationTotals(
            total_active_mg=total_active,
            dosage_form=dosage_form,
            size_key=None,
            size_label=None,
            max_weight_mg=None,
            total_weight_mg=total_active,
            excipients=None,
            viability=ViabilityResult(
                fits=True,
                comfort_ok=True,
                codes=("manual_review_required",),
            ),
            line_values=line_values,
        )

    return FormulationTotals(
        total_active_mg=total_active,
        dosage_form=dosage_form,
        size_key=size_key,
        size_label=size_label,
        max_weight_mg=max_weight,
        total_weight_mg=total_weight,
        excipients=excipients,
        viability=viability,
        line_values=line_values,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Formulation CRUD
# ---------------------------------------------------------------------------


def list_formulations(
    *, organization: Organization
) -> QuerySet[Formulation]:
    return (
        Formulation.objects.filter(organization=organization)
        .order_by("-updated_at")
    )


def get_formulation(
    *, organization: Organization, formulation_id: Any
) -> Formulation:
    obj = Formulation.objects.filter(
        organization=organization, id=formulation_id
    ).first()
    if obj is None:
        raise FormulationNotFound()
    return obj


@transaction.atomic
def create_formulation(
    *,
    organization: Organization,
    actor: Any,
    name: str,
    code: str = "",
    description: str = "",
    dosage_form: str = DosageForm.CAPSULE.value,
    capsule_size: str = "",
    tablet_size: str = "",
    serving_size: int = 1,
    servings_per_pack: int = 60,
    directions_of_use: str = "",
    suggested_dosage: str = "",
    appearance: str = "",
    disintegration_spec: str = "",
) -> Formulation:
    _validate_dosage_form(dosage_form)
    if code:
        duplicate = Formulation.objects.filter(
            organization=organization, code=code
        ).exists()
        if duplicate:
            raise FormulationCodeConflict()

    if capsule_size and capsule_size_by_key(capsule_size) is None:
        raise InvalidCapsuleSize()
    if tablet_size and tablet_size_by_key(tablet_size) is None:
        raise InvalidTabletSize()

    return Formulation.objects.create(
        organization=organization,
        name=name,
        code=code,
        description=description,
        dosage_form=dosage_form,
        capsule_size=capsule_size,
        tablet_size=tablet_size,
        serving_size=serving_size,
        servings_per_pack=servings_per_pack,
        directions_of_use=directions_of_use,
        suggested_dosage=suggested_dosage,
        appearance=appearance,
        disintegration_spec=disintegration_spec,
        created_by=actor,
        updated_by=actor,
    )


@transaction.atomic
def update_formulation(
    *,
    formulation: Formulation,
    actor: Any,
    **changes: Any,
) -> Formulation:
    mutable = {
        "name",
        "code",
        "description",
        "dosage_form",
        "capsule_size",
        "tablet_size",
        "serving_size",
        "servings_per_pack",
        "directions_of_use",
        "suggested_dosage",
        "appearance",
        "disintegration_spec",
        "status",
    }
    if "dosage_form" in changes and changes["dosage_form"] is not None:
        _validate_dosage_form(changes["dosage_form"])
    if changes.get("capsule_size"):
        if capsule_size_by_key(changes["capsule_size"]) is None:
            raise InvalidCapsuleSize()
    if changes.get("tablet_size"):
        if tablet_size_by_key(changes["tablet_size"]) is None:
            raise InvalidTabletSize()
    if "code" in changes and changes["code"] and changes["code"] != formulation.code:
        duplicate = (
            Formulation.objects.filter(
                organization=formulation.organization, code=changes["code"]
            )
            .exclude(pk=formulation.pk)
            .exists()
        )
        if duplicate:
            raise FormulationCodeConflict()

    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(formulation, key, value)

    formulation.updated_by = actor
    formulation.save()
    return formulation


def _validate_dosage_form(value: str) -> None:
    valid = {form.value for form in DosageForm}
    if value not in valid:
        raise InvalidDosageForm()


# ---------------------------------------------------------------------------
# Line CRUD
# ---------------------------------------------------------------------------


@transaction.atomic
def replace_lines(
    *,
    formulation: Formulation,
    actor: Any,
    lines: list[dict[str, Any]],
) -> list[FormulationLine]:
    """Atomically replace the formulation's ingredient lines.

    ``lines`` is a list of dicts with keys ``item_id``,
    ``label_claim_mg``, optional ``serving_size_override``, optional
    ``display_order``, optional ``notes``. Raises
    :class:`RawMaterialNotInOrg` if any item is outside the
    organization's ``raw_materials`` catalogue — the formulation
    engine never crosses catalogue scopes.
    """

    catalogue = Catalogue.objects.filter(
        organization=formulation.organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        # Every org seeds raw_materials on creation; hitting this is a
        # system error, not a validation error.
        raise RawMaterialNotInOrg()

    item_ids = [line["item_id"] for line in lines]
    items_by_id = {
        str(i.id): i
        for i in Item.objects.filter(catalogue=catalogue, id__in=item_ids)
    }
    for line in lines:
        if str(line["item_id"]) not in items_by_id:
            raise RawMaterialNotInOrg()

    FormulationLine.objects.filter(formulation=formulation).delete()

    created: list[FormulationLine] = []
    for index, data in enumerate(lines):
        item = items_by_id[str(data["item_id"])]
        claim = Decimal(str(data["label_claim_mg"]))
        override = data.get("serving_size_override")
        mg = compute_line(
            item=item,
            label_claim_mg=claim,
            serving_size=override if override is not None else formulation.serving_size,
        )
        created.append(
            FormulationLine.objects.create(
                formulation=formulation,
                item=item,
                display_order=data.get("display_order", index),
                label_claim_mg=claim,
                serving_size_override=override,
                mg_per_serving_cached=mg,
                notes=data.get("notes", ""),
            )
        )

    formulation.updated_by = actor
    formulation.save(update_fields=["updated_by", "updated_at"])
    return created


def compute_formulation_totals(
    *, formulation: Formulation
) -> FormulationTotals:
    """Compute totals for the formulation's current working state."""

    tuples = [
        (
            str(line.id),
            line.item,
            line.label_claim_mg,
            line.serving_size_override,
        )
        for line in formulation.lines.select_related("item").all()
    ]
    return compute_totals(
        lines=tuples,
        dosage_form=formulation.dosage_form,
        capsule_size_key=formulation.capsule_size or None,
        tablet_size_key=formulation.tablet_size or None,
        default_serving_size=formulation.serving_size,
    )


# ---------------------------------------------------------------------------
# Version snapshots
# ---------------------------------------------------------------------------


def _snapshot_metadata(formulation: Formulation) -> dict[str, Any]:
    return {
        "name": formulation.name,
        "code": formulation.code,
        "description": formulation.description,
        "dosage_form": formulation.dosage_form,
        "capsule_size": formulation.capsule_size,
        "tablet_size": formulation.tablet_size,
        "serving_size": formulation.serving_size,
        "servings_per_pack": formulation.servings_per_pack,
        "directions_of_use": formulation.directions_of_use,
        "suggested_dosage": formulation.suggested_dosage,
        "appearance": formulation.appearance,
        "disintegration_spec": formulation.disintegration_spec,
    }


def _snapshot_lines(formulation: Formulation) -> list[dict[str, Any]]:
    return [
        {
            "item_id": str(line.item_id),
            "item_name": line.item.name,
            "item_internal_code": line.item.internal_code,
            "display_order": line.display_order,
            "label_claim_mg": str(line.label_claim_mg),
            "serving_size_override": line.serving_size_override,
            "mg_per_serving": (
                str(line.mg_per_serving_cached)
                if line.mg_per_serving_cached is not None
                else None
            ),
            "notes": line.notes,
        }
        for line in formulation.lines.select_related("item").all()
    ]


def _serialize_totals(totals: FormulationTotals) -> dict[str, Any]:
    return {
        "total_active_mg": str(totals.total_active_mg),
        "dosage_form": totals.dosage_form,
        "size_key": totals.size_key,
        "size_label": totals.size_label,
        "max_weight_mg": (
            str(totals.max_weight_mg) if totals.max_weight_mg is not None else None
        ),
        "total_weight_mg": (
            str(totals.total_weight_mg)
            if totals.total_weight_mg is not None
            else None
        ),
        "excipients": (
            {
                "mg_stearate_mg": str(totals.excipients.mg_stearate_mg),
                "silica_mg": str(totals.excipients.silica_mg),
                "mcc_mg": str(totals.excipients.mcc_mg),
                "dcp_mg": (
                    str(totals.excipients.dcp_mg)
                    if totals.excipients.dcp_mg is not None
                    else None
                ),
            }
            if totals.excipients is not None
            else None
        ),
        "viability": {
            "fits": totals.viability.fits,
            "comfort_ok": totals.viability.comfort_ok,
            "codes": list(totals.viability.codes),
        },
        "warnings": list(totals.warnings),
    }


@transaction.atomic
def save_version(
    *,
    formulation: Formulation,
    actor: Any,
    label: str = "",
) -> FormulationVersion:
    """Freeze the formulation's current state into a new version."""

    totals = compute_formulation_totals(formulation=formulation)

    highest = (
        formulation.versions.aggregate(Max("version_number"))[
            "version_number__max"
        ]
        or 0
    )
    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=highest + 1,
        label=label,
        snapshot_metadata=_snapshot_metadata(formulation),
        snapshot_lines=_snapshot_lines(formulation),
        snapshot_totals=_serialize_totals(totals),
        created_by=actor,
    )
    return version


def list_versions(
    *, formulation: Formulation
) -> QuerySet[FormulationVersion]:
    return formulation.versions.all()


def get_version(
    *,
    formulation: Formulation,
    version_number: int,
) -> FormulationVersion:
    version = formulation.versions.filter(
        version_number=version_number
    ).first()
    if version is None:
        raise FormulationVersionNotFound()
    return version


@transaction.atomic
def rollback_to_version(
    *,
    formulation: Formulation,
    actor: Any,
    version_number: int,
) -> Formulation:
    """Restore the formulation's mutable state from a past snapshot.

    The snapshot is copied back onto the working rows, then a *new*
    version is appended so the rollback is itself audited — history
    is always append-only.
    """

    version = get_version(
        formulation=formulation, version_number=version_number
    )

    metadata = version.snapshot_metadata or {}
    for key in (
        "name",
        "code",
        "description",
        "dosage_form",
        "capsule_size",
        "tablet_size",
        "serving_size",
        "servings_per_pack",
        "directions_of_use",
        "suggested_dosage",
        "appearance",
        "disintegration_spec",
    ):
        if key in metadata:
            setattr(formulation, key, metadata[key])
    formulation.updated_by = actor
    formulation.save()

    snapshot_lines = version.snapshot_lines or []
    lines_payload: list[dict[str, Any]] = []
    for entry in snapshot_lines:
        lines_payload.append(
            {
                "item_id": entry["item_id"],
                "label_claim_mg": entry["label_claim_mg"],
                "serving_size_override": entry.get("serving_size_override"),
                "display_order": entry.get("display_order", 0),
                "notes": entry.get("notes", ""),
            }
        )
    replace_lines(formulation=formulation, actor=actor, lines=lines_payload)

    save_version(
        formulation=formulation,
        actor=actor,
        label=f"rollback to v{version_number}",
    )
    return formulation
