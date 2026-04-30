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

import html
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Max, QuerySet

from apps.audit.services import record as record_audit, snapshot
from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.formulations.constants import (
    ACIDITY_USE_CATEGORIES,
    AMINO_ACID_GROUPS,
    AMINO_ACID_KEYS,
    CAPSULE_MG_STEARATE_PCT,
    CAPSULE_SHELL_LABEL,
    CAPSULE_SILICA_PCT,
    CAPSULE_SIZES,
    COMPLIANCE_FLAGS,
    DosageForm,
    EXCIPIENT_LABEL_ANTICAKING,
    EXCIPIENT_LABEL_DCP,
    EXCIPIENT_LABEL_GELLING_AGENT,
    EXCIPIENT_LABEL_GUMMY_BASE,
    EXCIPIENT_LABEL_MCC,
    EXCIPIENT_LABEL_PREMIX_SWEETENER,
    FLAVOURING_USE_CATEGORIES,
    COLOUR_USE_CATEGORIES,
    GELLING_USE_CATEGORIES,
    GLAZING_USE_CATEGORIES,
    EXCIPIENT_LABEL_WATER,
    GUMMY_BAND_DEFAULT_PCT,
    GUMMY_BAND_OVERRIDE_KEYS,
    GUMMY_BASE_MIN_PCT,
    GUMMY_BASE_USE_CATEGORIES,
    GUMMY_ACIDITY_PCT,
    GUMMY_FLAVOURING_PCT,
    GUMMY_COLOUR_PCT,
    GUMMY_GELLING_PCT,
    GUMMY_GLAZING_PCT,
    GUMMY_PREMIX_SWEETENER_PCT,
    GUMMY_WATER_PCT,
    NUTRITION_KEYS,
    POWDER_FLAVOUR_SYSTEM,
    POWDER_REFERENCE_WATER_ML,
    PREMIX_SWEETENER_USE_CATEGORIES,
    SWEETENER_USE_CATEGORIES,
    PowderType,
    TABLET_DCP_PCT,
    TABLET_MCC_PCT,
    TABLET_MG_STEARATE_PCT,
    TABLET_SILICA_PCT,
    TABLET_SIZES,
    auto_pick_capsule_size,
    capsule_size_by_key,
    normalize_compliance_value,
    normalize_use_as_value,
    powder_flavour_system_for,
    tablet_size_by_key,
)
from apps.formulations.models import (
    Formulation,
    FormulationLine,
    FormulationVersion,
)
from apps.organizations.models import Membership, Organization


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FormulationNotFound(Exception):
    code = "formulation_not_found"


class FormulationCodeConflict(Exception):
    code = "formulation_code_conflict"


class FormulationCodeRequired(Exception):
    """Raised when a caller omits the project code on create.

    Scientists now pick the project's internal code themselves — it
    usually mirrors the MRPeasy / lab-book reference (``MA210367``,
    ``FB-001``) and is part of the paperwork trail. We removed the
    ``PRJ-NNNN`` auto-generator because auto-codes kept being quoted
    back on specification sheets and signed contracts, then diverging
    from the code the rest of the business used for the same project.
    """

    code = "formulation_code_required"


class FormulationVersionNotFound(Exception):
    code = "formulation_version_not_found"


class InvalidDosageForm(Exception):
    code = "invalid_dosage_form"


class InvalidCapsuleSize(Exception):
    code = "invalid_capsule_size"


class InvalidTabletSize(Exception):
    code = "invalid_tablet_size"


class InvalidPowderType(Exception):
    code = "invalid_powder_type"


class InvalidGummyBaseItem(Exception):
    """Picked gummy base item is not valid — either unknown, outside
    the org's raw_materials catalogue, or carries a ``use_as`` that
    isn't in :data:`apps.formulations.constants.GUMMY_BASE_USE_CATEGORIES`.
    The frontend maps the code back to a specific translation so the
    scientist sees why their pick was rejected rather than a generic
    form error."""

    code = "invalid_gummy_base_item"


class InvalidAcidityItem(Exception):
    """Picked acidity regulator item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Acidity Regulator"``.
    Same rejection semantics as :class:`InvalidGummyBaseItem`."""

    code = "invalid_acidity_item"


class InvalidFlavouringItem(Exception):
    """Picked flavouring item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Flavouring"``. Same
    rejection semantics as :class:`InvalidGummyBaseItem`."""

    code = "invalid_flavouring_item"


class InvalidColourItem(Exception):
    """Picked colour item is not in the org's raw_materials catalogue
    or doesn't carry ``use_as == "Colour"``. Same rejection semantics
    as :class:`InvalidGummyBaseItem`."""

    code = "invalid_colour_item"


class InvalidGlazingItem(Exception):
    """Picked glazing item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Glazing Agent"``. Same
    rejection shape as the base / flavour-colour siblings."""

    code = "invalid_glazing_item"


class InvalidGellingItem(Exception):
    """Picked gelling item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Gelling Agent"``. Same
    rejection shape as the base / flavour-colour / glazing siblings —
    the frontend maps the code to its own translation so a scientist
    sees "this pick isn't a gelling agent" instead of a generic form
    error."""

    code = "invalid_gelling_item"


class InvalidSweetenerItem(Exception):
    """Picked sweetener item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Sweeteners"``. Powder-only
    picker — keep the rejection shape parallel to the gummy-base /
    flavour / colour siblings so the frontend can surface a field-
    specific error rather than a generic form failure."""

    code = "invalid_sweetener_item"


class InvalidPremixSweetenerItem(Exception):
    """Picked premix-sweetener item is not in the org's raw_materials
    catalogue or doesn't carry a ``use_as`` in the gummy-base pool
    (Sweeteners / Bulking Agent). The premix-sweetener picker reuses
    the gummy-base catalogue so picks are validated against the same
    category set, but the error code is distinct so the frontend can
    surface it on the right field."""

    code = "invalid_premix_sweetener_item"


class InvalidExcipientOverrides(Exception):
    """The submitted ``excipient_overrides`` dict is malformed —
    either not a dict, contains a non-numeric value, or names a
    band slug we do not recognise. We fail loudly rather than
    silently dropping bad keys so the scientist notices the typo
    before it gets baked into a snapshot."""

    code = "invalid_excipient_overrides"


class RawMaterialNotInOrg(Exception):
    """Raised when a formulation line targets an item outside the
    organization's ``raw_materials`` catalogue."""

    code = "raw_material_not_in_org"


class SalesPersonNotMember(Exception):
    """Candidate user is not a member of the formulation's organization.

    Guards against cross-tenant user references: an attacker who
    guessed a valid user UUID from another tenant must not be able
    to attach them to a project they do not belong to.
    """

    code = "sales_person_not_member"


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
class ExcipientRow:
    """One excipient line for dosage forms that use an open-ended list
    (powder, gummy) rather than the fixed capsule/tablet trio. ``slug``
    is machine-stable for i18n lookups; ``label`` is the fallback
    display copy; ``mg`` is the absolute per-unit weight; ``is_remainder``
    flags the row computed as ``target - active - sum(other rows)`` so
    the UI can badge it distinctly from the fixed-% rows.

    ``concentration_mg_per_ml`` is populated for powder flavour rows
    that scale linearly with the serving's water volume (Trisodium
    Citrate, Citric Acid, etc.) so the UI can show the raw rate next
    to the computed mg — matches the ``K7 × 0.1% × 100`` notation on
    the Formulation Calculation Sheet."""

    slug: str
    label: str
    mg: Decimal
    is_remainder: bool = False
    concentration_mg_per_ml: Decimal | None = None
    #: Canonical ``use_as`` category for the source catalogue item.
    #: Drives EU 1169/2011 grouping in the ingredient declaration —
    #: per-pick rows emit ``use_as = "Flavouring"`` etc. so the
    #: formatter renders "Flavouring (Strawberry, Lemon)". Blank for
    #: synthetic placeholder rows (acidity, generic gummy base) and
    #: powder flavour rows so they sit standalone in the declaration.
    use_as: str = ""
    #: Per-pick allergen flags pulled from the source catalogue item.
    #: Forward into the declaration entry so an allergen-flagged
    #: gelatin pick still renders bold in the grouped output.
    is_allergen: bool = False
    allergen_source: str = ""


@dataclass
class GummyBaseRow:
    """One pick in the gummy-base blend.

    The base total is split equally across picks — so three picked
    items each carry ``total / 3``. ``label`` comes from the picked
    catalogue item's ``ingredient_list_name`` (fallback: ``name``),
    and ``use_as`` is the canonical category (Sweeteners / Bulking
    Agent) that drives the EU-label grouping on the spec sheet
    declaration.
    """

    item_id: str
    label: str
    use_as: str
    mg: Decimal


@dataclass
class ExcipientBreakdown:
    mg_stearate_mg: Decimal
    silica_mg: Decimal
    mcc_mg: Decimal
    dcp_mg: Decimal | None = None  # tablet-only
    #: Gummy-only auto-fills. ``gummy_base_mg`` is the TOTAL base
    #: weight (target − water − actives − flavour, min 65% floor);
    #: when multiple items are picked the total is split equally
    #: across them on ``gummy_base_rows``. ``water_mg`` is a fixed
    #: 5.5% of target. Both stay ``None`` on non-gummy forms so
    #: serializers can suppress empty rows without a form-check.
    gummy_base_mg: Decimal | None = None
    water_mg: Decimal | None = None
    #: Per-item breakdown of the gummy base. Empty on non-gummy or
    #: when no bases were picked (the declaration falls back to the
    #: generic :data:`EXCIPIENT_LABEL_GUMMY_BASE` label). Each entry
    #: carries the per-item mg share, the label-friendly copy, and
    #: the EU use_as category so the declaration can render
    #: "Sweeteners (Xylitol, Maltitol)" as one grouped line.
    gummy_base_rows: tuple["GummyBaseRow", ...] = ()
    #: Optional flexible list used for dosage forms that do not fit
    #: the capsule/tablet four-field shape. Powder + gummy populate
    #: this; capsule + tablet leave it empty.
    rows: tuple[ExcipientRow, ...] = ()


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


@dataclass
class ComplianceFlagResult:
    """Aggregate answer for a single compliance flag (vegan, organic,
    halal, kosher) across every ingredient in the formulation."""

    key: str
    label: str
    #: ``True`` when every ingredient is confidently compliant;
    #: ``False`` when at least one ingredient is confidently
    #: non-compliant; ``None`` when there are no confident-compliant
    #: answers to aggregate (entire formulation missing data).
    status: bool | None
    #: Number of ingredients the catalogue flags as compliant.
    compliant_count: int
    #: Number of ingredients the catalogue flags as non-compliant.
    non_compliant_count: int
    #: Number of ingredients where the catalogue did not record a
    #: value — these do not taint the product but mean the answer is
    #: held with reduced confidence. Separate count so the UI can
    #: show a faded/tentative chip instead of a confident one.
    unknown_count: int


@dataclass
class ComplianceResult:
    flags: tuple[ComplianceFlagResult, ...]


@dataclass
class NutrientAggregate:
    """Per-nutrient aggregation for the spec sheet's nutrition panel.

    ``per_serving`` and ``per_100g`` live alongside the raw sum so the
    sheet can display both columns. ``contributors`` is the count of
    ingredients that actually had catalogue data for this nutrient —
    surfaces to the UI as a small "based on N of M ingredients" hint,
    so a half-filled catalogue does not look like a confident zero.
    """

    key: str
    per_serving: Decimal
    per_100g: Decimal
    contributors: int


@dataclass
class AminoAcidGroup:
    key: str
    acids: tuple[NutrientAggregate, ...]


@dataclass
class IngredientDeclarationEntry:
    """Per-row detail for the ingredient declaration string.

    Exposed alongside the joined string so the UI can render a table
    (line + weight + "appears as" label) when the scientist wants to
    sanity-check the label copy before the spec sheet exports it.
    """

    label: str
    mg: Decimal
    #: ``"active" | "excipient" | "shell"`` — lets the UI badge each
    #: row differently.
    category: str
    #: ``True`` when this row's source catalogue item is flagged as an
    #: allergen. The spec sheet uses this to render the ingredient's
    #: name in bold inside the declaration paragraph, per EU labelling
    #: requirement 1169/2011 art. 21 (the workbook matches this by
    #: manually bolding allergens; we do it with ``<strong>`` tags).
    is_allergen: bool = False
    #: The allergen class reported by the catalogue (``"Milk"``,
    #: ``"Soybeans"``, etc.). Blank when ``is_allergen`` is ``False``.
    allergen_source: str = ""
    #: Canonical ``use_as`` value (``"Sweeteners"``, ``"Colourant"``,
    #: etc.) for the sourcing catalogue item. Blank for synthetic
    #: excipients (MCC, Anticaking, Capsule Shell) and for actives
    #: where grouping is by individual name not by category. Drives
    #: the EU 1169/2011 category grouping in the declaration string.
    use_as: str = ""


@dataclass
class FormulationAllergens:
    """Aggregate allergen picture for one formulation version.

    ``sources`` is the comma-sorted list of distinct allergen classes
    across every active ingredient (e.g. ``["Milk", "Soy"]``). Empty
    when the product has no allergenic ingredients — the spec sheet
    suppresses the Allergens line entirely in that case, matching
    the workbook's ``IF(T10=0, "", "Allergen:")`` convention.
    """

    sources: tuple[str, ...]
    #: Raw count of actives flagged as allergens. Usually equals
    #: ``len(sources)`` but can exceed it when two ingredients share
    #: the same source (e.g. two different milk proteins).
    allergen_count: int


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


def _resolve_band_pct(
    slug: str, overrides: dict[str, Any] | None
) -> float:
    """Pick the effective % for a gummy excipient band.

    Reads ``overrides[slug]`` if it's a positive-or-zero number,
    otherwise falls back to :data:`GUMMY_BAND_DEFAULT_PCT[slug]`. We
    treat any non-numeric, negative, or unknown value as "no override"
    so a stray key from a future build never crashes the math — the
    write-side validator (:func:`_validate_excipient_overrides`)
    rejects malformed payloads up front so by the time we reach this
    helper the data is already known-good.
    """

    if isinstance(overrides, dict):
        raw = overrides.get(slug)
        if isinstance(raw, bool):
            raw = None
        if isinstance(raw, (int, float)):
            value = float(raw)
            if value >= 0:
                return value
        elif isinstance(raw, str):
            parsed = _coerce_float(raw)
            if parsed is not None and parsed >= 0:
                return parsed
    return GUMMY_BAND_DEFAULT_PCT.get(slug, 0.0)


def _validate_excipient_overrides(value: Any) -> dict[str, float]:
    """Coerce + validate an incoming ``excipient_overrides`` payload.

    * Accepts ``None`` / ``{}`` as "no overrides".
    * Rejects non-dict shapes.
    * Each key must sit in :data:`GUMMY_BAND_OVERRIDE_KEYS`.
    * Each value must parse to a non-negative float ≤ 1.0 (we treat
      anything > 100% as a typo — even an aggressive 50% override
      stays well under that ceiling).
    * Missing keys aren't required — partial overrides are valid.

    Returns a clean ``{slug: float}`` dict ready to persist on the
    formulation. Raises :class:`InvalidExcipientOverrides` on any
    structural error so the API surfaces a 400 with a code the
    frontend can translate.
    """

    if value is None:
        return {}
    if not isinstance(value, dict):
        raise InvalidExcipientOverrides()
    cleaned: dict[str, float] = {}
    for key, raw in value.items():
        if not isinstance(key, str) or key not in GUMMY_BAND_OVERRIDE_KEYS:
            raise InvalidExcipientOverrides()
        if isinstance(raw, bool):
            raise InvalidExcipientOverrides()
        if isinstance(raw, (int, float)):
            num = float(raw)
        elif isinstance(raw, str):
            parsed = _coerce_float(raw)
            if parsed is None:
                raise InvalidExcipientOverrides()
            num = parsed
        elif raw is None:
            # Explicit ``null`` clears the override for that band.
            continue
        else:
            raise InvalidExcipientOverrides()
        if num < 0 or num > 1.0:
            raise InvalidExcipientOverrides()
        cleaned[key] = num
    return cleaned


def _compute_fill_target(
    dosage_form: str,
    total_active: Decimal,
    target_fill_weight_mg: Decimal | None,
    powder_type: str | None = None,
    water_volume_ml: Decimal | None = None,
    gummy_base_items: tuple[Item, ...] = (),
    flavouring_items: tuple[Item, ...] = (),
    colour_items: tuple[Item, ...] = (),
    sweetener_items: tuple[Item, ...] = (),
    glazing_items: tuple[Item, ...] = (),
    gelling_items: tuple[Item, ...] = (),
    premix_sweetener_items: tuple[Item, ...] = (),
    acidity_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    """Fill-weight reconciliation for powder + gummy.

    The reference workbooks (Moonlytes, Soza, Rave Lytes, Cotswold
    Probiotics Gummies) all treat the carrier / gummy base as a
    real catalogue ingredient the scientist explicitly adds — e.g.
    Moonlytes picks ``MA200161 Maltodextrin`` with a ``Bulking Agent``
    label-copy name. We therefore **do not** fabricate a virtual
    "remainder" row — that would invent an ingredient with no
    procurement code and no supplier. Instead the scientist adds the
    carrier themselves as a normal formulation line, and this
    function just reconciles the sum against the target.

    * ``target`` blank → report the total, flag ``fill_weight_required``.
    * ``total_active`` < ``target`` → ``fill_shortfall`` warning and
      ``more_challenging_to_make`` viability so the scientist knows
      to add a carrier line.
    * ``total_active`` ≈ ``target`` (within 0.5%) → ``can_make``.
    * ``total_active`` > ``target`` → ``cannot_make`` — overshooting
      the sachet / gummy mass means the product can't be pressed.
    """

    # Flavour system rows — reference values every powder / gummy
    # workbook hand-types. The scientist tunes mg per product later
    # (row-level editing lives on the formulation, Phase F-next); for
    # now we ship the Rave Lytes / Moonlytes defaults so every new
    # sachet has the same five-row shape as Excel's BOM scratchpad.
    # Powder flavour rows are concentrations (mg per ml of water);
    # multiplying by the serving's water volume produces the per-serving
    # mg exactly as the Formulation Calculation Sheet does. Gummies
    # stay on the legacy (slug, label, mg) tuple shape because their
    # "Water" / "Acidity regulator" rows are per-gummy weights, not
    # dilution targets.
    is_powder = dosage_form == DosageForm.POWDER.value
    flavour_rows: list[ExcipientRow] = []

    def _emit_pick_band(
        *,
        block_slug: str,
        block_label: str,
        block_total_mg: float,
        picks: tuple[Item, ...],
        band_use_as: str,
        placeholder_when_empty: bool = True,
        concentration_mg_per_ml: Decimal | None = None,
    ) -> None:
        """Emit either per-pick rows or a generic placeholder at the
        block's full mg total. Shared between the powder and gummy
        branches so picker semantics stay identical: pick the same
        catalogue items, get the same per-pick row + label-copy
        treatment, regardless of dosage form.

        ``concentration_mg_per_ml`` is propagated from the powder
        preset so each per-pick row still carries the dilution
        target the FRONTEND uses to render the "0.06 mg/ml × Nml"
        breakdown next to the row.

        Per-pick rows carry ``use_as = band_use_as`` so the EU
        1169/2011 declaration formatter groups them as e.g.
        "Flavouring (Strawberry, Lemon)" / "Sweetener (Sucralose,
        Stevia)". Allergen flags are forwarded so a gelatin pick
        still renders bold.
        """

        if block_total_mg <= 0:
            return
        if picks:
            per_item_mg = block_total_mg / len(picks)
            per_item_concentration: Decimal | None
            if concentration_mg_per_ml is not None and len(picks) > 0:
                per_item_concentration = (
                    concentration_mg_per_ml / Decimal(len(picks))
                )
            else:
                per_item_concentration = None
            for item in picks:
                attrs = item.attributes or {}
                pick_label = (
                    attrs.get("ingredient_list_name") or ""
                ).strip() or item.name
                flavour_rows.append(
                    ExcipientRow(
                        slug=f"{block_slug}:{item.id}",
                        label=pick_label,
                        mg=_quantise(per_item_mg),
                        use_as=band_use_as,
                        is_allergen=_is_item_allergen(item),
                        allergen_source=_allergen_source_for_item(item),
                        concentration_mg_per_ml=per_item_concentration,
                    )
                )
        elif placeholder_when_empty:
            flavour_rows.append(
                ExcipientRow(
                    slug=block_slug,
                    label=block_label,
                    mg=_quantise(block_total_mg),
                    concentration_mg_per_ml=concentration_mg_per_ml,
                )
            )

    if is_powder:
        preset = powder_flavour_system_for(powder_type)
        # Default to the reference volume when the scientist has not
        # typed one yet so a fresh powder still shows a sensible
        # flavour system rather than zero rows.
        water_ml = (
            max(float(water_volume_ml), 0.0)
            if water_volume_ml is not None
            else POWDER_REFERENCE_WATER_ML
        )
        # Powder rows fall into two camps:
        #   * Acidity regulators (trisodium_citrate, citric_acid) —
        #     auto-resolved by name lookup against the catalogue,
        #     no picker needed. Render as a single generic row.
        #   * Flavour-facing rows (flavouring, sweetener, colour) —
        #     scientist picks specific catalogue items; the per-row
        #     mg total splits equally across picks just like gummies.
        #     Empty picks fall back to the generic placeholder so an
        #     in-flight powder formulation still renders a sensible
        #     row before the scientist makes their picks.
        powder_pickers: dict[str, tuple[tuple[Item, ...], str]] = {
            "flavouring": (flavouring_items, "Flavouring"),
            "sweetener": (sweetener_items, "Sweeteners"),
            "colour": (colour_items, "Colour"),
        }
        for slug, label, mg_per_ml in preset:
            block_total_mg = mg_per_ml * water_ml
            picker = powder_pickers.get(slug)
            if picker is not None:
                picks, band_use_as = picker
                _emit_pick_band(
                    block_slug=slug,
                    block_label=label,
                    block_total_mg=block_total_mg,
                    picks=picks,
                    band_use_as=band_use_as,
                    concentration_mg_per_ml=Decimal(str(mg_per_ml)),
                )
                continue
            # Non-picker row: keep the current generic-row behaviour
            # so name-resolved excipients (Trisodium Citrate, Citric
            # Acid) render as before.
            flavour_rows.append(
                ExcipientRow(
                    slug=slug,
                    label=label,
                    mg=_quantise(block_total_mg),
                    concentration_mg_per_ml=Decimal(str(mg_per_ml)),
                )
            )
    else:
        # Gummy flavour system — six scaled blocks, in order:
        #
        # 1. Acidity Regulator     — 2%   of target gummy weight
        # 2. Flavouring            — 0.4% of target gummy weight
        # 3. Colour                — 2%   of target gummy weight
        # 4. Glazing Agent         — 0.1% of target gummy weight
        # 5. Gelling Agent         — 3%   of target  (only when picks)
        # 6. Premix Sweetener      — 6%   of target  (only when gelling
        #                                            picks present —
        #                                            carved from base)
        #
        # Each percentage is the *default*; per-band overrides come
        # from ``excipient_overrides`` so a scientist can fine-tune
        # any band on a per-formulation basis without forking the
        # global defaults. Picks for any band split their total
        # equally across catalogue items so the spec sheet renders
        # "Flavouring (Natural Strawberry, Lemon Extract)" with real
        # procurement codes per name. Empty picks for flavouring /
        # colour / glazing fall back to a generic placeholder row;
        # empty picks for gelling skip the gelling + premix bands
        # entirely (a non-gelling gummy).
        target_for_scaled = (
            float(target_fill_weight_mg)
            if target_fill_weight_mg is not None
            and target_fill_weight_mg > 0
            else 0.0
        )

        acidity_pct = _resolve_band_pct("acidity", excipient_overrides)
        flavouring_pct = _resolve_band_pct("flavouring", excipient_overrides)
        colour_pct = _resolve_band_pct("colour", excipient_overrides)
        glazing_pct = _resolve_band_pct("glazing", excipient_overrides)
        gelling_pct = _resolve_band_pct("gelling", excipient_overrides)
        premix_sweetener_pct = _resolve_band_pct(
            "premix_sweetener", excipient_overrides
        )

        # ``_emit_pick_band`` was lifted to enclosing scope above so
        # the powder branch can reuse the same picker semantics. The
        # gummy bands keep using it identically — no behaviour change.

        _emit_pick_band(
            block_slug="acidity",
            block_label="Acidity Regulator",
            block_total_mg=target_for_scaled * acidity_pct,
            picks=acidity_items,
            band_use_as="Acidity Regulator",
        )
        _emit_pick_band(
            block_slug="flavouring",
            block_label="Flavouring",
            block_total_mg=target_for_scaled * flavouring_pct,
            picks=flavouring_items,
            band_use_as="Flavouring",
        )
        _emit_pick_band(
            block_slug="colour",
            block_label="Colour",
            block_total_mg=target_for_scaled * colour_pct,
            picks=colour_items,
            band_use_as="Colour",
        )
        _emit_pick_band(
            block_slug="glazing",
            block_label="Glazing Agent",
            block_total_mg=target_for_scaled * glazing_pct,
            picks=glazing_items,
            band_use_as="Glazing Agent",
        )

        # Gelling + premix sweetener are coupled: both emit only when
        # the scientist has actually picked at least one gelling
        # agent. Empty gelling picks → a non-gelling gummy (no
        # gelling band, no premix sweetener band). The premix
        # sweetener picker on its own without a gelling pick is
        # ignored — the premix is meaningless without something to
        # gel with.
        if gelling_items:
            _emit_pick_band(
                block_slug="gelling",
                block_label=EXCIPIENT_LABEL_GELLING_AGENT,
                block_total_mg=target_for_scaled * gelling_pct,
                picks=gelling_items,
                band_use_as="Gelling Agent",
                placeholder_when_empty=False,
            )
            # Premix sweeteners use the picked items' canonical
            # ``use_as`` (Sweeteners / Bulking Agent) — the band's
            # rows merge with the gummy-base picks under the EU
            # label, e.g. ``"Sweeteners (Maltitol, Xylitol)"`` with
            # premix + base items combined. Reading the use_as off
            # the first pick keeps the row tagged with its actual
            # category rather than a synthetic "Premix" bucket that
            # the label rules don't recognise.
            premix_use_as = ""
            if premix_sweetener_items:
                first_attrs = premix_sweetener_items[0].attributes or {}
                premix_use_as = normalize_use_as_value(
                    str(first_attrs.get("use_as") or "")
                )
            _emit_pick_band(
                block_slug="premix_sweetener",
                block_label=EXCIPIENT_LABEL_PREMIX_SWEETENER,
                block_total_mg=target_for_scaled * premix_sweetener_pct,
                picks=premix_sweetener_items,
                band_use_as=premix_use_as,
            )
    flavour_rows_tuple: tuple[ExcipientRow, ...] = tuple(flavour_rows)
    flavour_total = sum((float(r.mg) for r in flavour_rows_tuple), 0.0)

    # Gummy math (MCC-style remainder-fill, following scientist
    # guidance 2026-04-24):
    #
    #   water       = target × 5.5%              (fixed)
    #   actives+flav = whatever the scientist enters
    #   gummy_base  = target − water − actives − flavour   (remainder)
    #
    # ``GUMMY_BASE_MIN_PCT`` is the **floor** — if the scientist
    # loads enough actives that the remaining gummy base drops below
    # that floor, the gel matrix can't set reliably and viability
    # flips to ``cannot_make``. Below the floor the computed
    # ``gummy_base_mg`` is still emitted (so the UI shows what it
    # *would* be) but the viability code tells the scientist they
    # need to either drop actives or raise the gummy target weight.
    #
    # Label + ``use_as`` come off the picked catalogue item so the
    # spec sheet reads "Sweeteners (Xylitol)" instead of a generic
    # "Gummy Base".
    is_gummy = dosage_form == DosageForm.GUMMY.value
    gummy_base_mg: Decimal | None = None
    water_mg: Decimal | None = None
    gummy_base_rows: list[GummyBaseRow] = []

    if is_gummy and target_fill_weight_mg is not None and target_fill_weight_mg > 0:
        target_float = float(target_fill_weight_mg)
        water_pct = _resolve_band_pct("water", excipient_overrides)
        water_mg = _quantise(target_float * water_pct)
        # Remainder = target − water − actives − flavour. Can go
        # negative if the scientist has overloaded actives; we clamp
        # to zero for display but viability handles the shortfall
        # via the ``fill_overshoot`` / ``gummy_base_below_floor``
        # codes below.
        remainder = (
            target_float - float(water_mg) - float(total_active) - flavour_total
        )
        gummy_base_mg = _quantise(max(remainder, 0.0))

        # Split the total base equally across picked items. Three
        # picks → each carries ``total / 3``; zero picks → the list
        # stays empty and the declaration falls back to a generic
        # "Gummy Base" line.
        count = len(gummy_base_items)
        if count > 0 and gummy_base_mg > 0:
            per_item = float(gummy_base_mg) / count
            for item in gummy_base_items:
                attrs = item.attributes or {}
                label = (attrs.get("ingredient_list_name") or "").strip()
                if not label:
                    label = item.name
                raw_use_as = attrs.get("use_as")
                use_as = (
                    normalize_use_as_value(str(raw_use_as))
                    if raw_use_as
                    else ""
                )
                gummy_base_rows.append(
                    GummyBaseRow(
                        item_id=str(item.id),
                        label=label,
                        use_as=use_as,
                        mg=_quantise(per_item),
                    )
                )

    breakdown = ExcipientBreakdown(
        mg_stearate_mg=Decimal("0"),
        silica_mg=Decimal("0"),
        mcc_mg=Decimal("0"),
        gummy_base_mg=gummy_base_mg,
        water_mg=water_mg,
        gummy_base_rows=tuple(gummy_base_rows),
        rows=flavour_rows_tuple,
    )

    if target_fill_weight_mg is None or target_fill_weight_mg <= 0:
        return (
            None,
            None,
            None,
            _quantise(float(total_active) + flavour_total),
            breakdown,
            ViabilityResult(
                fits=False,
                comfort_ok=False,
                codes=("fill_weight_required",),
            ),
            (),
        )

    target = float(target_fill_weight_mg)
    active = float(total_active)
    # For gummies the base absorbs headroom, so the recipe either
    # equals the target (scientist stayed inside the active budget)
    # or overshoots (too many actives — base clamped to 0, water +
    # flavour + active now exceed the target).
    if is_gummy:
        recipe_total = max(
            target, active + flavour_total + float(water_mg or 0)
        )
    else:
        recipe_total = active + flavour_total
    # Tolerance band: within 0.5% of target counts as "matches". This
    # accounts for rounding in the per-line mg math without declaring
    # a 9999mg sachet "short" against a 10000mg target.
    tolerance = max(target * 0.005, 0.1)
    fits = recipe_total <= target + tolerance
    matches = abs(recipe_total - target) <= tolerance
    codes: list[str] = []
    warnings: list[str] = []

    # Gummy-specific floor check: the base must stay at
    # ≥ ``GUMMY_BASE_MIN_PCT`` of the target or the gel matrix won't
    # set reliably. Evaluated before the generic fits/matches so a
    # below-floor bundle lands on ``cannot_make`` regardless of how
    # the overall tolerance looks.
    if is_gummy and gummy_base_mg is not None:
        floor = target * GUMMY_BASE_MIN_PCT
        if float(gummy_base_mg) + tolerance < floor:
            fits = False
            codes.append("cannot_make")
            warnings.append("gummy_base_below_floor")

    if not fits:
        if "cannot_make" not in codes:
            codes.append("cannot_make")
        if is_gummy and "gummy_base_below_floor" not in warnings:
            warnings.append("fill_overshoot")
        elif not is_gummy:
            warnings.append("fill_overshoot")
    elif matches:
        codes.extend(("can_make", "less_challenging", "proceed_to_quote"))
    else:
        # Under target — scientist still needs to add a carrier /
        # bulking agent / gummy base line to reach the sachet mass.
        codes.extend(("can_make", "more_challenging_to_make", "fill_shortfall"))
        warnings.append("fill_shortfall")

    size_label = (
        f"Sachet ({_format_fill_weight(target)})"
        if dosage_form == DosageForm.POWDER.value
        else f"Gummy ({_format_fill_weight(target)})"
    )
    size_key = "sachet" if dosage_form == DosageForm.POWDER.value else "gummy"

    return (
        size_key,
        size_label,
        _quantise(target),
        _quantise(recipe_total),
        breakdown,
        ViabilityResult(
            fits=fits,
            comfort_ok=matches,
            codes=tuple(codes),
        ),
        tuple(warnings),
    )


def _format_fill_weight(mg: float) -> str:
    """Render a fill weight as grams with 2 decimals where it's in
    the "usual sachet / gummy" range, keeping mg for small values so a
    5mg micro-sachet reads as ``5mg`` rather than ``0.01g``."""

    if mg >= 1000:
        return f"{mg / 1000:.2f}g"
    return f"{mg:.0f}mg"


def compute_totals(
    *,
    lines: Iterable[tuple[str, Item, Decimal | float, int | None]],
    dosage_form: str,
    capsule_size_key: str | None = None,
    tablet_size_key: str | None = None,
    default_serving_size: int = 1,
    target_fill_weight_mg: Decimal | None = None,
    powder_type: str | None = None,
    water_volume_ml: Decimal | None = None,
    gummy_base_items: tuple[Item, ...] = (),
    flavouring_items: tuple[Item, ...] = (),
    colour_items: tuple[Item, ...] = (),
    sweetener_items: tuple[Item, ...] = (),
    glazing_items: tuple[Item, ...] = (),
    gelling_items: tuple[Item, ...] = (),
    premix_sweetener_items: tuple[Item, ...] = (),
    acidity_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
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
    elif dosage_form in (DosageForm.POWDER.value, DosageForm.GUMMY.value):
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_fill_target(
            dosage_form,
            total_active,
            target_fill_weight_mg,
            powder_type=powder_type,
            water_volume_ml=water_volume_ml,
            gummy_base_items=gummy_base_items,
            flavouring_items=flavouring_items,
            colour_items=colour_items,
            sweetener_items=sweetener_items,
            glazing_items=glazing_items,
            gelling_items=gelling_items,
            premix_sweetener_items=premix_sweetener_items,
            acidity_items=acidity_items,
            excipient_overrides=excipient_overrides,
        )
    else:
        # Non-math dosage forms (liquid, other_solid) still report
        # the total but skip the excipient block — these need their
        # own volume-based treatment which isn't in scope yet.
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
    code: str,
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
    target_fill_weight_mg: Decimal | None = None,
    powder_type: str = PowderType.STANDARD.value,
    water_volume_ml: Decimal | None = None,
) -> Formulation:
    """Create a new formulation.

    ``code`` is the scientist's project reference (``MA210367``,
    ``FB-001``). It's mandatory and must be unique per organisation:
    the same string appears on the MRPeasy bill of materials, the
    signed specification sheet and the commercial proposal, so a
    server-assigned fallback would silently diverge from the code the
    rest of the business uses. ``FormulationCodeRequired`` fires on a
    blank value, ``FormulationCodeConflict`` on a duplicate — the API
    layer maps both into 400s with machine-readable codes.
    """

    code = (code or "").strip()
    if not code:
        raise FormulationCodeRequired()

    _validate_dosage_form(dosage_form)

    duplicate = Formulation.objects.filter(
        organization=organization, code=code
    ).exists()
    if duplicate:
        raise FormulationCodeConflict()

    if capsule_size and capsule_size_by_key(capsule_size) is None:
        raise InvalidCapsuleSize()
    if tablet_size and tablet_size_by_key(tablet_size) is None:
        raise InvalidTabletSize()
    _validate_powder_type(powder_type)

    # Seed the four free-text product cells with per-dosage-form
    # defaults when the caller submitted blanks — gives scientists
    # a sensible draft to copy + tweak rather than four empty
    # textareas. Non-blank input always wins so the AI-builder /
    # import flows that already know what to write are not
    # overridden.
    from apps.formulations.constants import FORMULATION_TEXT_DEFAULTS

    text_defaults = FORMULATION_TEXT_DEFAULTS.get(dosage_form, {})
    if not (directions_of_use or "").strip():
        directions_of_use = text_defaults.get("directions_of_use", "")
    if not (suggested_dosage or "").strip():
        suggested_dosage = text_defaults.get("suggested_dosage", "")
    if not (appearance or "").strip():
        appearance = text_defaults.get("appearance", "")
    if not (disintegration_spec or "").strip():
        disintegration_spec = text_defaults.get("disintegration_spec", "")

    formulation = Formulation.objects.create(
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
        target_fill_weight_mg=target_fill_weight_mg,
        powder_type=powder_type,
        water_volume_ml=water_volume_ml,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="formulation.create",
        target=formulation,
        after=snapshot(formulation),
    )
    return formulation


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
        "target_fill_weight_mg",
        "powder_type",
        "water_volume_ml",
        "project_status",
        "project_type",
    }
    if "dosage_form" in changes and changes["dosage_form"] is not None:
        _validate_dosage_form(changes["dosage_form"])
    if changes.get("capsule_size"):
        if capsule_size_by_key(changes["capsule_size"]) is None:
            raise InvalidCapsuleSize()
    if changes.get("tablet_size"):
        if tablet_size_by_key(changes["tablet_size"]) is None:
            raise InvalidTabletSize()
    if "powder_type" in changes and changes["powder_type"] is not None:
        _validate_powder_type(changes["powder_type"])
    # Gummy base picks — read the id list off ``changes`` and resolve
    # to org-scoped items. Empty / missing clears the selection; a
    # list of UUIDs validates ``use_as`` on each and replaces the M2M
    # atomically with the new set. Held back from the generic setattr
    # loop below because M2M writes need ``.set()`` and have to run
    # after the Formulation exists in the DB.
    pending_gummy_bases: list[Item] | None = None
    if "gummy_base_item_ids" in changes:
        pending_gummy_bases = _resolve_gummy_base_items(
            organization=formulation.organization,
            raw_ids=changes.pop("gummy_base_item_ids"),
        )
    pending_flavouring: list[Item] | None = None
    if "flavouring_item_ids" in changes:
        pending_flavouring = _resolve_flavouring_items(
            organization=formulation.organization,
            raw_ids=changes.pop("flavouring_item_ids"),
        )
    pending_colour: list[Item] | None = None
    if "colour_item_ids" in changes:
        pending_colour = _resolve_colour_items(
            organization=formulation.organization,
            raw_ids=changes.pop("colour_item_ids"),
        )
    pending_sweetener: list[Item] | None = None
    if "sweetener_item_ids" in changes:
        pending_sweetener = _resolve_sweetener_items(
            organization=formulation.organization,
            raw_ids=changes.pop("sweetener_item_ids"),
        )
    pending_glazing: list[Item] | None = None
    if "glazing_item_ids" in changes:
        pending_glazing = _resolve_glazing_items(
            organization=formulation.organization,
            raw_ids=changes.pop("glazing_item_ids"),
        )
    pending_gelling: list[Item] | None = None
    if "gelling_item_ids" in changes:
        pending_gelling = _resolve_gelling_items(
            organization=formulation.organization,
            raw_ids=changes.pop("gelling_item_ids"),
        )
    pending_premix_sweetener: list[Item] | None = None
    if "premix_sweetener_item_ids" in changes:
        pending_premix_sweetener = _resolve_premix_sweetener_items(
            organization=formulation.organization,
            raw_ids=changes.pop("premix_sweetener_item_ids"),
        )
    pending_acidity: list[Item] | None = None
    if "acidity_item_ids" in changes:
        pending_acidity = _resolve_acidity_items(
            organization=formulation.organization,
            raw_ids=changes.pop("acidity_item_ids"),
        )
    # Excipient overrides — validate up front so any malformed
    # payload short-circuits before we touch the M2M setters or the
    # audit row, but defer the actual write until after the audit
    # ``before`` snapshot so the diff captures the previous map.
    # ``None`` in ``changes`` is treated as "no change"; an empty
    # dict is treated as "clear overrides".
    pending_overrides: dict[str, float] | None = None
    if "excipient_overrides" in changes:
        raw_overrides = changes.pop("excipient_overrides")
        if raw_overrides is not None:
            pending_overrides = _validate_excipient_overrides(raw_overrides)
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

    # Snapshot before mutating so the audit row can show the
    # diff. Freezing the dict (not the instance) is enough — the
    # coerced values are already immutable by construction.
    before = snapshot(formulation)
    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(formulation, key, value)
    if pending_overrides is not None:
        formulation.excipient_overrides = pending_overrides

    formulation.updated_by = actor
    formulation.save()
    if pending_gummy_bases is not None:
        formulation.gummy_base_items.set(pending_gummy_bases)
    if pending_flavouring is not None:
        formulation.flavouring_items.set(pending_flavouring)
    if pending_colour is not None:
        formulation.colour_items.set(pending_colour)
    if pending_sweetener is not None:
        formulation.sweetener_items.set(pending_sweetener)
    if pending_glazing is not None:
        formulation.glazing_items.set(pending_glazing)
    if pending_gelling is not None:
        formulation.gelling_items.set(pending_gelling)
    if pending_premix_sweetener is not None:
        formulation.premix_sweetener_items.set(pending_premix_sweetener)
    if pending_acidity is not None:
        formulation.acidity_items.set(pending_acidity)
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.update",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


def _validate_dosage_form(value: str) -> None:
    valid = {form.value for form in DosageForm}
    if value not in valid:
        raise InvalidDosageForm()


def _validate_powder_type(value: str) -> None:
    valid = {variant.value for variant in PowderType}
    if value not in valid:
        raise InvalidPowderType()


def _resolve_glazing_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``glazing_item_ids`` — same validation shape
    as the base / flavour-colour resolvers, category
    ``Glazing Agent``. Fails with :class:`InvalidGlazingItem` on any
    off-vocab or foreign-tenant pick."""

    if raw_ids is None:
        return []
    if isinstance(raw_ids, (str, bytes)) or not hasattr(raw_ids, "__iter__"):
        raw_ids = [raw_ids]
    unique_ids: list[Any] = []
    seen: set[str] = set()
    for value in raw_ids:
        if value in (None, ""):
            continue
        key = str(value)
        if key in seen:
            continue
        seen.add(key)
        unique_ids.append(value)

    if not unique_ids:
        return []

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        raise InvalidGlazingItem()

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue=catalogue, id__in=unique_ids, is_archived=False
        )
    }
    resolved: list[Item] = []
    for value in unique_ids:
        item = items_by_id.get(str(value))
        if item is None:
            raise InvalidGlazingItem()
        raw_use_as = (item.attributes or {}).get("use_as") or ""
        normalised = normalize_use_as_value(str(raw_use_as))
        if normalised not in GLAZING_USE_CATEGORIES:
            raise InvalidGlazingItem()
        resolved.append(item)
    return resolved


def _resolve_use_as_picks(
    *,
    organization: Organization,
    raw_ids: Any,
    allowed_categories: tuple[str, ...],
    error_cls: type[Exception],
) -> list[Item]:
    """Generic id-list → ``Item`` resolver gated on ``use_as`` category.

    Mirrors :func:`_resolve_gummy_base_items` but parameterised on the
    allowed-category tuple and the exception type so each failure mode
    still surfaces through a distinct API code (and a distinct
    translation on the frontend) without four near-duplicate copies of
    the same body.
    """

    if raw_ids is None:
        return []
    if isinstance(raw_ids, (str, bytes)) or not hasattr(raw_ids, "__iter__"):
        raw_ids = [raw_ids]
    unique_ids: list[Any] = []
    seen: set[str] = set()
    for value in raw_ids:
        if value in (None, ""):
            continue
        key = str(value)
        if key in seen:
            continue
        seen.add(key)
        unique_ids.append(value)

    if not unique_ids:
        return []

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        raise error_cls()

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue=catalogue, id__in=unique_ids, is_archived=False
        )
    }
    resolved: list[Item] = []
    for value in unique_ids:
        item = items_by_id.get(str(value))
        if item is None:
            raise error_cls()
        raw_use_as = (item.attributes or {}).get("use_as") or ""
        normalised = normalize_use_as_value(str(raw_use_as))
        if normalised not in allowed_categories:
            raise error_cls()
        resolved.append(item)
    return resolved


def _resolve_acidity_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``acidity_item_ids`` — picks must carry
    ``use_as == "Acidity Regulator"``. Citric Acid, Trisodium
    Citrate, etc."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=ACIDITY_USE_CATEGORIES,
        error_cls=InvalidAcidityItem,
    )


def _resolve_flavouring_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``flavouring_item_ids`` — picks must carry
    ``use_as == "Flavouring"``."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=FLAVOURING_USE_CATEGORIES,
        error_cls=InvalidFlavouringItem,
    )


def _resolve_colour_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``colour_item_ids`` — picks must carry
    ``use_as == "Colour"``."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=COLOUR_USE_CATEGORIES,
        error_cls=InvalidColourItem,
    )


def _resolve_sweetener_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``sweetener_item_ids`` — picks must carry
    ``use_as == "Sweeteners"``. Powder-only picker; the gummy-base
    catalogue pool is intentionally NOT reused so a sweetener that
    doubles as a bulking agent doesn't sneak through here.
    """

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=SWEETENER_USE_CATEGORIES,
        error_cls=InvalidSweetenerItem,
    )


def _resolve_gelling_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``gelling_item_ids`` — picks must carry
    ``use_as == "Gelling Agent"``. Pectin / gelatin / agar all
    normalise to the same canonical category in the catalogue."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=GELLING_USE_CATEGORIES,
        error_cls=InvalidGellingItem,
    )


def _resolve_premix_sweetener_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``premix_sweetener_item_ids``.

    Reuses the gummy-base catalogue pool — picks must carry
    ``use_as ∈ (Sweeteners, Bulking Agent)``. Distinct error class so
    the frontend can surface "this isn't a valid premix sweetener"
    on the right form field rather than confusing it with a gummy-
    base validation failure."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=PREMIX_SWEETENER_USE_CATEGORIES,
        error_cls=InvalidPremixSweetenerItem,
    )


def _resolve_gummy_base_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve an incoming ``gummy_base_item_ids`` list.

    Returns an empty list when the caller cleared the selection
    (passed ``None`` / ``[]``). Otherwise every id in the list must
    resolve to a non-archived :class:`Item` in the org's
    ``raw_materials`` catalogue whose ``use_as`` sits in
    :data:`GUMMY_BASE_USE_CATEGORIES`. Any other state raises
    :class:`InvalidGummyBaseItem` — we fail the whole save rather
    than drop rejected ids silently so the scientist notices the
    pick they made was off-target.

    Ids are de-duplicated while preserving order so a picker that
    accidentally submits the same id twice still returns a single
    :class:`Item` (the M2M would otherwise collapse it anyway).
    """

    if raw_ids is None:
        return []
    # Tolerate both a flat id and a list for forward/backward compat.
    if isinstance(raw_ids, (str, bytes)) or not hasattr(raw_ids, "__iter__"):
        raw_ids = [raw_ids]
    unique_ids: list[Any] = []
    seen: set[str] = set()
    for value in raw_ids:
        if value in (None, ""):
            continue
        key = str(value)
        if key in seen:
            continue
        seen.add(key)
        unique_ids.append(value)

    if not unique_ids:
        return []

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        raise InvalidGummyBaseItem()

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue=catalogue, id__in=unique_ids, is_archived=False
        )
    }
    resolved: list[Item] = []
    for value in unique_ids:
        item = items_by_id.get(str(value))
        if item is None:
            raise InvalidGummyBaseItem()
        raw_use_as = (item.attributes or {}).get("use_as") or ""
        normalised = normalize_use_as_value(str(raw_use_as))
        if normalised not in GUMMY_BASE_USE_CATEGORIES:
            raise InvalidGummyBaseItem()
        resolved.append(item)
    return resolved


@transaction.atomic
def assign_sales_person(
    *,
    formulation: Formulation,
    sales_person: Any | None,
    actor: Any,
) -> Formulation:
    """Set or clear the project's commercial owner.

    * ``sales_person=None`` clears the assignment.
    * A candidate must hold a :class:`Membership` on the same
      organization as ``formulation``; otherwise
      :class:`SalesPersonNotMember` fires so the view returns a 400.
    * No-ops (assigning the same user already on the project) still
      pass through the audit trail so duplicated writes remain
      traceable — we intentionally keep the contract "every call
      recorded" rather than introducing a silent short-circuit.

    Authorization lives one layer up (the view asserts
    ``formulations.assign_sales_person``). This function is purely
    data integrity + auditing.
    """

    if sales_person is not None:
        is_member = Membership.objects.filter(
            user=sales_person,
            organization=formulation.organization,
        ).exists()
        if not is_member:
            raise SalesPersonNotMember()

    before = snapshot(formulation)
    formulation.sales_person = sales_person
    formulation.updated_by = actor
    formulation.save(update_fields=["sales_person", "updated_by", "updated_at"])
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.assign_sales_person",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


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

    # Snapshot the line set pre-replacement so the audit diff can
    # show exactly which ingredients came and went.
    before_lines = _lines_snapshot(formulation)

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
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_line.replace",
        target=formulation,
        target_type="formulation_line",
        target_id=str(formulation.pk),
        before={"lines": before_lines},
        after={"lines": _lines_snapshot(formulation)},
    )
    return created


def _lines_snapshot(formulation: Formulation) -> list[dict[str, Any]]:
    """Compact snapshot of one formulation's ingredient lines for
    the audit ``before`` / ``after`` payload. Captures the
    business-relevant fields (which item, what claim, in what
    order) without the timestamps and FKs that would pollute the
    diff."""

    return [
        {
            "item_id": str(line.item_id),
            "item_name": line.item.name,
            "label_claim_mg": str(line.label_claim_mg),
            "serving_size_override": line.serving_size_override,
            "display_order": line.display_order,
            "mg_per_serving_cached": (
                str(line.mg_per_serving_cached)
                if line.mg_per_serving_cached is not None
                else None
            ),
            "notes": line.notes,
        }
        for line in formulation.lines.select_related("item").all()
    ]


# ---------------------------------------------------------------------------
# Nutrition + amino acid aggregation — scale per-100g catalogue values
# by each active's mg/serving contribution.
# ---------------------------------------------------------------------------


def _nutrient_per_100g(attributes: dict[str, Any], key: str) -> float | None:
    raw = (attributes or {}).get(key)
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw > 0 else None
    if isinstance(raw, str):
        trimmed = raw.strip().replace(",", ".")
        if not trimmed or trimmed.upper() in {"N/A", "NA", "-"}:
            return None
        try:
            value = float(Decimal(trimmed))
            return value if value > 0 else None
        except (InvalidOperation, ValueError):
            return None
    return None


def _aggregate_nutrient(
    key: str,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> NutrientAggregate:
    per_serving = 0.0
    contributors = 0
    for item, mg in items_with_mg:
        per_100g = _nutrient_per_100g(item.attributes or {}, key)
        if per_100g is None:
            continue
        g_per_serving = float(mg) / 1000.0
        # Catalogue values are per 100g → scale down by the actual
        # grams of this ingredient that end up in one serving.
        per_serving += per_100g * g_per_serving / 100.0
        contributors += 1

    total_weight_g = (
        float(total_weight_mg) / 1000.0
        if total_weight_mg is not None and float(total_weight_mg) > 0
        else 0.0
    )
    per_100g_value = (
        per_serving / total_weight_g * 100.0 if total_weight_g > 0 else 0.0
    )

    return NutrientAggregate(
        key=key,
        per_serving=Decimal(str(per_serving)).quantize(Decimal("0.0001")),
        per_100g=Decimal(str(per_100g_value)).quantize(Decimal("0.0001")),
        contributors=contributors,
    )


def compute_nutrition_panel(
    *,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> tuple[NutrientAggregate, ...]:
    """Sum per-ingredient nutrition contributions into per-serving +
    per-100g-of-product values for each of the eleven nutrition keys.

    Ingredients with missing catalogue data contribute nothing but
    also do not block the sum; ``contributors`` on the returned
    aggregate tracks how many actually had data so the UI can surface
    "based on N of M ingredients".
    """

    items_list = list(items_with_mg)
    return tuple(
        _aggregate_nutrient(key, items_list, total_weight_mg)
        for key in NUTRITION_KEYS
    )


def compute_amino_panel(
    *,
    items_with_mg: Iterable[tuple[Item, Decimal]],
    total_weight_mg: Decimal | None,
) -> tuple[AminoAcidGroup, ...]:
    """Same scaling as :func:`compute_nutrition_panel` but grouped
    into essential / conditionally essential / non-essential blocks,
    matching the ``FINAL - Specification Sheet`` layout."""

    items_list = list(items_with_mg)
    return tuple(
        AminoAcidGroup(
            key=group_key,
            acids=tuple(
                _aggregate_nutrient(acid_key, items_list, total_weight_mg)
                for acid_key in acids
            ),
        )
        for group_key, acids in AMINO_ACID_GROUPS
    )


# ---------------------------------------------------------------------------
# Compliance aggregation — AND over every active line's flag
# ---------------------------------------------------------------------------


def compute_compliance(
    *,
    items: Iterable[Item],
) -> ComplianceResult:
    """Return the AND-aggregated compliance picture for a formulation.

    For each flag the rule is: one non-compliant ingredient taints
    the whole product. The product can only claim a flag when every
    *answered* ingredient is compliant AND at least one ingredient
    answered at all — a formulation built entirely from unanswered
    ingredients returns ``status=None`` so the UI can fade the chip.
    """

    items_list = list(items)
    flag_results: list[ComplianceFlagResult] = []
    for key, label in COMPLIANCE_FLAGS:
        compliant = 0
        non_compliant = 0
        unknown = 0
        for item in items_list:
            value = (item.attributes or {}).get(key)
            decision = normalize_compliance_value(value)
            if decision is True:
                compliant += 1
            elif decision is False:
                non_compliant += 1
            else:
                unknown += 1

        if non_compliant > 0:
            status: bool | None = False
        elif compliant > 0:
            status = True
        else:
            status = None

        flag_results.append(
            ComplianceFlagResult(
                key=key,
                label=label,
                status=status,
                compliant_count=compliant,
                non_compliant_count=non_compliant,
                unknown_count=unknown,
            )
        )
    return ComplianceResult(flags=tuple(flag_results))


# ---------------------------------------------------------------------------
# Allergen aggregation — distinct allergen classes across every active
# ---------------------------------------------------------------------------


def _is_item_allergen(item: Item) -> bool:
    """Read the catalogue's ``allergen`` flag with the same
    case-insensitive leniency as :func:`normalize_compliance_value` —
    accepts ``"Yes"``, ``True``, ``1`` as positive signals and treats
    everything else (including the catalogue's ``"#VALUE!"`` error
    artifacts) as not-an-allergen. Missing data is never promoted to
    "this is an allergen" — silence is not consent."""

    raw = (item.attributes or {}).get("allergen")
    if isinstance(raw, bool) and raw:
        return True
    if isinstance(raw, (int, float)) and bool(raw):
        return True
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered in {"yes", "true", "1"}:
            return True
    # The catalogue ships many rows (wheat, barley, oat-derivatives,
    # milk fractions) where a scientist filled in
    # ``allergen_source = "Cereals containing gluten"`` but left the
    # tri-state ``allergen`` flag blank / "No". A populated source is
    # the more reliable positive signal — an ingredient with a real
    # EU-14 class is an allergen by construction. We keep the flag
    # as an explicit override (if someone sets it to "No" on a
    # borderline extract the source is ignored), so an empty / sentinel
    # source with no flag returns False.
    if _allergen_source_for_item(item):
        return True
    return False


def _allergen_source_for_item(item: Item) -> str:
    """Return the catalogue's ``Allergen Source`` field as a clean
    string. The catalogue uses ``"None"`` as the empty sentinel — we
    collapse that and the spreadsheet ``"#VALUE!"`` artifact to ``""``
    so the frontend does not render ``None`` as if it were a real
    allergen class."""

    raw = (item.attributes or {}).get("allergen_source")
    if not isinstance(raw, str):
        return ""
    trimmed = raw.strip()
    if not trimmed or trimmed.lower() in {"none", "#value!"}:
        return ""
    return trimmed


def compute_allergens(
    *,
    items: Iterable[Item],
) -> FormulationAllergens:
    """Aggregate the EU-14 allergen classes across the product's
    actives.

    Mirrors the workbook's ``TEXTJOIN(", ", TRUE,
    Table13[Allergen Source])`` approach, with one extra guarantee:
    duplicates are deduped so a formulation with two different milk
    proteins surfaces ``["Milk"]`` once, not twice. Sorted
    alphabetically for a stable, copy-paste-friendly output.
    """

    sources: set[str] = set()
    allergen_count = 0
    for item in items:
        if not _is_item_allergen(item):
            continue
        allergen_count += 1
        source = _allergen_source_for_item(item)
        if source:
            sources.add(source)

    return FormulationAllergens(
        sources=tuple(sorted(sources)),
        allergen_count=allergen_count,
    )


# ---------------------------------------------------------------------------
# Ingredient declaration — label-copy string for the product back panel
# ---------------------------------------------------------------------------


def _entry_label_for_item(item: Item) -> str:
    """Prefer the catalogue's ``ingredient_list_name`` (label-friendly
    copy written by R&D); fall back to the raw-material internal name
    if the label copy row is blank. The audit script reports any row
    still falling back so R&D can fill the gaps."""

    attrs = item.attributes or {}
    candidate = attrs.get("ingredient_list_name")
    if isinstance(candidate, str) and candidate.strip():
        return _strip_label_punctuation(candidate)
    return item.name


def _strip_label_punctuation(value: str) -> str:
    """Trim whitespace and the trailing comma R&D leaves on most
    ``ingredient_list_name`` rows (e.g. ``"Caffeine Anhydrous, "``)."""

    return value.strip().rstrip(",").strip()


# Format an mg value for label copy: drop trailing zeros so ``10.0000``
# renders as ``10`` and ``2.5000`` renders as ``2.5`` — matches the
# workbook's spec sheet output.
def _format_label_mg(value: Any) -> str:
    try:
        decimal = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return str(value)
    quantised = decimal.quantize(Decimal("0.0001")).normalize()
    text = format(quantised, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


# Match an "X% Word" marker — captures the percent value, the marker
# word(s), and any trailing punctuation. Bounded by either a comma, a
# closing paren, or end-of-string so neighbouring markers do not bleed
# into each other.
_MARKER_RE = re.compile(
    r"(\d+(?:\.\d+)?)%\s+([A-Za-z][A-Za-z0-9 \-]*?)(?=\s*(?:,|\)|$))"
)


def _scale_marker_percentages(template: str, raw_mg: Decimal) -> str:
    """Inside a templated active label, rewrite ``X% Marker`` segments
    as ``(X*raw_mg/100)mg Marker``.

    Mirrors the workbook's spec-sheet behaviour: a botanical extract
    declared as "Containing 95% Polyphenols, 45% EGCG" with 10 mg of
    raw extract becomes "9.5mg Polyphenols, 4.5mg EGCG". Also drops
    the leading "Containing " connector when present, so the output
    reads as a pure ingredient list.
    """

    raw_float = float(raw_mg)

    def _replace(match: re.Match[str]) -> str:
        percent = float(match.group(1))
        marker = match.group(2).strip()
        scaled = percent * raw_float / 100.0
        return f"{_format_label_mg(scaled)}mg {marker}"

    rewritten = _MARKER_RE.sub(_replace, template)
    # The workbook drops the connector word "Containing" when the rest
    # of the parenthesised clause becomes "<mg> <marker>" rather than
    # "<percent>% <marker>".
    rewritten = re.sub(r"\(\s*Containing\s+", "(", rewritten)
    return rewritten


def instantiate_active_label(
    *,
    nutrition_information_name: Any,
    ingredient_list_name: Any,
    item_name: str,
    raw_mg: Decimal | None,
) -> str:
    """Return the label that appears in the spec sheet's actives table.

    The Valley workbook's convention: when the catalogue provides a
    ``Nutrition information Name`` template containing the ``??mg``
    placeholder, the spec sheet renders that template with ``??``
    replaced by the actual raw extract weight and any ``X% Marker``
    fragments scaled to ``mg`` (e.g. ``95% Polyphenols`` at 10 mg
    becomes ``9.5mg Polyphenols``). When the template is absent or
    contains no placeholder, the simpler ``ingredient_list_name``
    wins so straightforward purity-based actives like
    "Caffeine Anhydrous" still render as a single tidy label.
    """

    template = (
        nutrition_information_name
        if isinstance(nutrition_information_name, str)
        and nutrition_information_name.strip()
        else None
    )

    fallback = (
        _strip_label_punctuation(ingredient_list_name)
        if isinstance(ingredient_list_name, str)
        and ingredient_list_name.strip()
        else item_name
    )

    if template is None or "??" not in template:
        return fallback

    if raw_mg is None:
        return fallback

    raw_decimal = Decimal(str(raw_mg))
    raw_text = _format_label_mg(raw_decimal)
    expanded = template.replace("??mg", f"{raw_text}mg").replace(
        "??", raw_text
    )
    expanded = _scale_marker_percentages(expanded, raw_decimal)
    # Clean up double spaces that sometimes appear when the template
    # had ``of 10:1 Extract`` and the marker rewrite removed
    # intermediate words.
    expanded = re.sub(r" {2,}", " ", expanded).strip()
    return expanded


def build_ingredient_declaration(
    *,
    items_by_external_id: dict[str, Item],
    totals: FormulationTotals,
) -> tuple[str, tuple[IngredientDeclarationEntry, ...]]:
    """Produce the product's ingredient declaration string.

    Output follows the EU 1169/2011 labelling convention:

    * **Actives** (``use_as == "Active"``) are listed individually by
      their label-friendly name, sorted by mg/serving descending.
    * **Non-active items** are grouped by their canonical ``use_as``
      category and rendered as ``"Sweeteners (Xylitol, Maltitol)"``
      so a typical gummy declaration reads:
      ``"Sweeteners (Xylitol, Maltitol), Acidity Regulator (Citric
      Acid), Colour (Beetroot), Flavouring (Natural Strawberry)"``.
    * **Synthetic excipients** (MCC carrier, anticaking agents,
      capsule shell) keep their fixed label and rank by their own
      mg weight — they don't carry a ``use_as`` so they stay
      standalone.

    The category-group position within the final string is driven by
    the heaviest member of the group, so a 1500mg sweetener block
    sits ahead of a 50mg acidity-regulator block regardless of the
    order catalogue items appear.
    """

    entries: list[IngredientDeclarationEntry] = []

    for external_id, mg in totals.line_values.items():
        item = items_by_external_id.get(external_id)
        if item is None:
            continue
        is_allergen = _is_item_allergen(item)
        attrs = item.attributes or {}
        raw_use_as = attrs.get("use_as")
        use_as = (
            normalize_use_as_value(str(raw_use_as)) if raw_use_as else ""
        )
        # Category fallback: an untagged item is treated as an
        # active. Catalogues imported before the ``use_as`` vocab was
        # enforced leave most items blank, and they historically ran
        # as actives — don't silently demote them. Only explicitly
        # non-Active ``use_as`` values bucket into ``excipient``.
        is_non_active = bool(use_as) and use_as != "Active"
        entries.append(
            IngredientDeclarationEntry(
                label=_entry_label_for_item(item),
                mg=mg,
                category=("excipient" if is_non_active else "active"),
                is_allergen=is_allergen,
                allergen_source=(
                    _allergen_source_for_item(item) if is_allergen else ""
                ),
                use_as=use_as,
            )
        )

    excipients = totals.excipients
    if excipients is not None:
        if excipients.mcc_mg and excipients.mcc_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_MCC,
                    mg=excipients.mcc_mg,
                    category="excipient",
                )
            )
        if excipients.dcp_mg is not None and excipients.dcp_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_DCP,
                    mg=excipients.dcp_mg,
                    category="excipient",
                )
            )
        if excipients.gummy_base_rows:
            # Multi-pick blend: emit one entry per picked item so the
            # declaration groups them under their shared ``use_as``
            # category ("Sweeteners (Xylitol, Maltitol)").
            for base_row in excipients.gummy_base_rows:
                if base_row.mg <= 0:
                    continue
                entries.append(
                    IngredientDeclarationEntry(
                        label=base_row.label,
                        mg=base_row.mg,
                        category="excipient",
                        use_as=base_row.use_as or "",
                    )
                )
        elif excipients.gummy_base_mg is not None and excipients.gummy_base_mg > 0:
            # No picked items but a target was set → render a generic
            # "Gummy Base" row so the declaration is still complete.
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_GUMMY_BASE,
                    mg=excipients.gummy_base_mg,
                    category="excipient",
                )
            )
        if excipients.water_mg is not None and excipients.water_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_WATER,
                    mg=excipients.water_mg,
                    category="excipient",
                )
            )
        # Magnesium stearate + silicon dioxide collapse into a single
        # ``Anticaking Agents`` entry — matches the workbook's label
        # copy. Combined mg drives the ingredient-list sort order so
        # the merged entry sits at the right rank rather than each
        # half landing at the bottom on its own tiny weight.
        anticaking_mg = (excipients.mg_stearate_mg or Decimal("0")) + (
            excipients.silica_mg or Decimal("0")
        )
        if anticaking_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_ANTICAKING,
                    mg=anticaking_mg,
                    category="excipient",
                )
            )
        # Powder / gummy flexible rows — capsule/tablet leave this
        # list empty and consume the typed fields above. Each row
        # becomes its own excipient entry on the declaration; the
        # remainder row (carrier / gummy base) sits alongside the
        # rest and gets sorted by weight like every other entry.
        # Per-pick rows carry ``use_as`` (Flavouring / Colour /
        # Glazing Agent / Gelling Agent / Sweeteners) so the EU
        # 1169/2011 grouping renders e.g. "Gelling Agent (Pectin,
        # Agar)" instead of listing each pick standalone. Allergen
        # flags forward through so a gelatin pick still bolds.
        for row in excipients.rows:
            if row.mg is None or row.mg <= 0:
                continue
            entries.append(
                IngredientDeclarationEntry(
                    label=row.label,
                    mg=row.mg,
                    category="excipient",
                    use_as=row.use_as or "",
                    is_allergen=row.is_allergen,
                    allergen_source=row.allergen_source or "",
                )
            )

    if totals.dosage_form == DosageForm.CAPSULE.value and totals.size_key:
        capsule_size = capsule_size_by_key(totals.size_key)
        if capsule_size is not None and capsule_size.shell_weight_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=CAPSULE_SHELL_LABEL,
                    mg=Decimal(str(capsule_size.shell_weight_mg)),
                    category="shell",
                )
            )

    # Dedupe entries that resolve to the same label within the same
    # ``use_as`` group — happens when a scientist picks the same
    # catalogue item in two band pickers (e.g. Maltitol in both
    # ``gummy_base_items`` and ``premix_sweetener_items``). The
    # customer eats one ingredient called "Maltitol", so the EU
    # declaration must list it once with the summed mg. The
    # procurement BOM keeps each source split because it reads
    # ``excipients.rows`` / ``gummy_base_rows`` directly, not this
    # entries list, so Pectin Premix accounting stays untouched.
    deduped_map: dict[tuple[str, str], IngredientDeclarationEntry] = {}
    deduped_order: list[tuple[str, str]] = []
    for entry in entries:
        key = (entry.label, entry.use_as or "")
        if key in deduped_map:
            prev = deduped_map[key]
            deduped_map[key] = IngredientDeclarationEntry(
                label=prev.label,
                mg=prev.mg + entry.mg,
                category=prev.category,
                is_allergen=prev.is_allergen or entry.is_allergen,
                allergen_source=(
                    prev.allergen_source or entry.allergen_source
                ),
                use_as=prev.use_as,
            )
        else:
            deduped_map[key] = entry
            deduped_order.append(key)
    entries = [deduped_map[k] for k in deduped_order]

    declaration = _format_grouped_declaration(entries)
    # Entries list stays sorted by weight for the UI breakdown — only
    # the joined string receives the category grouping.
    entries.sort(key=lambda e: (-float(e.mg), e.label))
    return declaration, tuple(entries)


def _format_grouped_declaration(
    entries: list[IngredientDeclarationEntry],
) -> str:
    """Render the declaration string with EU category grouping.

    Algorithm:

    * Any entry with a non-Active ``use_as`` joins a group keyed by
      that category. Every other entry stays standalone.
    * Within a group, members are sorted by mg descending so the
      heaviest sweetener leads ``"Sweeteners (Xylitol, Maltitol)"``.
    * Groups and standalone entries are interleaved in the final
      string by their leading member's mg, so a group with a 1500mg
      heaviest member sits ahead of a 1000mg standalone active
      regardless of insertion order.
    * EU 1169/2011 art. 21 requires allergenic ingredients to be
      visually emphasised in the list — every ``is_allergen`` entry's
      label is wrapped in ``<b>…</b>``. Renderers that consume this
      string must treat it as HTML (the spec PDF / web view both pass
      it through ``|safe`` / ``dangerouslySetInnerHTML``).
    """

    groups: dict[str, list[IngredientDeclarationEntry]] = {}
    standalone: list[IngredientDeclarationEntry] = []
    for entry in entries:
        if entry.use_as and entry.use_as != "Active":
            groups.setdefault(entry.use_as, []).append(entry)
        else:
            standalone.append(entry)

    def render_label(entry: IngredientDeclarationEntry) -> str:
        escaped = html.escape(entry.label)
        return f"<b>{escaped}</b>" if entry.is_allergen else escaped

    # Each printable chunk is ``(leading_mg, rendered_string)`` so the
    # merge below sorts them together by weight.
    chunks: list[tuple[float, str]] = []

    for entry in standalone:
        chunks.append((float(entry.mg), render_label(entry)))

    for category, members in groups.items():
        members.sort(key=lambda e: (-float(e.mg), e.label))
        leading = float(members[0].mg)
        names = ", ".join(render_label(m) for m in members)
        chunks.append((leading, f"{html.escape(category)} ({names})"))

    chunks.sort(key=lambda c: -c[0])
    return ", ".join(rendered for _, rendered in chunks)


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
        target_fill_weight_mg=formulation.target_fill_weight_mg,
        powder_type=formulation.powder_type or None,
        water_volume_ml=formulation.water_volume_ml,
        gummy_base_items=tuple(
            formulation.gummy_base_items.all().order_by("name")
        ),
        flavouring_items=tuple(
            formulation.flavouring_items.all().order_by("name")
        ),
        colour_items=tuple(
            formulation.colour_items.all().order_by("name")
        ),
        sweetener_items=tuple(
            formulation.sweetener_items.all().order_by("name")
        ),
        glazing_items=tuple(
            formulation.glazing_items.all().order_by("name")
        ),
        gelling_items=tuple(
            formulation.gelling_items.all().order_by("name")
        ),
        premix_sweetener_items=tuple(
            formulation.premix_sweetener_items.all().order_by("name")
        ),
        acidity_items=tuple(
            formulation.acidity_items.all().order_by("name")
        ),
        excipient_overrides=formulation.excipient_overrides or {},
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
        "target_fill_weight_mg": (
            str(formulation.target_fill_weight_mg)
            if formulation.target_fill_weight_mg is not None
            else None
        ),
        "powder_type": formulation.powder_type,
        "water_volume_ml": (
            str(formulation.water_volume_ml)
            if formulation.water_volume_ml is not None
            else None
        ),
        # Per-band gummy excipient overrides — frozen onto the
        # snapshot so a downstream spec-sheet render reproduces the
        # exact percentages the scientist had set at save time, even
        # if they later tweak the formulation again.
        "excipient_overrides": dict(formulation.excipient_overrides or {}),
    }


#: Attribute keys copied from each line's source raw material into the
#: snapshot. F3a's specification sheet renders from snapshots, and a
#: snapshot that omits these fields cannot reproduce the label copy,
#: %NRV column, or nutrition / amino aggregation — so the snapshot
#: carries them verbatim, frozen against whatever the catalogue said
#: at save time.
_SNAPSHOT_ATTRIBUTE_KEYS: tuple[str, ...] = (
    "type",
    "purity",
    "extract_ratio",
    "overage",
    "ingredient_list_name",
    "nutrition_information_name",
    "vegan",
    "organic",
    "halal",
    "kosher",
    "nrv_mg",
    # Allergen handling (V2 template): the ``Allergen`` flag drives the
    # bolded ingredient in the declaration copy and the ``Allergen
    # Source`` field feeds the aggregated "Allergens:" line. Country of
    # origin rides along for procurement / regulatory traceability.
    "allergen",
    "allergen_source",
    "typical_country_of_origin",
    *NUTRITION_KEYS,
    *AMINO_ACID_KEYS,
)


def _snapshot_lines(formulation: Formulation) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for line in formulation.lines.select_related("item").all():
        attributes = line.item.attributes or {}
        snapshot_attributes = {
            key: attributes.get(key) for key in _SNAPSHOT_ATTRIBUTE_KEYS
        }
        lines.append(
            {
                "item_id": str(line.item_id),
                "item_name": line.item.name,
                "item_internal_code": line.item.internal_code,
                "item_attributes": snapshot_attributes,
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
        )
    return lines


def _serialize_nutrition(
    nutrition: tuple[NutrientAggregate, ...],
) -> dict[str, Any]:
    return {
        "rows": [
            {
                "key": n.key,
                "per_serving": str(n.per_serving),
                "per_100g": str(n.per_100g),
                "contributors": n.contributors,
            }
            for n in nutrition
        ],
    }


def _serialize_amino(
    groups: tuple[AminoAcidGroup, ...],
) -> dict[str, Any]:
    return {
        "groups": [
            {
                "key": g.key,
                "acids": [
                    {
                        "key": a.key,
                        "per_serving": str(a.per_serving),
                        "per_100g": str(a.per_100g),
                        "contributors": a.contributors,
                    }
                    for a in g.acids
                ],
            }
            for g in groups
        ],
    }


def _serialize_compliance(result: ComplianceResult) -> dict[str, Any]:
    return {
        "flags": [
            {
                "key": f.key,
                "label": f.label,
                "status": f.status,
                "compliant_count": f.compliant_count,
                "non_compliant_count": f.non_compliant_count,
                "unknown_count": f.unknown_count,
            }
            for f in result.flags
        ],
    }


def _serialize_declaration(
    declaration: str,
    entries: tuple[IngredientDeclarationEntry, ...],
) -> dict[str, Any]:
    return {
        "text": declaration,
        "entries": [
            {
                "label": e.label,
                "mg": str(e.mg),
                "category": e.category,
                "is_allergen": e.is_allergen,
                "allergen_source": e.allergen_source,
            }
            for e in entries
        ],
    }


def _serialize_allergens(allergens: FormulationAllergens) -> dict[str, Any]:
    return {
        "sources": list(allergens.sources),
        "allergen_count": allergens.allergen_count,
    }


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
                "gummy_base_mg": (
                    str(totals.excipients.gummy_base_mg)
                    if totals.excipients.gummy_base_mg is not None
                    else None
                ),
                "water_mg": (
                    str(totals.excipients.water_mg)
                    if totals.excipients.water_mg is not None
                    else None
                ),
                "gummy_base_rows": [
                    {
                        "item_id": row.item_id,
                        "label": row.label,
                        "use_as": row.use_as,
                        "mg": str(row.mg),
                    }
                    for row in totals.excipients.gummy_base_rows
                ],
                "rows": [
                    {
                        "slug": row.slug,
                        "label": row.label,
                        "mg": str(row.mg),
                        "is_remainder": row.is_remainder,
                        "concentration_mg_per_ml": (
                            str(row.concentration_mg_per_ml)
                            if row.concentration_mg_per_ml is not None
                            else None
                        ),
                        "use_as": row.use_as or "",
                        "is_allergen": bool(row.is_allergen),
                        "allergen_source": row.allergen_source or "",
                    }
                    for row in totals.excipients.rows
                ],
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
    """Freeze the formulation's current state into a new version.

    Along with the mg/excipient totals, the snapshot captures the
    compliance aggregation and the ingredient declaration string, so
    historical versions preserve exactly what the label would have
    said at that moment — later catalogue edits cannot rewrite old
    snapshots.
    """

    totals = compute_formulation_totals(formulation=formulation)

    items_by_external_id = {
        str(line.id): line.item
        for line in formulation.lines.select_related("item").all()
    }
    compliance = compute_compliance(items=items_by_external_id.values())
    allergens = compute_allergens(items=items_by_external_id.values())
    declaration_text, declaration_entries = build_ingredient_declaration(
        items_by_external_id=items_by_external_id,
        totals=totals,
    )

    # Build (item, mg) pairs for the nutrition / amino aggregation.
    # Only actives with a computable mg/serving contribute — an
    # ingredient whose mg is ``None`` (missing purity / extract) is
    # silently excluded rather than counted as zero.
    items_with_mg = [
        (items_by_external_id[external_id], mg)
        for external_id, mg in totals.line_values.items()
        if external_id in items_by_external_id and mg is not None
    ]
    nutrition = compute_nutrition_panel(
        items_with_mg=items_with_mg,
        total_weight_mg=totals.total_weight_mg,
    )
    amino = compute_amino_panel(
        items_with_mg=items_with_mg,
        total_weight_mg=totals.total_weight_mg,
    )

    serialized_totals = _serialize_totals(totals)
    serialized_totals["compliance"] = _serialize_compliance(compliance)
    serialized_totals["allergens"] = _serialize_allergens(allergens)
    serialized_totals["declaration"] = _serialize_declaration(
        declaration_text, declaration_entries
    )
    serialized_totals["nutrition"] = _serialize_nutrition(nutrition)
    serialized_totals["amino_acids"] = _serialize_amino(amino)

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
        snapshot_totals=serialized_totals,
        created_by=actor,
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_version.save",
        target=version,
        after={
            "formulation_id": str(formulation.pk),
            "version_number": version.version_number,
            "label": version.label,
        },
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
def set_approved_version(
    *,
    formulation: Formulation,
    actor: Any,
    version_number: int | None,
) -> Formulation:
    """Mark one version as the current "approved" recipe, or clear it.

    ``version_number=None`` wipes the pointer — used when scientists
    want to un-approve without replacing with a new number. When a
    number is provided we verify it corresponds to an existing version
    of *this* formulation so we never point at a sibling's snapshot.
    """

    if version_number is not None:
        exists = formulation.versions.filter(
            version_number=version_number
        ).exists()
        if not exists:
            raise FormulationVersionNotFound()

    before = snapshot(formulation)
    formulation.approved_version_number = version_number
    formulation.updated_by = actor
    formulation.save(
        update_fields=["approved_version_number", "updated_by", "updated_at"]
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.set_approved_version",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


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
        "powder_type",
        "water_volume_ml",
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
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation_version.rollback",
        target=formulation,
        after={
            "rolled_back_to_version_number": version_number,
        },
    )
    return formulation
