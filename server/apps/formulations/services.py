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
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

logger = logging.getLogger(__name__)

from django.db import transaction
from django.db.models import Max, Q, QuerySet

from apps.audit.services import record as record_audit, snapshot
from apps.catalogues.models import INGREDIENT_CATALOGUE_SLUGS, Item
from apps.formulations.constants import (
    ACIDITY_USE_CATEGORIES,
    DEFAULT_STAGE_TEMPLATES,
    AMINO_ACID_GROUPS,
    AMINO_ACID_KEYS,
    ANTI_CAKING_TOTAL_PCT,
    ANTI_CAKING_USE_CATEGORIES,
    CAPSULE_MG_STEARATE_PCT,
    CAPSULE_SHELL_LABEL,
    CAPSULE_SHELL_USE_CATEGORIES,
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
    CARRIER_USE_AS,
    EXCIPIENT_SLUG_ANTICAKING,
    EXCIPIENT_SLUG_CAPSULE_SHELL,
    EXCIPIENT_SLUG_DCP,
    EXCIPIENT_SLUG_GUMMY_BASE,
    EXCIPIENT_SLUG_MCC,
    EXCIPIENT_SLUG_WATER,
    FLAVOURING_USE_CATEGORIES,
    COLOUR_USE_CATEGORIES,
    DCP_CARRIER_USE_CATEGORIES,
    GELLING_USE_CATEGORIES,
    GLAZING_USE_CATEGORIES,
    MCC_CARRIER_USE_CATEGORIES,
    EXCIPIENT_LABEL_WATER,
    GUMMY_BAND_DEFAULT_PCT,
    EXCIPIENT_OVERRIDE_KEYS,
    EXCIPIENT_OVERRIDE_UPPER_BOUND,
    EXCIPIENT_BAND_DEFAULTS,
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
    POWDER_REFERENCE_FILL_WEIGHT_MG,
    POWDER_WATER_DOSE_ATTRIBUTE_KEY,
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
    FormulationStage,
    FormulationVersion,
    ProjectStatus,
    ProjectType,
)
from apps.organizations.models import Membership, Organization


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class FormulationNotFound(Exception):
    code = "formulation_not_found"


class FormulationCodeConflict(Exception):
    code = "formulation_code_conflict"


class ProjectTypeLocked(Exception):
    """Raised when a caller tries to switch ``project_type`` after the
    customer has signed anything on the project (proposal OR spec
    sheet).

    Switching between ``custom`` and ``ready_to_go`` re-shapes the
    workflow — RTG skips trial batch + final specification while
    Custom requires both. Mid-flight conversion would either orphan
    already-signed documents (Custom → RTG loses the trial context
    the customer signed off on) or resurrect stages the customer
    thought were done (RTG → Custom brings back a final spec after
    they signed a draft as the contract). Cleaner mental model: the
    engagement model is fixed at the first customer signature.
    """

    code = "project_type_locked"


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


class InvalidCapsuleShellItem(Exception):
    """Picked capsule shell item is not in the org's ingredient
    catalogues or doesn't carry ``use_as == "Capsule Shell"``. The
    capsule shell picker rejects every other category so a stray
    "Active" or "Bulking Agent" pick never ends up as the shell —
    downstream compute reads the picked shell's attributes.capsule_size
    and attributes.shell_weight_mg, so a wrong pick would silently
    corrupt the fill capacity + shell mass calculation."""

    code = "invalid_capsule_shell_item"


class InvalidMccCarrierItem(Exception):
    """Picked MCC carrier item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Bulking Agent"``. The
    capsule + tablet MCC carrier picker rejects every other category
    so a misplaced "Active" or "Sweeteners" item never lands in the
    structural carrier slot."""

    code = "invalid_mcc_carrier_item"


class InvalidDcpCarrierItem(Exception):
    """Picked DCP carrier item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Bulking Agent"``. Same
    rejection shape as :class:`InvalidMccCarrierItem` — the frontend
    surfaces the distinct code on the dedicated DCP field."""

    code = "invalid_dcp_carrier_item"


class InvalidAntiCakingItem(Exception):
    """Picked anti-caking item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as == "Anti-caking Agent"``. The
    capsule + tablet + powder anti-caking picker rejects every other
    category so a misplaced item never inflates the lubricant slot."""

    code = "invalid_anti_caking_item"


class InvalidPowderCarrierItem(Exception):
    """Picked powder carrier item is not in the org's raw_materials
    catalogue or doesn't carry ``use_as in ("Carrier", "Bulking
    Agent")``. Powder-only picker -- mirrors the MCC carrier picker
    on the capsule + tablet path but emits to its own band so the
    spec sheet reads as 'Carrier (Maltodextrin)' on a powder."""

    code = "invalid_powder_carrier_item"


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


class LeadScientistNotMember(Exception):
    """Candidate user is not a member of the formulation's organization.

    Mirror of :class:`SalesPersonNotMember` for the R&D lead pointer.
    Same cross-tenant guard, same shape on the wire.
    """

    code = "lead_scientist_not_member"


class InvalidCloneMode(Exception):
    """The ``mode`` argument to :func:`clone_formulation` is neither
    ``new`` nor ``replace``. Service-level guard so a bad caller
    surfaces as a 400 rather than a silent fall-through."""

    code = "invalid_clone_mode"


class CloneTargetRequired(Exception):
    """Replace mode invoked without a target formulation. The API
    layer maps this to a 400 with a field-specific code so the
    duplicate modal can surface a focused validation error."""

    code = "clone_target_required"


class CloneTargetNotFound(Exception):
    """The requested target formulation does not exist within the
    source's organization. Same cross-tenant guardrail as the rest of
    the formulation endpoints — we do not differentiate "missing" from
    "in another org" to avoid leaking existence."""

    code = "clone_target_not_found"


class CloneTargetIsSource(Exception):
    """Replace mode cannot point at the source itself — a no-op that
    would otherwise destroy the source's history via the auto-snapshot
    then-overwrite cycle. Caller must pick a different project or
    switch to the ``new`` mode."""

    code = "clone_target_is_source"


class FormulationRTGError(Exception):
    """Raised when a caller tries to publish (or unpublish) a
    formulation to the Ready-to-Go catalog in a way that would
    violate the invariants:

    * Custom (``project_type=custom``) formulations cannot be
      published — the whole point of the RTG track is that the
      recipe is already validated. A Custom project's recipe is
      still under development.
    * Publishing requires a marketing payload (description, base
      price, MOQ >= 1, at least one packaging option). We refuse
      to surface a half-configured card on the customer catalog.

    ``field_errors`` (attached by the caller when relevant) lets
    the API map to a 400 with a per-field errors dict the FE can
    hang against the specific inputs.
    """

    code = "formulation_rtg_error"


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
    purity_override: Decimal | float | None = None,
    overage_override: Decimal | float | None = None,
    extract_ratio_override: Decimal | float | None = None,
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

    ``purity_override`` / ``overage_override`` /
    ``extract_ratio_override`` are per-formulation tweaks that win
    over the catalogue value. ``None`` (the default) keeps the source
    raw material's attribute. Each override is type-coerced through
    :func:`_coerce_float` so the API can pass strings or Decimals.
    """

    claim = float(label_claim_mg)
    if claim <= 0:
        return None
    if serving_size <= 0:
        return None

    per_unit_claim = claim / serving_size
    attributes = item.attributes or {}

    purity_override_f = _coerce_float(purity_override)
    overage_override_f = _coerce_float(overage_override)
    extract_ratio_override_f = _coerce_float(extract_ratio_override)

    if _is_botanical(item):
        extract_ratio = (
            extract_ratio_override_f
            if extract_ratio_override_f is not None
            else _coerce_float(attributes.get("extract_ratio"))
        )
        if extract_ratio is None or extract_ratio <= 0:
            return None
        raw_mg = per_unit_claim / extract_ratio
    else:
        purity = (
            purity_override_f
            if purity_override_f is not None
            else _coerce_float(attributes.get("purity"))
        )
        if purity is None or purity <= 0:
            return None
        raw_mg = per_unit_claim / purity
        overage = (
            overage_override_f
            if overage_override_f is not None
            else _coerce_float(attributes.get("overage"))
        )
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

    ``concentration_mg_per_g_powder`` is populated for powder flavour
    rows that scale linearly with the powder's mass per serving
    (Trisodium Citrate, Citric Acid, etc.) so the UI can show the
    per-gram load next to the computed mg — matches Excel's BOM
    "25 mg per gram of powder × 5 g serving" pattern."""

    slug: str
    label: str
    mg: Decimal
    is_remainder: bool = False
    concentration_mg_per_g_powder: Decimal | None = None
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
class CarrierRow:
    """One pick in the capsule / tablet carrier blend (MCC or DCP).

    Same per-pick shape as :class:`GummyBaseRow` — kept distinct so
    the spec sheet renderer can tell a "structural carrier" row from
    a gummy base row by where it lives on the breakdown, not by the
    type. ``mg`` is the per-pick share (total carrier mg ÷ pick
    count); ``label`` is the picked item's
    ``ingredient_list_name`` with the raw item name as the fallback.
    """

    item_id: str
    label: str
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
    #: Per-pick breakdown of the MCC carrier (capsule + tablet). Empty
    #: when no items were picked — the declaration falls back to the
    #: generic ``EXCIPIENT_LABEL_MCC`` placeholder and the spec sheet
    #: surfaces a soft warning so the scientist knows to firm up the
    #: choice. Total mg always equals :attr:`mcc_mg`.
    mcc_carrier_rows: tuple["CarrierRow", ...] = ()
    #: Per-pick breakdown of the tablet's DCP carrier. Empty on every
    #: non-tablet form and on tablets where no DCP picks were made;
    #: same fallback semantics as :attr:`mcc_carrier_rows`. Total mg
    #: always equals :attr:`dcp_mg`.
    dcp_carrier_rows: tuple["CarrierRow", ...] = ()
    #: Per-pick breakdown of the combined anti-caking band. Empty when
    #: no anti-caking items were picked -- in that case the formulation
    #: ships without any anti-caking and the declaration drops the row
    #: entirely. When picks exist, the 1.4% combined total is split
    #: equally across them and the declaration renders a single
    #: "Anti-caking Agents (picked names)" line. Total mg always
    #: equals ``mg_stearate_mg + silica_mg`` (kept as the combined
    #: band on the new picker, so ``silica_mg`` mirrors the historical
    #: 0.4% split and ``mg_stearate_mg`` mirrors the 1% split when
    #: down-stream code wants the legacy two-field shape).
    anti_caking_rows: tuple["CarrierRow", ...] = ()
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
    #: Stable identifier the spec-sheet override layer uses to pair an
    #: ``excipients_mg`` override with the declaration entry it should
    #: drop or rewrite. Mirrors the ``editableExcipients`` slugs the
    #: override modal exposes (``mcc_mg``, ``dcp_mg``, ``gummy_base_mg``,
    #: ``water_mg``, ``anticaking``, ``gummy_base:<item_id>``, plus the
    #: arbitrary slugs powder / gummy bands assign to flexible rows).
    #: Active line items get ``active:<item_id>`` so future per-active
    #: overrides can target the right entry. Empty for the capsule
    #: shell row and for old snapshots taken before slugs landed —
    #: render-time fallback uses a label heuristic in that case.
    slug: str = ""


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


def _build_carrier_rows(
    *,
    total_mg: Decimal | float,
    items: tuple[Item, ...],
) -> tuple[CarrierRow, ...]:
    """Split a carrier total equally across picked catalogue items and
    return one :class:`CarrierRow` per pick.

    Returns an empty tuple when no items were picked or the total is
    non-positive — the caller renders the generic carrier label in
    that case. Picks contributing zero or negative mg are dropped so
    a tablet whose actives already exceed max weight doesn't emit
    phantom carrier rows.
    """

    total = float(total_mg)
    if total <= 0 or not items:
        return ()

    per_item = total / len(items)
    if per_item <= 0:
        return ()

    rows: list[CarrierRow] = []
    for item in items:
        attrs = item.attributes or {}
        label = (attrs.get("ingredient_list_name") or "").strip()
        if not label:
            label = item.name
        rows.append(
            CarrierRow(
                item_id=str(item.id),
                label=_strip_label_punctuation(label),
                mg=_quantise(per_item),
            )
        )
    return tuple(rows)


#: Substring patterns (case-insensitive) used to classify a picked
#: anti-caking item into the stearate vs silica band so the combined
#: 1.4% only fires when both chemistries are represented. Built from
#: the names actually shipping in the supplement-industry catalogue
#: (Magnesium Stearate, Stearic Acid, Silicon Dioxide, Silica,
#: Fumed Silica). Items that match neither pattern fall back to the
#: lubricant band -- it's the dominant anti-caking chemistry and the
#: scientist can override the breakdown on the spec sheet if needed.
_STEARATE_NAME_PATTERN = re.compile(r"stear", re.IGNORECASE)
_SILICA_NAME_PATTERN = re.compile(r"silic", re.IGNORECASE)


def _classify_anti_caking_picks(
    items: tuple[Item, ...],
) -> tuple[bool, bool]:
    """Return ``(has_stearate_pick, has_silica_pick)`` for the
    anti-caking picker. Mirrors what the spec sheet renders: only the
    bands matched by an actual pick fire, so picking Silicon Dioxide
    alone produces a 0.4% row and nothing else. Items that match
    neither rule default into the stearate (lubricant) band so a
    Talc or Calcium Silicate pick still surfaces a row rather than
    being silently ignored."""

    if not items:
        return (False, False)
    has_stearate = False
    has_silica = False
    has_unmatched = False
    for item in items:
        name = item.name or ""
        if _SILICA_NAME_PATTERN.search(name):
            has_silica = True
        elif _STEARATE_NAME_PATTERN.search(name):
            has_stearate = True
        else:
            has_unmatched = True
    # Unmatched picks fall back to lubricant so they still produce a
    # visible row. We do this only when nothing else matched stearate
    # so a clear "this is a silica family pick + this is an unknown
    # third item" composition still classifies the unknown into the
    # lubricant band, not silently merge it into silica.
    if has_unmatched and not has_stearate:
        has_stearate = True
    return (has_stearate, has_silica)


def _compute_capsule(
    total_active: Decimal,
    requested_size_key: str | None,
    mcc_carrier_items: tuple[Item, ...] = (),
    anti_caking_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
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

    # Anti-caking is opt-in via its own picker, and the contribution
    # is now dynamic: a Silicon-Dioxide-only pick should fire only the
    # 0.4% silica band, a Magnesium-Stearate-only pick only the 1.0%
    # stearate band, and picking both lights up the full 1.4%
    # combined. Each picked item is classified by name (case-
    # insensitive substring match) -- the supplement industry has a
    # narrow vocabulary here so the heuristic is reliable. Anything
    # that matches neither rule defaults to the lubricant band so a
    # stray "talc" or "calcium silicate" pick still produces a row
    # the scientist can see and override.
    active_f = float(total_active)
    has_stearate_pick, has_silica_pick = _classify_anti_caking_picks(
        anti_caking_items
    )
    if has_stearate_pick or has_silica_pick:
        stearate_pct = _resolve_band_pct("mg_stearate", excipient_overrides)
        silica_pct = _resolve_band_pct("silica", excipient_overrides)
        stearate = active_f * stearate_pct if has_stearate_pick else 0.0
        silica = active_f * silica_pct if has_silica_pick else 0.0
        anti_caking_total = stearate + silica
    else:
        anti_caking_total = 0.0
        stearate = 0.0
        silica = 0.0

    # Empty MCC picker means the scientist explicitly opted out of the
    # carrier — produce a formulation with no carrier remainder.
    # Anti-caking can still be present (or not) independently.
    if not mcc_carrier_items:
        total_weight = active_f + stearate + silica
        fits = size.max_weight_mg >= total_weight
        codes_no_carrier: list[str] = []
        if not fits:
            codes_no_carrier.append("cannot_make")
        else:
            codes_no_carrier.extend(
                ("can_make", "less_challenging", "proceed_to_quote")
            )
        anti_caking_rows_no_carrier = _build_carrier_rows(
            total_mg=anti_caking_total,
            items=anti_caking_items,
        )
        excipients_no_carrier = ExcipientBreakdown(
            mg_stearate_mg=_quantise(stearate),
            silica_mg=_quantise(silica),
            mcc_mg=Decimal("0"),
            mcc_carrier_rows=(),
            anti_caking_rows=anti_caking_rows_no_carrier,
        )
        return (
            size.key,
            size.label,
            _quantise(size.max_weight_mg),
            _quantise(total_weight),
            excipients_no_carrier,
            ViabilityResult(
                fits=fits,
                comfort_ok=fits,
                codes=tuple(codes_no_carrier),
            ),
            tuple(warnings),
        )

    mcc = size.max_weight_mg - active_f - stearate - silica
    # Total weight is defined as sum(active, excipients). When MCC is
    # positive this equals max_weight by construction. When MCC would
    # go negative (active + excipients overshoot max) the totals block
    # still reports the true sum so viability can flag "CANNOT MAKE".
    total_weight = active_f + stearate + silica + max(mcc, 0.0)
    if mcc < 0:
        total_weight = active_f + stearate + silica

    fits = size.max_weight_mg >= total_weight
    comfort_ok = fits and mcc >= (active_f * 0.01)
    codes: list[str] = []
    if not fits:
        codes.append("cannot_make")
    else:
        codes.append("can_make")
        if comfort_ok:
            codes.extend(("less_challenging", "proceed_to_quote"))
        else:
            codes.extend(("more_challenging_to_make", "consult_r_and_d"))

    mcc_carrier_rows = _build_carrier_rows(
        total_mg=max(mcc, 0.0),
        items=mcc_carrier_items,
    )
    anti_caking_rows = _build_carrier_rows(
        total_mg=anti_caking_total,
        items=anti_caking_items,
    )

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
        mcc_carrier_rows=mcc_carrier_rows,
        anti_caking_rows=anti_caking_rows,
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
    mcc_carrier_items: tuple[Item, ...] = (),
    dcp_carrier_items: tuple[Item, ...] = (),
    anti_caking_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
) -> tuple[
    str | None, str | None, Decimal | None, Decimal | None,
    ExcipientBreakdown | None, ViabilityResult, tuple[str, ...],
]:
    active = float(total_active)
    warnings: list[str] = []

    # Each band is gated on its own picker now. Anti-caking is opt-in:
    # empty picker -> zero stearate + zero silica. Picking silica only
    # fires the 0.4% silica row; picking stearate only fires the 1.0%
    # row; picking both lights up the full 1.4%. MCC + DCP carriers
    # are independent. A scientist can ship pure actives by leaving
    # all pickers empty; or actives + carrier without anti-caking; or
    # any other combination they need.
    has_stearate_pick, has_silica_pick = _classify_anti_caking_picks(
        anti_caking_items
    )
    if has_stearate_pick or has_silica_pick:
        stearate_pct = _resolve_band_pct("mg_stearate", excipient_overrides)
        silica_pct = _resolve_band_pct("silica", excipient_overrides)
        stearate = active * stearate_pct if has_stearate_pick else 0.0
        silica = active * silica_pct if has_silica_pick else 0.0
        anti_caking_total = stearate + silica
    else:
        anti_caking_total = 0.0
        stearate = 0.0
        silica = 0.0

    dcp_pct = _resolve_band_pct("dcp", excipient_overrides)
    mcc_pct = _resolve_band_pct("mcc", excipient_overrides)
    dcp = active * dcp_pct if dcp_carrier_items else 0.0
    mcc = active * mcc_pct if mcc_carrier_items else 0.0

    total_weight = active + stearate + silica + dcp + mcc

    mcc_carrier_rows = _build_carrier_rows(
        total_mg=mcc, items=mcc_carrier_items
    )
    dcp_carrier_rows = _build_carrier_rows(
        total_mg=dcp, items=dcp_carrier_items
    )
    anti_caking_rows = _build_carrier_rows(
        total_mg=anti_caking_total, items=anti_caking_items
    )

    excipients = ExcipientBreakdown(
        mg_stearate_mg=_quantise(stearate),
        silica_mg=_quantise(silica),
        mcc_mg=_quantise(mcc),
        dcp_mg=_quantise(dcp),
        mcc_carrier_rows=mcc_carrier_rows,
        dcp_carrier_rows=dcp_carrier_rows,
        anti_caking_rows=anti_caking_rows,
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
            tuple(warnings),
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
        tuple(warnings),
    )


def _resolve_band_pct(
    slug: str, overrides: dict[str, Any] | None
) -> float:
    """Pick the effective value for an excipient band.

    Reads ``overrides[slug]`` if it's a positive-or-zero number,
    otherwise falls back to :data:`EXCIPIENT_BAND_DEFAULTS[slug]`. We
    treat any non-numeric, negative, or unknown value as "no override"
    so a stray key from a future build never crashes the math — the
    write-side validator (:func:`_validate_excipient_overrides`)
    rejects malformed payloads up front so by the time we reach this
    helper the data is already known-good. The helper is unit-agnostic:
    callers pass it a percentage band slug (water, acidity, ...) or a
    mg-per-gram-of-powder band slug (powder_trisodium_citrate, ...)
    and the resolved float is the value in that band's native unit.
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
    return EXCIPIENT_BAND_DEFAULTS.get(slug, 0.0)


def _validate_excipient_overrides(value: Any) -> dict[str, float]:
    """Coerce + validate an incoming ``excipient_overrides`` payload.

    * Accepts ``None`` / ``{}`` as "no overrides".
    * Rejects non-dict shapes.
    * Each key must sit in :data:`EXCIPIENT_OVERRIDE_KEYS`.
    * Each value must parse to a non-negative float at or below the
      key's upper bound in :data:`EXCIPIENT_OVERRIDE_UPPER_BOUND`.
      Percentage bands cap at 1.0; mg-per-gram-of-powder bands cap at
      1000.0 (a chemical sanity ceiling, not a chemistry constraint).
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
        if not isinstance(key, str):
            raise InvalidExcipientOverrides()
        # Two shapes accepted: a fixed band slug from
        # ``EXCIPIENT_OVERRIDE_KEYS`` (gummy bands, anti-caking, tablet
        # carriers) OR a per-item rate override keyed by the picked
        # catalogue item's UUID under the ``powder_rate:`` prefix.
        # Per-item overrides drive the powder flavour-system bands
        # (acidity, flavouring, sweetener, colour) -- they let the
        # scientist tune one pick's mg/ml rate on a single formulation
        # without rewriting the catalogue value the rest of the org
        # consumes.
        is_per_item_rate = key.startswith("powder_rate:") and len(key) > len(
            "powder_rate:"
        )
        # ``excipient_mg:<uuid>`` — per-item mg override for one pick in
        # an anti-caking / DCP / MCC band. The band total mg is still
        # computed by the server; this key just tells the client how to
        # split that total across the picked SKUs on display (Ingredients
        # tab, per-stage BOM, spec sheet BOM). Compute doesn't consume
        # the value -- persistence + display only.
        is_per_item_mg = key.startswith("excipient_mg:") and len(key) > len(
            "excipient_mg:"
        )
        if (
            not is_per_item_rate
            and not is_per_item_mg
            and key not in EXCIPIENT_OVERRIDE_KEYS
        ):
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
        # Per-item rates cap at 1000 mg/ml -- way above any
        # chemically sensible loading but high enough that a typo
        # surfaces as an obvious rejection rather than a silent
        # truncation. Per-item mg overrides cap at 100_000 mg (100 g
        # per single pick) -- higher than any realistic band total,
        # so a typo trips the cap, but a legitimate large gummy base
        # override still passes.
        upper = (
            1000.0
            if is_per_item_rate
            else 100_000.0
            if is_per_item_mg
            else EXCIPIENT_OVERRIDE_UPPER_BOUND.get(key, 1.0)
        )
        if num < 0 or num > upper:
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
    anti_caking_items: tuple[Item, ...] = (),
    powder_carrier_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
    default_serving_size: int = 1,
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
    #
    # Powder flavour rows are mg per **gram of finished powder**:
    # multiplying by the serving's powder grams (target_fill_weight_mg
    # × serving_size / 1000) produces the per-serving mg the same way
    # Excel's Formulation Calculation Sheet does (per-gram column ×
    # Serving Size = per-serving mass). Gummies stay on the percentage-
    # of-target shape — both branches now scale linearly with the
    # finished product's mass, so doubling the serving size doubles
    # the flavour load on either form.
    is_powder = dosage_form == DosageForm.POWDER.value
    flavour_rows: list[ExcipientRow] = []

    # Soft warnings accumulated during the powder branch (e.g. an
    # acidity-regulator pick missing its dose-rate attribute). Merged
    # into the final warnings tuple at the end of the function so they
    # surface in the builder alongside the fill-weight checks.
    pre_warnings: list[str] = []

    def _emit_pick_band(
        *,
        block_slug: str,
        block_label: str,
        block_total_mg: float,
        picks: tuple[Item, ...],
        band_use_as: str,
        placeholder_when_empty: bool = True,
        concentration_mg_per_g_powder: Decimal | None = None,
    ) -> None:
        """Emit either per-pick rows or a generic placeholder at the
        block's full mg total. Shared between the powder and gummy
        branches so picker semantics stay identical: pick the same
        catalogue items, get the same per-pick row + label-copy
        treatment, regardless of dosage form.

        ``concentration_mg_per_g_powder`` is propagated from the
        powder preset so each per-pick row still carries the band's
        per-gram load that the FRONTEND uses to render the
        "25 mg/g × 5 g" breakdown next to the row. Empty for gummy
        bands (which scale by percentage of target weight, not by
        per-gram-of-powder).

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
            if concentration_mg_per_g_powder is not None and len(picks) > 0:
                per_item_concentration = (
                    concentration_mg_per_g_powder / Decimal(len(picks))
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
                        concentration_mg_per_g_powder=per_item_concentration,
                    )
                )
        elif placeholder_when_empty:
            flavour_rows.append(
                ExcipientRow(
                    slug=block_slug,
                    label=block_label,
                    mg=_quantise(block_total_mg),
                    concentration_mg_per_g_powder=(
                        concentration_mg_per_g_powder
                    ),
                )
            )

    if is_powder:
        preset = powder_flavour_system_for(powder_type)
        # Powder grams per serving = per-scoop fill weight × scoops
        # per serving. Default to a 5 g sachet reference when the
        # scientist hasn't entered a fill weight yet so a fresh
        # powder still shows the band breakdown rather than zero rows.
        if target_fill_weight_mg is not None and target_fill_weight_mg > 0:
            powder_g_per_serving = float(target_fill_weight_mg) / 1000.0
        else:
            powder_g_per_serving = (
                POWDER_REFERENCE_FILL_WEIGHT_MG / 1000.0
            )
        # ``serving_size`` lives on the formulation header (scoops per
        # serving). For powders it scales the flavour load alongside
        # the scoop weight — two scoops of a 5 g sachet doubles every
        # band, exactly how Excel re-bases when scientists move from
        # one scoop per serving to two.
        scoops = (
            int(default_serving_size)
            if default_serving_size and default_serving_size > 0
            else 1
        )
        powder_g_per_serving *= float(scoops)
        # Every powder excipient band is now opt-in via its picker
        # (acidity / flavouring / sweetener / colour). An empty picker
        # means the band drops out -- no more "auto-fired Trisodium
        # Citrate + Citric Acid + placeholder Sweetener" rows on a
        # formulation where the scientist hasn't said they want them.
        # The hardcoded preset mg/g values still drive the band total
        # so picks at a band fire at the original Excel-derived rate;
        # they just don't emit at all when nothing is picked.
        # Unified per-item dosing for every powder flavour-system
        # band: ACIDITY, FLAVOURING, SWEETENER, COLOUR all scale with
        # the formulation's ``water_volume_ml`` × the catalogue
        # item's ``powder_water_dose_mg_per_ml`` rate. The chemistry
        # is consistent -- the scientist reconstitutes the powder in
        # water, and the final drink's flavour / sweetness / colour
        # intensity is set by the concentration in the reconstituted
        # liquid, not by powder grams. (Anti-caking and Carrier sit
        # outside this loop -- they're structural, not perceptual,
        # and stay scaled to powder mass below.)
        per_item_bands: tuple[
            tuple[str, tuple[Item, ...], str], ...
        ] = (
            ("acidity", acidity_items, "Acidity Regulator"),
            ("flavouring", flavouring_items, "Flavouring"),
            ("sweetener", sweetener_items, "Sweeteners"),
            ("colour", colour_items, "Colour"),
        )
        any_per_item_picks = any(picks for _, picks, _ in per_item_bands)
        water_ml = (
            float(water_volume_ml)
            if water_volume_ml is not None
            else 0.0
        )
        if any_per_item_picks and water_ml <= 0:
            # One shared warning -- the entire flavour system needs a
            # water volume to dose against. Per-pick item names follow
            # below for any picks whose rate is also unset, so the
            # scientist sees both gaps in one pass.
            pre_warnings.append("powder_flavour_water_volume_missing")
        for band_slug, picks, band_use_as in per_item_bands:
            if not picks:
                continue
            for pick in picks:
                pick_attrs = pick.attributes or {}
                # Per-formulation override (``excipient_overrides``)
                # takes precedence over the catalogue's rate so the
                # scientist can tune one pick on this formulation
                # without changing the catalogue value the rest of
                # the org consumes.
                override_key = f"powder_rate:{pick.id}"
                override_rate = (
                    excipient_overrides.get(override_key)
                    if isinstance(excipient_overrides, dict)
                    else None
                )
                if override_rate is None:
                    raw_rate = pick_attrs.get(POWDER_WATER_DOSE_ATTRIBUTE_KEY)
                else:
                    raw_rate = override_rate
                try:
                    rate = (
                        float(raw_rate)
                        if raw_rate not in (None, "")
                        else 0.0
                    )
                except (TypeError, ValueError):
                    rate = 0.0
                if rate <= 0:
                    pre_warnings.append(
                        f"powder_{band_slug}_rate_missing:{pick.name}"
                    )
                    continue
                if water_ml <= 0:
                    # No water volume yet -- the math has nothing to
                    # multiply against. The shared volume warning was
                    # appended once above, so we just skip the row.
                    continue
                pick_label = (
                    pick_attrs.get("ingredient_list_name") or ""
                ).strip() or pick.name
                flavour_rows.append(
                    ExcipientRow(
                        slug=f"{band_slug}:{pick.id}",
                        label=pick_label,
                        mg=_quantise(water_ml * rate),
                        use_as=band_use_as,
                        is_allergen=_is_item_allergen(pick),
                        allergen_source=_allergen_source_for_item(pick),
                        # All four bands share the same unit now
                        # (mg per ml of water), so the per-gram slot
                        # is unused; the FRONTEND renders the rate
                        # hint from ``water_dose_mg_per_ml`` on the
                        # echo instead.
                        concentration_mg_per_g_powder=None,
                    )
                )
        # Anti-caking band -- mirrors the capsule/tablet picker.
        # Empty picker = no anti-caking on the formulation. Stearate-
        # only -> 1.0% of total active; silica-only -> 0.4%; both
        # -> 1.4%. For powders the percentage is taken against the
        # total finished powder mass per serving (per-scoop fill weight
        # × scoops), not the actives sum -- a 500 g hydration sachet
        # with 100 mg of actives would otherwise dose anti-caking at
        # 1.4 mg, which is chemically meaningless. Capsules + tablets
        # retain the actives-based math because their fill *is* mostly
        # actives.
        has_stearate, has_silica = _classify_anti_caking_picks(
            anti_caking_items
        )
        anti_caking_total_mg = 0.0
        if has_stearate or has_silica:
            powder_total_mg = (
                float(target_fill_weight_mg) * float(scoops)
                if target_fill_weight_mg is not None
                and target_fill_weight_mg > 0
                else POWDER_REFERENCE_FILL_WEIGHT_MG * float(scoops)
            )
            stearate_pct = _resolve_band_pct(
                "mg_stearate", excipient_overrides
            )
            silica_pct = _resolve_band_pct("silica", excipient_overrides)
            stearate_mg = (
                powder_total_mg * stearate_pct if has_stearate else 0.0
            )
            silica_mg = (
                powder_total_mg * silica_pct if has_silica else 0.0
            )
            anti_caking_total_mg = stearate_mg + silica_mg
            _emit_pick_band(
                block_slug="anti_caking",
                block_label="Anti-caking Agents",
                block_total_mg=anti_caking_total_mg,
                picks=anti_caking_items,
                band_use_as="Anti-caking Agent",
                placeholder_when_empty=False,
            )
        # Carrier band -- Maltodextrin and similar bulking agents.
        # Fills the remainder of the sachet after the actives + the
        # other bands; mirrors how scientists historically added the
        # carrier as a real catalogue line. When the picker is
        # empty no carrier row emits and the powder may be under-
        # filled (which is the scientist's call).
        if powder_carrier_items and target_fill_weight_mg is not None:
            target = float(target_fill_weight_mg) * float(scoops)
            other_bands = sum(float(row.mg) for row in flavour_rows)
            remainder = (
                target - float(total_active) - other_bands - anti_caking_total_mg
            )
            if remainder > 0:
                _emit_pick_band(
                    block_slug="carrier",
                    block_label="Carrier",
                    block_total_mg=remainder,
                    picks=powder_carrier_items,
                    band_use_as=CARRIER_USE_AS,
                    placeholder_when_empty=False,
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
        if not gummy_base_items:
            # Empty gummy-base picker means the scientist explicitly
            # opted out of any auto-filled gummy matrix — no water,
            # no base. The recipe ships as actives + any picked
            # flavour / sweetener / colour rows only.
            water_mg = Decimal("0")
            gummy_base_mg = Decimal("0")
        else:
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
            tuple(pre_warnings),
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
    # Seed with the soft warnings accumulated during the powder
    # branch (e.g. acidity picks missing a dose rate or water volume).
    # The viability checks below append their own structural warnings
    # without clearing these, so a powder shortfall still surfaces
    # alongside any acidity-rate gaps.
    warnings: list[str] = list(pre_warnings)

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
    lines: Iterable[
        tuple[
            str,
            Item,
            Decimal | float,
            int | None,
            Decimal | None,
            Decimal | None,
            Decimal | None,
        ]
    ],
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
    mcc_carrier_items: tuple[Item, ...] = (),
    dcp_carrier_items: tuple[Item, ...] = (),
    anti_caking_items: tuple[Item, ...] = (),
    powder_carrier_items: tuple[Item, ...] = (),
    excipient_overrides: dict[str, Any] | None = None,
) -> FormulationTotals:
    """Compute the full totals block for a formulation.

    ``lines`` is an iterable of ``(external_id, item, label_claim_mg,
    serving_size_override, purity_override, overage_override,
    extract_ratio_override)`` tuples. ``external_id`` is opaque to
    this function and just flows through to
    ``FormulationTotals.line_values`` so callers can key the computed
    mg values back to their own rows. The override fields default to
    ``None`` (use catalogue value); pass a Decimal to take precedence
    on the per-line cascade.
    """

    total_active = Decimal("0")
    line_values: dict[str, Decimal] = {}
    # Captured so the post-math sweep can warn about line items
    # missing a ``use_as`` classification (the active-vs-excipient
    # split on the spec sheet silently breaks for blank values, so
    # surfacing it as a builder warning lets the scientist fix the
    # catalogue before signing off).
    line_items: list[Item] = []

    for line_tuple in lines:
        # Tolerate the legacy 4-tuple shape so any in-flight caller
        # that still passes ``(id, item, claim, override)`` keeps
        # working — the override fields just default to ``None``.
        if len(line_tuple) == 4:
            external_id, item, label_claim, override = line_tuple
            purity_o = overage_o = extract_o = None
        else:
            (
                external_id,
                item,
                label_claim,
                override,
                purity_o,
                overage_o,
                extract_o,
            ) = line_tuple
        line_items.append(item)
        mg = compute_line(
            item=item,
            label_claim_mg=label_claim,
            serving_size=override if override is not None else default_serving_size,
            purity_override=purity_o,
            overage_override=overage_o,
            extract_ratio_override=extract_o,
        )
        if mg is not None:
            line_values[external_id] = mg
            total_active += mg

    total_active = total_active.quantize(Decimal("0.0001"))

    # Compute the use_as-missing warnings up front so every return
    # path (empty actives, non-math dosage forms, full math) surfaces
    # them. The sweep dedupes by item id so a raw material that
    # appears in two pickers warns once.
    #
    # Pickers vs. attributes:
    #
    # Every picker below is scoped to a specific compliance category
    # (Anti-caking picker only lists Anti-caking Agent items, MCC
    # picker only lists Carrier / Bulking Agent items, ...). So when
    # the operator picks an item via a specific picker, the picker
    # itself tells us the intended ``use_as`` regardless of what the
    # item's own ``attributes.use_as`` says. PSP-mirrored items may
    # arrive with an empty ``attributes.use_as`` (their compliance
    # metadata lives on PSP's ``raw_material_compliance`` side-table
    # and may not have been backfilled onto the wire); when that
    # happens we fall back to the picker-implied category rather than
    # firing a false-positive warning.
    #
    # The mutation below only touches the in-memory Item copy that
    # ``compute_formulation_totals`` holds — the DB row is untouched.
    # A subsequent PSP mirror refresh will overlay the authoritative
    # value from ``attributes.use_as`` (or the compliance bridge) and
    # replace this inference on the next compute pass.
    bucket_implied_use_as: tuple[
        tuple[tuple[Any, ...], str | None], ...
    ] = (
        (tuple(line_items), None),
        (gummy_base_items, GUMMY_BASE_USE_CATEGORIES[0]),
        (flavouring_items, FLAVOURING_USE_CATEGORIES[0]),
        (colour_items, COLOUR_USE_CATEGORIES[0]),
        (sweetener_items, SWEETENER_USE_CATEGORIES[0]),
        (glazing_items, GLAZING_USE_CATEGORIES[0]),
        (gelling_items, GELLING_USE_CATEGORIES[0]),
        (premix_sweetener_items, PREMIX_SWEETENER_USE_CATEGORIES[0]),
        (acidity_items, ACIDITY_USE_CATEGORIES[0]),
        (mcc_carrier_items, MCC_CARRIER_USE_CATEGORIES[0]),
        (dcp_carrier_items, DCP_CARRIER_USE_CATEGORIES[0]),
        (anti_caking_items, ANTI_CAKING_USE_CATEGORIES[0]),
        # Powder Carrier picker shares the Carrier vocabulary.
        (powder_carrier_items, MCC_CARRIER_USE_CATEGORIES[0]),
    )

    use_as_warnings: list[str] = []
    seen_item_ids: set[Any] = set()
    for bucket, implied in bucket_implied_use_as:
        for item in bucket:
            if item.id in seen_item_ids:
                continue
            seen_item_ids.add(item.id)
            attrs = item.attributes or {}
            raw_use_as = attrs.get("use_as")
            value = (
                str(raw_use_as).strip() if raw_use_as is not None else ""
            )
            if not value and implied:
                # Picker context wins — stamp the implied category
                # onto the in-memory item so downstream compute reads
                # a consistent value. The DB row stays untouched.
                item.attributes = {**(item.attributes or {}), "use_as": implied}
                continue
            if not value:
                # Actives bucket: no picker context to infer from.
                # Include the internal code so a scientist with two
                # items of the same display name (e.g. the duplicate
                # row created when an attribute is corrected on a
                # cloned record) can tell from the warning *which*
                # one needs the classification.
                code = (item.internal_code or "").strip()
                label = (
                    f"{item.name} ({code})" if code else item.name
                )
                use_as_warnings.append(f"item_missing_use_as:{label}")

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
            warnings=tuple(use_as_warnings),
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
        ) = _compute_capsule(
            total_active,
            capsule_size_key or None,
            mcc_carrier_items=mcc_carrier_items,
            anti_caking_items=anti_caking_items,
            excipient_overrides=excipient_overrides,
        )
    elif dosage_form == DosageForm.TABLET.value:
        (
            size_key,
            size_label,
            max_weight,
            total_weight,
            excipients,
            viability,
            warnings,
        ) = _compute_tablet(
            total_active,
            tablet_size_key or None,
            mcc_carrier_items=mcc_carrier_items,
            dcp_carrier_items=dcp_carrier_items,
            anti_caking_items=anti_caking_items,
            excipient_overrides=excipient_overrides,
        )
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
            anti_caking_items=anti_caking_items,
            powder_carrier_items=powder_carrier_items,
            excipient_overrides=excipient_overrides,
            default_serving_size=default_serving_size,
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
            warnings=tuple(use_as_warnings),
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
        warnings=tuple(list(warnings) + use_as_warnings),
    )


# ---------------------------------------------------------------------------
# Formulation CRUD
# ---------------------------------------------------------------------------


#: M2M relations the read serializer's echo blocks call ``.all()``
#: on per row. Without prefetching, the formulations list endpoint
#: fires one extra query per (row × relation) -- 12 relations × 50
#: rows = 600 queries before the lines + sales_person fields even
#: start. Listed in one tuple so ``list_formulations`` and any other
#: list caller stay in lock-step with the serializer's shape.
_FORMULATION_LIST_PREFETCH: tuple[str, ...] = (
    "gummy_base_items",
    "flavouring_items",
    "colour_items",
    "sweetener_items",
    "glazing_items",
    "gelling_items",
    "premix_sweetener_items",
    "acidity_items",
    "mcc_carrier_items",
    "dcp_carrier_items",
    "anti_caking_items",
    "powder_carrier_items",
    "lines__item",
)


def list_formulations(
    *,
    organization: Organization,
    search: str | None = None,
    has_open_proposal: bool | None = None,
    statuses: list[str] | None = None,
    sales_person_id: Any = None,
    project_type: str | None = None,
) -> QuerySet[Formulation]:
    """List formulations for an organisation, prefetched for the read
    serializer's echo blocks.

    The serializer renders ~12 M2M picks per row plus the formulation
    lines, the sales_person FK, and the lead_scientist FK; without
    the prefetch + select_related list a 50-item page fires ~1,800
    queries and stalls the connection pool under modest concurrent
    load. With the prefetch the page settles to a handful of queries
    regardless of result-set size.

    ``search`` is an optional, whitespace-trimmed substring matched
    case-insensitively against both ``name`` and ``code``. Empty / blank
    values are ignored so the caller can forward the query parameter
    unconditionally.

    ``has_open_proposal`` filters on the formulation's proposal
    state. The "open" set is everything except ``rejected``:

    * ``draft`` / ``in_review`` / ``approved`` / ``sent`` — live deal
      in flight; another quote would race the first one.
    * ``accepted`` — deal already closed and signed by the client;
      if they want to re-order, the team clones the project rather
      than send a duplicate proposal against the same recipe.

    ``rejected`` is *not* part of the "open" set — those projects
    return to the picker so the team can try again with adjusted
    terms.

    The two branches are deliberately asymmetric because they
    answer different product questions:

    * ``True``  — *project-level* "is any deal live on this recipe?".
      Returns formulations with at least one non-rejected proposal,
      regardless of which spec the proposal attached. Used by
      dashboard / per-project hints that flag a recipe as actively
      being sold.
    * ``False`` — *spec-level* "is at least one director-approved
      spec free for a NEW proposal?". A formulation may already
      have an open proposal on Spec A and still belong here if
      Spec B is approved but not yet bundled into any
      non-rejected proposal. Without that finer check, sales loses
      the picker entry for a project the moment any spec gets
      proposed — even when a second spec is ready to ship.
    * ``None``  — no filter (default).

    The checks run as ``Exists`` subqueries so pagination stays
    accurate and the work stays at the SQL layer.
    """

    queryset = (
        Formulation.objects.filter(organization=organization)
        .select_related("sales_person", "lead_scientist", "organization")
        .prefetch_related(*_FORMULATION_LIST_PREFETCH)
    )
    if search:
        needle = search.strip()
        if needle:
            queryset = queryset.filter(
                Q(name__icontains=needle) | Q(code__icontains=needle)
            )

    # Status / sales-person / project-type filters layer onto whatever
    # ``search`` and ``has_open_proposal`` already narrowed. Unknown
    # values fall through as no-ops so a typo in a manual URL doesn't
    # 400 — same defensive policy as ``has_open_proposal``.
    if statuses:
        # De-dupe + drop blanks; an empty list after cleaning skips
        # the filter entirely (same as not passing it).
        cleaned = [s.strip() for s in statuses if s and s.strip()]
        if cleaned:
            queryset = queryset.filter(project_status__in=cleaned)

    if sales_person_id:
        # Single FK value. Treat the special string ``"unassigned"`` as
        # "rows with no sales person" so the UI can offer that bucket
        # as a discoverable filter without a magic null token.
        if str(sales_person_id).strip().lower() == "unassigned":
            queryset = queryset.filter(sales_person__isnull=True)
        else:
            queryset = queryset.filter(sales_person_id=sales_person_id)

    if project_type:
        cleaned_type = project_type.strip()
        if cleaned_type:
            queryset = queryset.filter(project_type=cleaned_type)

    if has_open_proposal is not None:
        # Lazy import — sibling apps; avoid an import-time cycle.
        # ``Q`` is already imported at module level (line 25); a local
        # re-import here would shadow it for the whole function and
        # break the earlier ``search`` branch with an UnboundLocal.
        from django.db.models import Exists, OuterRef

        from apps.proposals.models import (
            Proposal,
            ProposalLine,
            ProposalStatus,
        )
        from apps.specifications.models import (
            SpecificationSheet,
            SpecificationStatus,
        )

        non_rejected_statuses = [
            value
            for value in ProposalStatus.values
            if value != ProposalStatus.REJECTED.value
        ]

        open_proposals = Proposal.objects.filter(
            formulation_version__formulation=OuterRef("pk"),
        ).exclude(status=ProposalStatus.REJECTED.value)

        if has_open_proposal:
            # Project-level question: "any active deal on this recipe?"
            # Untouched from the original implementation — drives the
            # per-project hint chip ("a proposal is already live on
            # this project").
            queryset = queryset.filter(Exists(open_proposals))
        else:
            # The previous implementation answered "no open proposal
            # on this formulation, anywhere" — which incorrectly
            # excluded a project the moment its first spec got
            # proposed, even when a *second* director-signed spec
            # on the same recipe was sitting there waiting to be
            # bundled into its own quote.
            #
            # Eligibility is now the OR of two cases so neither
            # workflow regresses:
            #
            #   (a) No non-rejected proposal exists on the project
            #       at all — the original "fresh recipe" case. Kept
            #       so projects whose specs were all reverted to
            #       draft (and thus carry no APPROVED spec) stay
            #       picker-visible; sales can still raise a
            #       proposal without attaching a spec.
            #   (b) At least one APPROVED spec on the project is not
            #       yet linked to a non-rejected proposal (via the
            #       legacy OneToOne FK *or* a multi-spec
            #       ``ProposalLine``). This is the bug-fix branch
            #       — a project with Spec A on a sent proposal and
            #       Spec B freshly approved now stays in the picker
            #       so the second quote can attach Spec B.
            busy_spec_ids = (
                SpecificationSheet.objects.filter(
                    Q(proposal__status__in=non_rejected_statuses)
                    | Q(
                        proposal_lines__proposal__status__in=non_rejected_statuses
                    )
                )
                .values("pk")
                .distinct()
            )
            available_specs = SpecificationSheet.objects.filter(
                formulation_version__formulation=OuterRef("pk"),
                status=SpecificationStatus.APPROVED,
            ).exclude(pk__in=busy_spec_ids)
            queryset = queryset.filter(
                ~Exists(open_proposals) | Exists(available_specs)
            )

    return queryset.order_by("-updated_at")


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
    project_type: str = ProjectType.CUSTOM.value,
    psp_finished_product_uuid: Any = None,
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

    # ``project_type`` is trusted after this guard — the model has a
    # DB-level check via ``choices`` but validating at the boundary
    # lets the API return a clean 400 rather than a Django IntegrityError.
    valid_project_types = {choice.value for choice in ProjectType}
    if project_type not in valid_project_types:
        project_type = ProjectType.CUSTOM.value

    # Seed the free-text + compliance cells with per-dosage-form
    # defaults when the caller submitted blanks — gives scientists
    # a sensible draft rather than empty inputs. Non-blank input
    # always wins so the AI-builder / import flows that already
    # know what to write are not overridden.
    from apps.formulations.constants import (
        DEFAULT_TARGET_MARKETS,
        FORMULATION_TEXT_DEFAULTS,
    )

    text_defaults = FORMULATION_TEXT_DEFAULTS.get(dosage_form, {})

    def _str_default(key: str, current: str) -> str:
        if (current or "").strip():
            return current
        raw = text_defaults.get(key, "")
        return raw if isinstance(raw, str) else ""

    directions_of_use = _str_default("directions_of_use", directions_of_use)
    suggested_dosage = _str_default("suggested_dosage", suggested_dosage)
    appearance = _str_default("appearance", appearance)
    disintegration_spec = _str_default("disintegration_spec", disintegration_spec)

    # Compliance / labelling defaults — every product of a given
    # dosage form gets the same regulatory category, warnings block,
    # storage conditions and shelf life until the scientist
    # overrides. Retyping the same EU 1169 boilerplate on every
    # project is where transcription errors creep in.
    regulatory_default = text_defaults.get("regulatory_category", "")
    warnings_default = text_defaults.get("warnings_text", "")
    storage_default = text_defaults.get("storage_conditions", "")
    shelf_life_default = text_defaults.get("shelf_life_months")

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
        project_type=project_type,
        psp_finished_product_uuid=psp_finished_product_uuid or None,
        regulatory_category=(
            regulatory_default if isinstance(regulatory_default, str) else ""
        ),
        warnings_text=(
            warnings_default if isinstance(warnings_default, str) else ""
        ),
        storage_conditions=(
            storage_default if isinstance(storage_default, str) else ""
        ),
        shelf_life_months=(
            shelf_life_default
            if isinstance(shelf_life_default, int)
            else None
        ),
        target_markets=list(DEFAULT_TARGET_MARKETS),
        created_by=actor,
        updated_by=actor,
    )
    seed_default_stages(formulation=formulation)
    record_audit(
        organization=organization,
        actor=actor,
        action="formulation.create",
        target=formulation,
        after=snapshot(formulation),
    )
    return formulation


def seed_default_stages(*, formulation: Formulation) -> list[FormulationStage]:
    """Seed a fresh formulation with just the terminal (finished)
    stage from the dosage form's default template.

    Prior behaviour was to spawn the whole graph (e.g. capsules got
    *Blend → Encapsulate → Bottle → Label* on day one). Scientists
    asked for a cleaner slate — they'd rather see one placeholder
    for the finished stage (which the UI can't let them delete
    anyway) and add intermediate stages by hand as the process
    matures. Liquid / other-solid forms still fall through to an
    empty list because the template map has no entry for them.

    No-op when the formulation already has stages so a rerun of the
    seeder never overwrites edits. Workstation groups aren't matched
    here — that happens either on the FE picker's first render or
    during the push cascade in the PSP client. Returns the newly-
    created stage list.
    """

    if formulation.stages.exists():
        return list(formulation.stages.all())

    template = DEFAULT_STAGE_TEMPLATES.get(formulation.dosage_form) or []
    if not template:
        return []

    # Only the terminal stage — last entry in the template.
    stage_key, name, _workstation_hint = template[-1]
    stage = FormulationStage.objects.create(
        formulation=formulation,
        sort_order=0,
        name=name,
        stage_key=stage_key,
    )
    return [stage]


def _parse_positive_decimal(value: Any, *, default: Decimal) -> Decimal:
    """Coerce a payload value to a positive ``Decimal``. Empty / null /
    invalid / non-positive input falls back to ``default`` so a stray
    ``""`` from the FE doesn't wipe a stage's ``servings_per_output_unit``
    to zero (which would divide-by-zero later in the push cascade)."""

    if value is None or value == "":
        return default
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return default
    return parsed if parsed > 0 else default


@transaction.atomic
def set_formulation_stages(
    *,
    formulation: Formulation,
    stages: list[dict[str, Any]],
    actor: Any,
) -> list[FormulationStage]:
    """Wholesale-replace a formulation's stage list.

    ``stages`` is the full ordered list — every existing stage that
    doesn't appear in the payload is deleted, and each entry is
    upserted by its ``id`` (or created when omitted / unknown). This
    mirrors the "wholesale replace on save" pattern PSP itself uses
    for routing steps, so the two ends of the integration behave the
    same way.

    Lines whose stage disappears fall back to ``stage=NULL`` via the
    ``on_delete=SET_NULL`` FK — they surface in a "no stage" bucket
    on the builder and the operator reassigns.

    Payload shape per stage:

    .. code-block:: python

        {
          "id": "<uuid>",                     # optional; create if omitted
          "sort_order": 0,
          "name": "Powder blend",
          "stage_key": "blend",
          "workstation_group_uuid": "<uuid>|null",
          "workstation_group_name": "Blender",
          "setup_time_min": "5",
          "cycle_time_min": "45",
          "fixed_cost": "0",
          "variable_cost": "0",
          "notes": "...",
        }
    """

    before = snapshot(formulation)
    incoming_ids: set[str] = set()

    # Shift every existing stage's ``sort_order`` into a private
    # high range so the payload can freely renumber without tripping
    # the ``(formulation, sort_order)`` uniqueness constraint mid-
    # update. Reset happens naturally as each row's ``sort_order`` is
    # overwritten below; any survivor left in the high range would
    # indicate a bug in the caller (we assert on it after the loop).
    from django.db.models import F

    formulation.stages.update(sort_order=F("sort_order") + 100_000)

    for index, raw in enumerate(stages):
        raw_id = raw.get("id")
        payload = {
            "sort_order": raw.get("sort_order", index),
            "name": (raw.get("name") or "").strip() or f"Stage {index + 1}",
            "stage_key": raw.get("stage_key") or FormulationStage.StageKey.CUSTOM,
            "workstation_group_uuid": raw.get("workstation_group_uuid") or None,
            "workstation_group_name": (raw.get("workstation_group_name") or "").strip(),
            "operation_description": raw.get("operation_description") or "",
            "setup_time_min": raw.get("setup_time_min"),
            "cycle_time_min": raw.get("cycle_time_min"),
            "fixed_cost": raw.get("fixed_cost"),
            "variable_cost": raw.get("variable_cost"),
            "capacity": raw.get("capacity"),
            "other_fixed_cost": raw.get("other_fixed_cost"),
            "other_variable_cost": raw.get("other_variable_cost"),
            "other_variable_cost_basis": raw.get("other_variable_cost_basis"),
            "worker_psp_uuids": [
                str(u) for u in (raw.get("worker_psp_uuids") or []) if u
            ],
            # PSP identity (phase 1). Type falls back to
            # ``semi_finished``; scientists explicitly set exactly one
            # ``finished_product`` per formulation via the stage form
            # dropdown. Bounds enforced after the loop so an interim
            # invalid payload doesn't half-persist.
            "psp_item_type": (
                raw.get("psp_item_type")
                or "semi_finished"
            ),
            "psp_item_name": (raw.get("psp_item_name") or "").strip()[:200],
            "psp_item_external_sku": (
                raw.get("psp_item_external_sku") or ""
            ).strip(),
            "psp_item_description": (
                raw.get("psp_item_description") or ""
            ).strip(),
            "psp_item_attributes": (
                raw.get("psp_item_attributes")
                if isinstance(raw.get("psp_item_attributes"), dict)
                else {}
            ),
            "psp_item_barcode": (raw.get("psp_item_barcode") or "").strip(),
            "psp_item_stock_uom_uuid": raw.get("psp_item_stock_uom_uuid")
            or None,
            "psp_item_product_family_uuid": raw.get(
                "psp_item_product_family_uuid"
            )
            or None,
            "psp_finished_product_spec": (
                raw.get("psp_finished_product_spec")
                if isinstance(raw.get("psp_finished_product_spec"), dict)
                else {}
            ),
            # How many finished-good servings equal 1 stock-unit of
            # this stage's PSP output. Bridges NPD's per-serving mg
            # values to PSP's per-1-parent-unit BOM convention on the
            # push cascade. Missing / 0 payload falls back to 1.0 so
            # legacy behavior is preserved.
            "servings_per_output_unit": _parse_positive_decimal(
                raw.get("servings_per_output_unit"),
                default=Decimal("1.0000"),
            ),
            "notes": raw.get("notes") or "",
        }
        if payload["psp_item_type"] not in (
            "semi_finished",
            "finished_product",
        ):
            raise ValueError(
                "psp_item_type must be 'semi_finished' or 'finished_product'"
            )

        if raw_id:
            existing = FormulationStage.objects.filter(
                formulation=formulation, id=raw_id
            ).first()
            if existing is not None:
                for field, value in payload.items():
                    setattr(existing, field, value)
                existing.save()
                incoming_ids.add(str(existing.id))
                continue

        created = FormulationStage.objects.create(formulation=formulation, **payload)
        incoming_ids.add(str(created.id))

    # Guard the finished-product stage from accidental removal. It's
    # the project's identity on PSP (linked to
    # ``formulation.psp_finished_product_uuid`` — which anchors
    # sales orders, price lists, labels), and silently auto-promoting
    # a semi to fill the gap would swap the entire product's PSP
    # identity out from under the operator. Reject rather than
    # cascade so the error surfaces in the FE toast.
    if formulation.stages.exists():
        removed_finished_exists = (
            formulation.stages.exclude(id__in=incoming_ids)
            .filter(psp_item_type="finished_product")
            .exists()
        )
        payload_has_finished = any(
            (r.get("psp_item_type") or "").strip() == "finished_product"
            for r in stages
            if isinstance(r, dict)
        )
        if removed_finished_exists and not payload_has_finished:
            raise ValueError(
                "The finished-product stage can't be removed — it's"
                " the project's PSP identity. Convert an existing"
                " stage to finished_product first, or reassign the"
                " finished flag before removing this stage."
            )

    # Capture stages about to be deleted so we can clean up their
    # PSP counterparts after the transaction commits. Only
    # ``semi_finished`` stages with a cached PSP uuid are candidates
    # — the finished-product stage outlives a formulation edit
    # (it may be attached to sales orders, price lists, labels), and
    # stages that were never pushed have no PSP uuid to delete.
    departing_semi_uuids: list[str] = list(
        formulation.stages.exclude(id__in=incoming_ids)
        .filter(
            psp_item_type="semi_finished",
            psp_semi_finished_uuid__isnull=False,
        )
        .values_list("psp_semi_finished_uuid", flat=True)
    )

    # Delete stages that fell out of the payload. Lines FK to the
    # departing rows get ``stage=NULL`` via ``on_delete=SET_NULL``.
    formulation.stages.exclude(id__in=incoming_ids).delete()

    # Exactly-one-finished invariant. Enforced after upsert +
    # cleanup so partial payloads that briefly show 2 finished
    # stages during the loop don't half-fail. Empty stage lists get
    # a pass (a formulation with no stages doesn't need a finished
    # anchor yet).
    finished_count = formulation.stages.filter(
        psp_item_type="finished_product"
    ).count()
    if finished_count > 1:
        raise ValueError(
            "A formulation may have at most one finished_product stage;"
            f" got {finished_count}."
        )
    if finished_count == 0 and formulation.stages.exists():
        # Auto-promote the last stage so the cascade always terminates
        # in a finished product. Safety net for callers that forget to
        # set the flag; the FE dropdown makes this rare.
        last = formulation.stages.order_by("-sort_order").first()
        if last is not None:
            last.psp_item_type = "finished_product"
            last.save(update_fields=["psp_item_type", "updated_at"])

    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.set_stages",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )

    # Auto-sync the cascade to PSP so scientists don't have to hit
    # "Sync now" separately. Silent-degrade: any PSP failure is logged
    # inside push_bom_to_psp; the stage save always succeeds
    # regardless. Deferred to ``on_commit`` so the HTTP round-trip
    # doesn't hold the DB write lock — and so failed PSP calls can't
    # roll back the successful stage upsert.
    def _sync_to_psp() -> None:
        from apps.psp.services import delete_psp_item, push_bom_to_psp

        try:
            push_bom_to_psp(formulation=formulation)
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "set_formulation_stages: PSP push failed for %s (org %s)",
                formulation.pk,
                formulation.organization_id,
            )

        # Clean up PSP semi-finished items for stages the operator
        # just removed from this formulation. delete_psp_item is
        # silent-degrade and safety-gated on the PSP side (refuses
        # when the item is referenced in another BOM, has history,
        # or its external_sku doesn't match the NPD pattern), so a
        # skipped delete is expected and just gets logged.
        if departing_semi_uuids:
            import logging

            log = logging.getLogger(__name__)
            organization = formulation.organization
            for uuid in departing_semi_uuids:
                result = delete_psp_item(
                    organization=organization, uuid=uuid
                )
                if not result.get("deleted"):
                    log.info(
                        "set_formulation_stages: skipped PSP delete for"
                        " item %s (org %s) — reason %s",
                        uuid,
                        organization.pk,
                        result.get("reason"),
                    )

    transaction.on_commit(_sync_to_psp)

    return list(formulation.stages.all())


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
        "psp_finished_product_uuid",
        # Finished-product spec (Setup tab source of truth — the
        # push cascade mirrors these onto the finished stage's PSP
        # spec sub-table).
        "regulatory_category",
        "warnings_text",
        "shelf_life_months",
        "storage_conditions",
        "target_markets",
        "net_quantity",
        "net_quantity_uom_uuid",
        "serving_size_uom_uuid",
        # Phase 4a: warehouse identity + allergens
        "storage_tags",
        "min_stock_qty",
        "target_stock_qty",
        "allergen_uuids",
        "may_contain_allergen_keys",
        "may_contain_justification",
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
    pending_capsule_shell: list[Item] | None = None
    if "capsule_shell_item_ids" in changes:
        pending_capsule_shell = _resolve_capsule_shell_items(
            organization=formulation.organization,
            raw_ids=changes.pop("capsule_shell_item_ids"),
        )
    pending_mcc_carrier: list[Item] | None = None
    if "mcc_carrier_item_ids" in changes:
        pending_mcc_carrier = _resolve_mcc_carrier_items(
            organization=formulation.organization,
            raw_ids=changes.pop("mcc_carrier_item_ids"),
        )
    pending_dcp_carrier: list[Item] | None = None
    if "dcp_carrier_item_ids" in changes:
        pending_dcp_carrier = _resolve_dcp_carrier_items(
            organization=formulation.organization,
            raw_ids=changes.pop("dcp_carrier_item_ids"),
        )
    pending_anti_caking: list[Item] | None = None
    if "anti_caking_item_ids" in changes:
        pending_anti_caking = _resolve_anti_caking_items(
            organization=formulation.organization,
            raw_ids=changes.pop("anti_caking_item_ids"),
        )
    pending_powder_carrier: list[Item] | None = None
    if "powder_carrier_item_ids" in changes:
        pending_powder_carrier = _resolve_powder_carrier_items(
            organization=formulation.organization,
            raw_ids=changes.pop("powder_carrier_item_ids"),
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

    # Lock project_type once the customer has signed anything on the
    # project. See :class:`ProjectTypeLocked` for the rationale. Only
    # fires when the caller actually wants to change the value — a
    # no-op assignment (same string) passes through so bulk-update
    # payloads that echo the current value don't 422.
    incoming_type = changes.get("project_type")
    if (
        incoming_type is not None
        and incoming_type != formulation.project_type
        and _has_customer_signed_anything(formulation)
    ):
        raise ProjectTypeLocked()

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
    if pending_capsule_shell is not None:
        formulation.capsule_shell_items.set(pending_capsule_shell)
    if pending_mcc_carrier is not None:
        formulation.mcc_carrier_items.set(pending_mcc_carrier)
    if pending_dcp_carrier is not None:
        formulation.dcp_carrier_items.set(pending_dcp_carrier)
    if pending_anti_caking is not None:
        formulation.anti_caking_items.set(pending_anti_caking)
    if pending_powder_carrier is not None:
        formulation.powder_carrier_items.set(pending_powder_carrier)
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.update",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


#: Recipe fields the duplicate flow copies from one formulation to
#: another. Project identity (``code``, ``name``, ``project_status``,
#: ``project_type``, ``sales_person``, ``approved_version_number``,
#: timestamps, audit history, versions, trial batches, spec sheets,
#: proposals) is deliberately excluded so duplicating into an existing
#: project preserves what the project IS while overwriting only what
#: it CONTAINS.
_CLONE_RECIPE_FIELDS: tuple[str, ...] = (
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
)


#: M2M pickers copied alongside the scalar recipe fields. Order is not
#: significant — each ``.set()`` call replaces the destination's
#: membership wholesale with the source's, so empty source pickers
#: clear the destination too.
_CLONE_M2M_FIELDS: tuple[str, ...] = (
    "gummy_base_items",
    "flavouring_items",
    "colour_items",
    "sweetener_items",
    "glazing_items",
    "gelling_items",
    "premix_sweetener_items",
    "acidity_items",
    "mcc_carrier_items",
    "dcp_carrier_items",
    "anti_caking_items",
    "powder_carrier_items",
)


def _source_line_inputs(source: "Formulation") -> list[dict[str, Any]]:
    """Project the source formulation's lines into the dict shape
    :func:`replace_lines` accepts. Preserves ``display_order`` so the
    clone renders rows in the same sequence the scientist arranged
    them on the source."""

    rows: list[dict[str, Any]] = []
    for line in source.lines.select_related("item").order_by("display_order", "created_at"):
        rows.append(
            {
                "item_id": str(line.item_id),
                "label_claim_mg": str(line.label_claim_mg),
                "display_order": line.display_order,
                "serving_size_override": line.serving_size_override,
                "purity_override": (
                    str(line.purity_override)
                    if line.purity_override is not None
                    else None
                ),
                "overage_override": (
                    str(line.overage_override)
                    if line.overage_override is not None
                    else None
                ),
                "extract_ratio_override": (
                    str(line.extract_ratio_override)
                    if line.extract_ratio_override is not None
                    else None
                ),
                "notes": line.notes or "",
            }
        )
    return rows


def _apply_recipe_to_target(
    *, source: "Formulation", target: "Formulation"
) -> None:
    """Copy every recipe field from ``source`` onto ``target`` in
    memory. Caller is responsible for saving and replacing the M2M /
    line collections separately so the entire clone runs inside a
    single transaction."""

    for field in _CLONE_RECIPE_FIELDS:
        setattr(target, field, getattr(source, field))
    target.excipient_overrides = dict(source.excipient_overrides or {})


def _copy_m2m_picks(
    *, source: "Formulation", target: "Formulation"
) -> None:
    """Replace each M2M picker on ``target`` with the source's
    membership. Empty source picker clears the target."""

    for field in _CLONE_M2M_FIELDS:
        target_manager = getattr(target, field)
        source_manager = getattr(source, field)
        target_manager.set(list(source_manager.all()))


@transaction.atomic
def clone_formulation(
    *,
    source: Formulation,
    actor: Any,
    mode: str,
    new_code: str | None = None,
    new_name: str | None = None,
    target_formulation: Formulation | None = None,
) -> Formulation:
    """Duplicate the source formulation's recipe.

    Two modes:

    * ``mode == "new"`` — create a brand-new ``Formulation`` row in the
      source's organisation with the supplied ``new_code`` /
      ``new_name``. Every recipe field, M2M picker, and ingredient
      line is copied. Project identity (``project_status``,
      ``sales_person``, version history, trial batches, spec sheets,
      proposals) is NOT carried — those belong to a project, not a
      recipe.

    * ``mode == "replace"`` — overwrite ``target_formulation``'s recipe
      with the source's. The target's identity (code, name, status,
      owner, history) stays intact; only the recipe payload changes.
      The target's current state is **auto-snapshotted** into a new
      :class:`FormulationVersion` BEFORE the overwrite so the user can
      roll back if they regret the replace.

    Both modes run in a single transaction — partial failures roll
    back so the database never ends up with a half-cloned project."""

    if mode == "new":
        code_value = (new_code or "").strip()
        name_value = (new_name or "").strip()
        if not name_value:
            # Re-use the code-required error semantics for a blank
            # name — surfaces the same field-level validation flow on
            # the frontend rather than a generic exception.
            raise FormulationCodeRequired()
        # ``create_formulation`` handles code blank/duplicate validation
        # and the dosage-form + capsule/tablet size sanity checks.
        new_formulation = create_formulation(
            organization=source.organization,
            actor=actor,
            name=name_value,
            code=code_value,
            description=source.description,
            dosage_form=source.dosage_form,
            capsule_size=source.capsule_size,
            tablet_size=source.tablet_size,
            serving_size=source.serving_size,
            servings_per_pack=source.servings_per_pack,
            directions_of_use=source.directions_of_use,
            suggested_dosage=source.suggested_dosage,
            appearance=source.appearance,
            disintegration_spec=source.disintegration_spec,
            target_fill_weight_mg=source.target_fill_weight_mg,
            powder_type=source.powder_type,
            water_volume_ml=source.water_volume_ml,
        )
        new_formulation.excipient_overrides = dict(
            source.excipient_overrides or {}
        )
        new_formulation.save(update_fields=["excipient_overrides"])
        _copy_m2m_picks(source=source, target=new_formulation)
        line_inputs = _source_line_inputs(source)
        if line_inputs:
            replace_lines(
                formulation=new_formulation, actor=actor, lines=line_inputs
            )
        record_audit(
            organization=source.organization,
            actor=actor,
            action="formulation.clone",
            target=new_formulation,
            after={
                "mode": "new",
                "source_id": str(source.pk),
                "source_code": source.code,
            },
        )
        return new_formulation

    if mode == "replace":
        if target_formulation is None:
            raise CloneTargetRequired()
        if target_formulation.organization_id != source.organization_id:
            # Same cross-tenant guardrail as the rest of the
            # formulations API — never reveal whether the id exists
            # in another org.
            raise CloneTargetNotFound()
        if target_formulation.pk == source.pk:
            raise CloneTargetIsSource()

        # Auto-snapshot the target's current state so the scientist
        # can roll back if they regret the replace. Failing this
        # would dead-end the user; let any underlying exception
        # propagate and roll back the whole transaction.
        save_version(
            formulation=target_formulation,
            actor=actor,
            label="Auto-snapshot before duplicate",
        )

        before = snapshot(target_formulation)
        _apply_recipe_to_target(source=source, target=target_formulation)
        target_formulation.updated_by = actor
        target_formulation.save(
            update_fields=(
                *_CLONE_RECIPE_FIELDS,
                "excipient_overrides",
                "updated_by",
                "updated_at",
            )
        )
        _copy_m2m_picks(source=source, target=target_formulation)
        line_inputs = _source_line_inputs(source)
        # Always call ``replace_lines`` — even an empty list clears
        # the target's existing lines, which is the correct outcome
        # when cloning from a source that has no actives yet.
        replace_lines(
            formulation=target_formulation, actor=actor, lines=line_inputs
        )
        record_audit(
            organization=source.organization,
            actor=actor,
            action="formulation.clone",
            target=target_formulation,
            before=before,
            after={
                "mode": "replace",
                "source_id": str(source.pk),
                "source_code": source.code,
            },
        )
        return target_formulation

    raise InvalidCloneMode()


def _has_customer_signed_anything(formulation: Formulation) -> bool:
    """True when a customer has signed any proposal or spec sheet on
    this project. Used by :func:`update_formulation` to lock the
    ``project_type`` field once the engagement model has physically
    left the building — see :class:`ProjectTypeLocked`.

    Imports live inside the function to dodge the formulations →
    (proposals | specifications) → formulations circular import that
    happens if either app is loaded top-level from here.
    """
    from apps.proposals.models import Proposal
    from apps.specifications.models import SpecificationSheet

    signed_proposal = Proposal.objects.filter(
        formulation_version__formulation=formulation,
        customer_signed_at__isnull=False,
    ).exists()
    if signed_proposal:
        return True

    signed_sheet = SpecificationSheet.objects.filter(
        formulation_version__formulation=formulation,
        customer_signed_at__isnull=False,
    ).exists()
    return signed_sheet


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

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue__organization=organization,
            catalogue__slug__in=INGREDIENT_CATALOGUE_SLUGS,
            id__in=unique_ids,
            is_archived=False,
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

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue__organization=organization,
            catalogue__slug__in=INGREDIENT_CATALOGUE_SLUGS,
            id__in=unique_ids,
            is_archived=False,
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


def _resolve_capsule_shell_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``capsule_shell_item_ids`` — picks must
    carry ``use_as == "Capsule Shell"``. Used by the capsule dosage
    form's shell picker to swap the hardcoded "Capsule Shell
    (Hypromellose)" placeholder for real catalogue items.

    Downstream compute reads the picked shell's
    ``attributes.capsule_size`` for fill capacity and
    ``attributes.shell_weight_mg`` for the mass the declaration
    attributes to the shell row.
    """

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=CAPSULE_SHELL_USE_CATEGORIES,
        error_cls=InvalidCapsuleShellItem,
    )


def _resolve_mcc_carrier_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``mcc_carrier_item_ids`` — picks must carry
    ``use_as == "Bulking Agent"``. Used by the capsule + tablet MCC
    pickers to swap the hardcoded "Microcrystalline Cellulose
    (Carrier)" placeholder for real catalogue items."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=MCC_CARRIER_USE_CATEGORIES,
        error_cls=InvalidMccCarrierItem,
    )


def _resolve_dcp_carrier_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``dcp_carrier_item_ids``. Same ``Bulking
    Agent`` filter as the MCC carrier — DCP is a structural filler
    in the same canonical category. Tablet-only picker; capsules
    ignore any DCP picks because their excipient math has no DCP
    line."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=DCP_CARRIER_USE_CATEGORIES,
        error_cls=InvalidDcpCarrierItem,
    )


def _resolve_anti_caking_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``anti_caking_item_ids`` — picks must carry
    ``use_as == "Anti-caking Agent"``. Capsule + tablet + powder
    picker; empty picker means the formulation ships without any
    anti-caking band."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=ANTI_CAKING_USE_CATEGORIES,
        error_cls=InvalidAntiCakingItem,
    )


def _resolve_powder_carrier_items(
    *,
    organization: Organization,
    raw_ids: Any,
) -> list[Item]:
    """Resolve incoming ``powder_carrier_item_ids`` — picks must carry
    ``use_as in ("Carrier", "Bulking Agent")``. Powder-only picker;
    fills the remainder of the sachet after actives + other bands."""

    return _resolve_use_as_picks(
        organization=organization,
        raw_ids=raw_ids,
        allowed_categories=MCC_CARRIER_USE_CATEGORIES,
        error_cls=InvalidPowderCarrierItem,
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

    items_by_id = {
        str(item.id): item
        for item in Item.objects.filter(
            catalogue__organization=organization,
            catalogue__slug__in=INGREDIENT_CATALOGUE_SLUGS,
            id__in=unique_ids,
            is_archived=False,
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


@transaction.atomic
def assign_lead_scientist(
    *,
    formulation: Formulation,
    lead_scientist: Any | None,
    actor: Any,
) -> Formulation:
    """Set or clear the project's R&D lead.

    Mirror of :func:`assign_sales_person`. Same membership guard,
    same audit contract, same no-op pass-through. Authorization
    lives one layer up (``formulations.assign_lead_scientist``).
    """

    if lead_scientist is not None:
        is_member = Membership.objects.filter(
            user=lead_scientist,
            organization=formulation.organization,
        ).exists()
        if not is_member:
            raise LeadScientistNotMember()

    before = snapshot(formulation)
    formulation.lead_scientist = lead_scientist
    formulation.updated_by = actor
    formulation.save(
        update_fields=["lead_scientist", "updated_by", "updated_at"]
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.assign_lead_scientist",
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

    # Ingredients can come from either the org's ``raw_materials``
    # catalogue OR its lazily-created ``psp_mirror`` catalogue (which
    # the PSP-integration mirror populates on pick). Both are
    # functionally raw materials — the mirror is just an origin tag.
    # ``INGREDIENT_CATALOGUE_SLUGS`` centralises the whitelist so a
    # future third source (customer-supplied? proprietary blend?) is
    # a one-line addition.
    item_ids = [line["item_id"] for line in lines]
    items_by_id = {
        str(i.id): i
        for i in Item.objects.filter(
            catalogue__organization=formulation.organization,
            catalogue__slug__in=INGREDIENT_CATALOGUE_SLUGS,
            id__in=item_ids,
        )
    }
    for line in lines:
        if str(line["item_id"]) not in items_by_id:
            raise RawMaterialNotInOrg()

    # Resolve stage FKs — each ``stage_id`` in the payload must point
    # to a stage on THIS formulation (never someone else's). Unknown
    # ids fall back to null so a stale FE cache doesn't hard-fail the
    # whole save; the line surfaces in the "no stage" bucket for the
    # operator to reassign.
    stage_ids = {
        str(line["stage_id"]) for line in lines if line.get("stage_id")
    }
    known_stage_ids = (
        set(
            str(sid)
            for sid in formulation.stages.filter(id__in=stage_ids).values_list(
                "id", flat=True
            )
        )
        if stage_ids
        else set()
    )

    # Snapshot the line set pre-replacement so the audit diff can
    # show exactly which ingredients came and went.
    before_lines = _lines_snapshot(formulation)

    FormulationLine.objects.filter(formulation=formulation).delete()

    def _to_decimal(value: Any) -> Decimal | None:
        if value is None or value == "":
            return None
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError):
            return None

    created: list[FormulationLine] = []
    for index, data in enumerate(lines):
        item = items_by_id[str(data["item_id"])]
        claim = Decimal(str(data["label_claim_mg"]))
        override = data.get("serving_size_override")
        purity_o = _to_decimal(data.get("purity_override"))
        overage_o = _to_decimal(data.get("overage_override"))
        extract_o = _to_decimal(data.get("extract_ratio_override"))
        mg = compute_line(
            item=item,
            label_claim_mg=claim,
            serving_size=override if override is not None else formulation.serving_size,
            purity_override=purity_o,
            overage_override=overage_o,
            extract_ratio_override=extract_o,
        )
        raw_stage_id = data.get("stage_id")
        stage_id = (
            str(raw_stage_id)
            if raw_stage_id and str(raw_stage_id) in known_stage_ids
            else None
        )
        # ``source_kind`` from the payload wins over the model
        # default so Routing-tab manual picks keep their ``manual``
        # marker across replace_lines wipes. Empty / unknown values
        # fall through to the default ``active``.
        raw_source_kind = data.get("source_kind")
        source_kind = (
            raw_source_kind
            if raw_source_kind
            in {
                FormulationLine.SOURCE_KIND_ACTIVE,
                FormulationLine.SOURCE_KIND_MANUAL,
                FormulationLine.SOURCE_KIND_BAND_PICK,
            }
            else FormulationLine.SOURCE_KIND_ACTIVE
        )
        # Stage-scoped ratio. ``none`` (or missing) keeps the legacy
        # actives semantic where the row is driven by ``label_claim_mg``;
        # any other mode swaps that model for a per-stage ratio the FE
        # resolves into per-1-finished-unit qty on save + push.
        raw_ratio_mode = data.get("stage_ratio_mode")
        ratio_mode = (
            raw_ratio_mode
            if raw_ratio_mode
            in {
                FormulationLine.STAGE_RATIO_MODE_NONE,
                FormulationLine.STAGE_RATIO_MODE_PER_UNIT,
                FormulationLine.STAGE_RATIO_MODE_PERCENT_OF_MASS,
            }
            else FormulationLine.STAGE_RATIO_MODE_NONE
        )
        ratio_value = _to_decimal(data.get("stage_ratio_value"))
        # ``band_key`` only makes sense on band picks. Silently drop
        # it for other source_kind values so a fat-fingered payload
        # can't pollute an active line with an excipient band tag.
        raw_band_key = data.get("band_key")
        valid_band_keys = {
            choice for choice, _ in FormulationLine.BAND_KEY_CHOICES
        }
        band_key = (
            raw_band_key
            if source_kind == FormulationLine.SOURCE_KIND_BAND_PICK
            and raw_band_key in valid_band_keys
            else None
        )
        created.append(
            FormulationLine.objects.create(
                formulation=formulation,
                item=item,
                display_order=data.get("display_order", index),
                label_claim_mg=claim,
                serving_size_override=override,
                purity_override=purity_o,
                overage_override=overage_o,
                extract_ratio_override=extract_o,
                mg_per_serving_cached=mg,
                notes=data.get("notes", ""),
                stage_id=stage_id,
                source_kind=source_kind,
                band_key=band_key,
                stage_ratio_mode=ratio_mode,
                stage_ratio_value=ratio_value,
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
    # Recipe work has begun: first non-empty line set auto-advances
    # ``concept`` → ``in_development``. Wiping the line list later
    # leaves the chip alone (forward-only).
    if created:
        _maybe_advance_project_status(
            formulation=formulation,
            target_status=ProjectStatus.IN_DEVELOPMENT.value,
            actor=actor,
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
            # Polymorphic identity: local-sourced lines audit via
            # the FK id; PSP-sourced lines via the PSP UUID. Same
            # slot in the payload so downstream diff tooling stays
            # source-agnostic.
            "item_id": line.effective_item_reference,
            "item_source": line.item_source,
            "item_name": line.effective_item_name,
            "label_claim_mg": str(line.label_claim_mg),
            "serving_size_override": line.serving_size_override,
            "purity_override": (
                str(line.purity_override)
                if line.purity_override is not None
                else None
            ),
            "overage_override": (
                str(line.overage_override)
                if line.overage_override is not None
                else None
            ),
            "extract_ratio_override": (
                str(line.extract_ratio_override)
                if line.extract_ratio_override is not None
                else None
            ),
            "display_order": line.display_order,
            "mg_per_serving_cached": (
                str(line.mg_per_serving_cached)
                if line.mg_per_serving_cached is not None
                else None
            ),
            "notes": line.notes,
            "stage_ratio_mode": line.stage_ratio_mode,
            "stage_ratio_value": (
                str(line.stage_ratio_value)
                if line.stage_ratio_value is not None
                else None
            ),
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


def derive_ingredient_allergens(
    *,
    formulation: Formulation,
) -> dict[str, list[str]]:
    """Return the union of EU 1169 allergens declared on this
    formulation's picked ingredients — the auto-fill source for the
    finished-product allergen declaration on the Setup tab.

    Reads ``Item.attributes.allergen_keys`` +
    ``Item.attributes.allergen_uuids`` off every :class:`FormulationLine`
    and unions them into a single sorted-unique pair. Both lists are
    populated on the PSP-mirror path
    (:func:`apps.psp.services._flatten_psp_attributes`); locally-
    authored items without allergen metadata contribute nothing.

    The return shape is a plain dict so the serializer can splat it
    into the API payload without a wrapper class:

    .. code-block:: python

        {
            "keys": ["gluten", "milk"],
            "uuids": ["...", "..."],
        }

    Scientists then see the derived set pre-checked on the allergen
    matrix + can flag additional allergens (override) or unflag
    something the auto-derivation over-approximated. The manual
    override lives on :attr:`Formulation.allergen_uuids`; this
    function just computes the *suggestion*.
    """

    keys: set[str] = set()
    uuids: set[str] = set()
    for line in formulation.lines.select_related("item").all():
        attrs = getattr(line.item, "attributes", {}) or {}
        for k in attrs.get("allergen_keys", []) or []:
            if isinstance(k, str) and k:
                keys.add(k)
        for u in attrs.get("allergen_uuids", []) or []:
            if isinstance(u, str) and u:
                uuids.add(u)
    return {
        "keys": sorted(keys),
        "uuids": sorted(uuids),
    }


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

    Priority — matches R&D's workbook convention where
    ``Nutrition information Name`` is the canonical spec-sheet label:

    1. **Botanical template** — if ``nutrition_information_name``
       contains the ``??mg`` placeholder, expand it with the actual
       raw-powder weight and scale any ``X% Marker`` fragments to
       mg (e.g. ``95% Polyphenols`` at 10 mg becomes ``9.5mg
       Polyphenols``).
    2. **Plain nutrition name** — when the field is non-empty and
       carries no template, use it directly. R&D fills this with the
       clean spec-sheet label (e.g. ``L-Leucine`` for the row whose
       raw name is ``L-Leucine (95%)(DC grade)(5% HPMC)``).
    3. **Ingredient list name** — fallback when nutrition name is
       blank. Cleaned of trailing commas the EU declaration string
       leaves behind.
    4. **Raw item name** — last-resort when both label fields are
       missing on the catalogue row.
    """

    nin_text = (
        nutrition_information_name
        if isinstance(nutrition_information_name, str)
        and nutrition_information_name.strip()
        else ""
    )
    iln_text = (
        ingredient_list_name
        if isinstance(ingredient_list_name, str)
        and ingredient_list_name.strip()
        else ""
    )

    has_template = "??" in nin_text

    # 1. Botanical template — expand with the raw-powder weight.
    if has_template and raw_mg is not None:
        raw_decimal = Decimal(str(raw_mg))
        raw_text = _format_label_mg(raw_decimal)
        expanded = nin_text.replace("??mg", f"{raw_text}mg").replace(
            "??", raw_text
        )
        expanded = _scale_marker_percentages(expanded, raw_decimal)
        # Clean up double spaces that sometimes appear when the
        # template had ``of 10:1 Extract`` and the marker rewrite
        # removed intermediate words.
        expanded = re.sub(r" {2,}", " ", expanded).strip()
        return expanded

    # 2. Plain non-template ``nutrition_information_name`` — the
    #    canonical clean spec-sheet label R&D fills in.
    if nin_text and not has_template:
        return _strip_label_punctuation(nin_text)

    # 3. ``ingredient_list_name`` fallback.
    if iln_text:
        return _strip_label_punctuation(iln_text)

    # 4. Last resort: the raw catalogue name.
    return item_name


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
                slug=f"active:{item.id}",
            )
        )

    excipients = totals.excipients
    if excipients is not None:
        # MCC carrier — per-pick rows when the scientist picked
        # specific items; otherwise the generic placeholder so legacy
        # capsule / tablet formulations keep rendering. The warning
        # path (``mcc_carrier_unpicked``) flags the soft fallback in
        # the viability strip; the declaration still emits the row.
        if excipients.mcc_carrier_rows:
            for row in excipients.mcc_carrier_rows:
                if row.mg <= 0:
                    continue
                entries.append(
                    IngredientDeclarationEntry(
                        label=row.label,
                        mg=row.mg,
                        category="excipient",
                        slug=EXCIPIENT_SLUG_MCC,
                        # Group every carrier pick under a single
                        # ``Carrier (Brand A, Brand B)`` block in the
                        # joined declaration string — mirrors the EU
                        # 1169 grouped phrasing the gummy base /
                        # sweetener / flavouring blocks already use.
                        use_as=CARRIER_USE_AS,
                    )
                )
        elif excipients.mcc_mg and excipients.mcc_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_MCC,
                    mg=excipients.mcc_mg,
                    category="excipient",
                    slug=EXCIPIENT_SLUG_MCC,
                )
            )
        # DCP carrier (tablet only) — same per-pick / fallback shape.
        if excipients.dcp_carrier_rows:
            for row in excipients.dcp_carrier_rows:
                if row.mg <= 0:
                    continue
                entries.append(
                    IngredientDeclarationEntry(
                        label=row.label,
                        mg=row.mg,
                        category="excipient",
                        slug=EXCIPIENT_SLUG_DCP,
                        use_as=CARRIER_USE_AS,
                    )
                )
        elif excipients.dcp_mg is not None and excipients.dcp_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_DCP,
                    mg=excipients.dcp_mg,
                    category="excipient",
                    slug=EXCIPIENT_SLUG_DCP,
                )
            )
        if excipients.gummy_base_rows:
            # Multi-pick blend: emit one entry per picked item so the
            # declaration groups them under their shared ``use_as``
            # category ("Sweeteners (Xylitol, Maltitol)"). Per-pick
            # slugs match the ``gummy_base:<item_id>`` keys the
            # override modal exposes for individual control.
            for base_row in excipients.gummy_base_rows:
                if base_row.mg <= 0:
                    continue
                entries.append(
                    IngredientDeclarationEntry(
                        label=base_row.label,
                        mg=base_row.mg,
                        category="excipient",
                        use_as=base_row.use_as or "",
                        slug=f"gummy_base:{base_row.item_id}",
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
                    slug=EXCIPIENT_SLUG_GUMMY_BASE,
                )
            )
        if excipients.water_mg is not None and excipients.water_mg > 0:
            entries.append(
                IngredientDeclarationEntry(
                    label=EXCIPIENT_LABEL_WATER,
                    mg=excipients.water_mg,
                    category="excipient",
                    slug=EXCIPIENT_SLUG_WATER,
                )
            )
        # Magnesium stearate + silicon dioxide collapse into a single
        # ``Anticaking Agents`` entry — matches the workbook's label
        # copy. Combined mg drives the ingredient-list sort order so
        # the merged entry sits at the right rank rather than each
        # half landing at the bottom on its own tiny weight. When the
        # scientist picked specific anti-caking items the bracketed
        # names follow the base label so the spec sheet reads
        # ``Anticaking Agents (Magnesium Stearate, Silicon Dioxide)``.
        anticaking_mg = (excipients.mg_stearate_mg or Decimal("0")) + (
            excipients.silica_mg or Decimal("0")
        )
        if anticaking_mg > 0:
            picked_names = [
                row.label for row in (excipients.anti_caking_rows or ())
            ]
            label = (
                f"{EXCIPIENT_LABEL_ANTICAKING} ({', '.join(picked_names)})"
                if picked_names
                else EXCIPIENT_LABEL_ANTICAKING
            )
            entries.append(
                IngredientDeclarationEntry(
                    label=label,
                    mg=anticaking_mg,
                    category="excipient",
                    slug=EXCIPIENT_SLUG_ANTICAKING,
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
            # Suppress placeholder rows that emit when the scientist
            # hasn't picked specific items for a band — the math
            # layer reserves the mass in ``flavour_total`` for the
            # gummy-base remainder calc, but a bare "Glazing Agent"
            # / "Premix Sweetener" line on the customer-facing label
            # is just internal terminology with no real ingredient
            # behind it. Per-pick rows (``<band>:<item_id>``) keep
            # flowing through — they render as the picked ingredient
            # names and merge under their EU ``use_as`` group.
            if row.slug in {
                "premix_sweetener",
                "glazing",
                "acidity",
                "flavouring",
                "colour",
            }:
                continue
            entries.append(
                IngredientDeclarationEntry(
                    label=row.label,
                    mg=row.mg,
                    category="excipient",
                    use_as=row.use_as or "",
                    is_allergen=row.is_allergen,
                    allergen_source=row.allergen_source or "",
                    slug=row.slug or "",
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
                    slug=EXCIPIENT_SLUG_CAPSULE_SHELL,
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
            line.purity_override,
            line.overage_override,
            line.extract_ratio_override,
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
        mcc_carrier_items=tuple(
            formulation.mcc_carrier_items.all().order_by("name")
        ),
        dcp_carrier_items=tuple(
            formulation.dcp_carrier_items.all().order_by("name")
        ),
        anti_caking_items=tuple(
            formulation.anti_caking_items.all().order_by("name")
        ),
        powder_carrier_items=tuple(
            formulation.powder_carrier_items.all().order_by("name")
        ),
        excipient_overrides=formulation.excipient_overrides or {},
    )


# ---------------------------------------------------------------------------
# Version snapshots
# ---------------------------------------------------------------------------


def _snapshot_metadata(formulation: Formulation) -> dict[str, Any]:
    """Freeze every recoverable field on the Formulation row into a
    JSON-friendly dict. Everything here must round-trip through
    ``rollback_to_version`` so a scientist recovers the exact state
    they committed. Missing fields silently drop from history — the
    long-standing rollback complaint ("target markets disappeared
    after I restored v27") was every Setup / M2M / stage field being
    off this list. Add new mutable fields here on the same PR that
    adds them to the model."""

    def _decimal_str(value: Any) -> str | None:
        return str(value) if value is not None else None

    def _m2m_ids(manager: Any) -> list[str]:
        return [str(pk) for pk in manager.values_list("id", flat=True)]

    return {
        # ---- Core identity + dosage-form scaffold ----
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
        "target_fill_weight_mg": _decimal_str(
            formulation.target_fill_weight_mg
        ),
        "powder_type": formulation.powder_type,
        "water_volume_ml": _decimal_str(formulation.water_volume_ml),
        # Per-band gummy excipient overrides — frozen onto the
        # snapshot so a downstream spec-sheet render reproduces the
        # exact percentages the scientist had set at save time, even
        # if they later tweak the formulation again.
        "excipient_overrides": dict(formulation.excipient_overrides or {}),
        # ---- Setup / finished-product spec ----
        "regulatory_category": formulation.regulatory_category,
        "warnings_text": formulation.warnings_text,
        "shelf_life_months": formulation.shelf_life_months,
        "storage_conditions": formulation.storage_conditions,
        "target_markets": list(formulation.target_markets or []),
        "net_quantity": _decimal_str(formulation.net_quantity),
        "net_quantity_uom_uuid": (
            str(formulation.net_quantity_uom_uuid)
            if formulation.net_quantity_uom_uuid is not None
            else None
        ),
        "serving_size_uom_uuid": (
            str(formulation.serving_size_uom_uuid)
            if formulation.serving_size_uom_uuid is not None
            else None
        ),
        "storage_tags": list(formulation.storage_tags or []),
        "min_stock_qty": _decimal_str(formulation.min_stock_qty),
        "target_stock_qty": _decimal_str(formulation.target_stock_qty),
        "allergen_uuids": [
            str(u) for u in (formulation.allergen_uuids or [])
        ],
        "may_contain_allergen_keys": list(
            formulation.may_contain_allergen_keys or []
        ),
        "may_contain_justification": formulation.may_contain_justification,
        # ---- M2M picker selections (id lists) ----
        # Each picker row lives as an M2M against catalogues.Item.
        # Snapshotting the id list means rollback can rebuild the
        # exact same picks via ``.set()``. Items may have been
        # deleted from the catalogue since the snapshot; restore
        # silently drops ids that no longer resolve.
        "gummy_base_item_ids": _m2m_ids(formulation.gummy_base_items),
        "acidity_item_ids": _m2m_ids(formulation.acidity_items),
        "flavouring_item_ids": _m2m_ids(formulation.flavouring_items),
        "colour_item_ids": _m2m_ids(formulation.colour_items),
        "sweetener_item_ids": _m2m_ids(formulation.sweetener_items),
        "glazing_item_ids": _m2m_ids(formulation.glazing_items),
        "gelling_item_ids": _m2m_ids(formulation.gelling_items),
        "premix_sweetener_item_ids": _m2m_ids(
            formulation.premix_sweetener_items
        ),
        "capsule_shell_item_ids": _m2m_ids(formulation.capsule_shell_items),
        "mcc_carrier_item_ids": _m2m_ids(formulation.mcc_carrier_items),
        "dcp_carrier_item_ids": _m2m_ids(formulation.dcp_carrier_items),
        "anti_caking_item_ids": _m2m_ids(formulation.anti_caking_items),
        "powder_carrier_item_ids": _m2m_ids(formulation.powder_carrier_items),
    }


#: Attribute keys copied from each line's source raw material into the
#: snapshot. F3a's specification sheet renders from snapshots, and a
#: snapshot that omits these fields cannot reproduce the label copy,
#: %NRV column, or nutrition / amino aggregation — so the snapshot
#: carries them verbatim, frozen against whatever the catalogue said
#: at save time.
_SNAPSHOT_ATTRIBUTE_KEYS: tuple[str, ...] = (
    "type",
    # Functional role (Active, Sweeteners, Bulking Agent, ...). Drives
    # the spec sheet's actives / excipients split and the EU 1169
    # declaration grouping. Persisted in the snapshot so a frozen
    # version stays internally consistent even if the source catalogue
    # row is later retagged.
    "use_as",
    # Per-item powder rate -- the math reads this off each picked
    # item and interprets the unit by ``use_as`` (mg/ml of water for
    # Acidity, mg/g of powder for Flavouring / Sweetener / Colour).
    # Frozen into snapshots so versions reproduce identical mg even
    # if the catalogue value is later retuned.
    POWDER_WATER_DOSE_ATTRIBUTE_KEY,
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


def _snapshot_stages(formulation: Formulation) -> list[dict[str, Any]]:
    """Freeze the production-stage graph into a JSON-friendly list.

    Every FormulationStage field that ``set_formulation_stages`` reads
    on write is captured, plus the cached PSP round-trip uuids
    (``psp_semi_finished_uuid``, ``psp_bom_uuid``) so rollback keeps
    the linkage to PSP without needing a fresh push cascade.

    Order matches ``sort_order``; the index is the stable key used by
    line-level ``stage_index`` references so downstream restore can
    remap ``line.stage_id`` after stages are re-created with fresh
    ids.
    """

    def _decimal_str(value: Any) -> str | None:
        return str(value) if value is not None else None

    def _uuid_str(value: Any) -> str | None:
        return str(value) if value is not None else None

    stages = list(formulation.stages.all().order_by("sort_order"))
    out: list[dict[str, Any]] = []
    for stage in stages:
        out.append(
            {
                "sort_order": stage.sort_order,
                "name": stage.name,
                "stage_key": stage.stage_key,
                "workstation_group_uuid": _uuid_str(
                    stage.workstation_group_uuid
                ),
                "workstation_group_name": stage.workstation_group_name,
                "operation_description": stage.operation_description,
                "setup_time_min": _decimal_str(stage.setup_time_min),
                "cycle_time_min": _decimal_str(stage.cycle_time_min),
                "fixed_cost": _decimal_str(stage.fixed_cost),
                "variable_cost": _decimal_str(stage.variable_cost),
                "capacity": _decimal_str(stage.capacity),
                "other_fixed_cost": _decimal_str(stage.other_fixed_cost),
                "other_variable_cost": _decimal_str(
                    stage.other_variable_cost
                ),
                "other_variable_cost_basis": _decimal_str(
                    stage.other_variable_cost_basis
                ),
                "worker_psp_uuids": [
                    str(u) for u in (stage.worker_psp_uuids or [])
                ],
                # PSP identity — all mirror push inputs. Restored so
                # a rollback + fresh push writes the SAME external_sku
                # / description / attributes back to PSP.
                "psp_item_type": stage.psp_item_type,
                "psp_item_name": stage.psp_item_name,
                "psp_item_external_sku": stage.psp_item_external_sku,
                "psp_item_description": stage.psp_item_description,
                "psp_item_attributes": dict(stage.psp_item_attributes or {}),
                "psp_item_barcode": stage.psp_item_barcode,
                "psp_item_stock_uom_uuid": _uuid_str(
                    stage.psp_item_stock_uom_uuid
                ),
                "psp_item_product_family_uuid": _uuid_str(
                    stage.psp_item_product_family_uuid
                ),
                "psp_finished_product_spec": dict(
                    stage.psp_finished_product_spec or {}
                ),
                "servings_per_output_unit": _decimal_str(
                    stage.servings_per_output_unit
                ),
                "notes": stage.notes,
                # PSP round-trip uuids — cached identifiers pointing at
                # PSP's item / BOM rows the last push landed on. Kept
                # in the snapshot so a rollback stays linked to the
                # same PSP records; without them the next push would
                # create duplicate PSP items.
                "psp_semi_finished_uuid": _uuid_str(
                    stage.psp_semi_finished_uuid
                ),
                "psp_bom_uuid": _uuid_str(stage.psp_bom_uuid),
            }
        )
    return out


def _snapshot_lines(formulation: Formulation) -> list[dict[str, Any]]:
    # Precompute stage-id → sort_order map so each line snapshot can
    # carry a stable ``stage_index`` reference. On rollback, stages
    # are wiped + re-created with fresh uuids; the index remaps the
    # line's stage assignment to the newly-created stage row. Without
    # this every rolled-back line lands with ``stage=NULL`` and the
    # operator has to re-route by hand on the Routing tab.
    stage_index_by_id: dict[str, int] = {
        str(stage.id): int(stage.sort_order)
        for stage in formulation.stages.all()
    }
    lines: list[dict[str, Any]] = []
    for line in formulation.lines.select_related("item").all():
        # Polymorphic read: local-sourced lines pull from the FK'd
        # Item row; PSP-sourced lines pull from the snapshot
        # captured at pick time. The rest of the snapshot logic
        # stays source-agnostic — it operates on the ``attributes``
        # dict shape.
        attributes = line.effective_item_attributes
        snapshot_attributes = {
            key: attributes.get(key) for key in _SNAPSHOT_ATTRIBUTE_KEYS
        }
        stage_id_str = str(line.stage_id) if line.stage_id else None
        stage_index = (
            stage_index_by_id.get(stage_id_str)
            if stage_id_str
            else None
        )
        lines.append(
            {
                "item_id": line.effective_item_reference,
                "item_source": line.item_source,
                "item_name": line.effective_item_name,
                "item_internal_code": line.effective_item_internal_code,
                "item_attributes": snapshot_attributes,
                "display_order": line.display_order,
                "label_claim_mg": str(line.label_claim_mg),
                "serving_size_override": line.serving_size_override,
                "purity_override": (
                    str(line.purity_override)
                    if line.purity_override is not None
                    else None
                ),
                "overage_override": (
                    str(line.overage_override)
                    if line.overage_override is not None
                    else None
                ),
                "extract_ratio_override": (
                    str(line.extract_ratio_override)
                    if line.extract_ratio_override is not None
                    else None
                ),
                "mg_per_serving": (
                    str(line.mg_per_serving_cached)
                    if line.mg_per_serving_cached is not None
                    else None
                ),
                "notes": line.notes,
                "stage_ratio_mode": line.stage_ratio_mode,
                "stage_ratio_value": (
                    str(line.stage_ratio_value)
                    if line.stage_ratio_value is not None
                    else None
                ),
                # Line's source_kind + band_key so band-pick rows
                # survive rollback (rollback re-materialises band
                # picks directly from the snapshot; the wizard-
                # routing endpoint doesn't rebuild them the same
                # way if we only restore actives).
                "source_kind": line.source_kind,
                "band_key": line.band_key,
                # Which stage was this line routed to at save time?
                # Index into ``snapshot_stages`` (stable across the
                # delete + recreate rebuild during rollback). ``None``
                # means unrouted / no stage graph.
                "stage_index": stage_index,
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
                # ``use_as`` lets the spec-sheet override layer rebuild
                # the EU 1169/2011 grouped declaration text after a
                # drop/update without losing the "Sweeteners (Xylitol,
                # Maltitol)" phrasing.
                "use_as": e.use_as,
                # ``slug`` pairs each entry with the ``excipients_mg``
                # override key the modal exposes so an override on
                # ``mcc_mg`` finds the right row to drop / rewrite.
                "slug": e.slug,
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
                "mcc_carrier_rows": [
                    {
                        "item_id": row.item_id,
                        "label": row.label,
                        "mg": str(row.mg),
                    }
                    for row in totals.excipients.mcc_carrier_rows
                ],
                "dcp_carrier_rows": [
                    {
                        "item_id": row.item_id,
                        "label": row.label,
                        "mg": str(row.mg),
                    }
                    for row in totals.excipients.dcp_carrier_rows
                ],
                "anti_caking_rows": [
                    {
                        "item_id": row.item_id,
                        "label": row.label,
                        "mg": str(row.mg),
                    }
                    for row in totals.excipients.anti_caking_rows
                ],
                "rows": [
                    {
                        "slug": row.slug,
                        "label": row.label,
                        "mg": str(row.mg),
                        "is_remainder": row.is_remainder,
                        "concentration_mg_per_g_powder": (
                            str(row.concentration_mg_per_g_powder)
                            if row.concentration_mg_per_g_powder is not None
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
    stage_boms: dict[str, list[dict[str, Any]]] | None = None,
    is_auto: bool = False,
) -> FormulationVersion:
    """Freeze the formulation's current state into a new version.

    Along with the mg/excipient totals, the snapshot captures the
    compliance aggregation and the ingredient declaration string, so
    historical versions preserve exactly what the label would have
    said at that moment — later catalogue edits cannot rewrite old
    snapshots.

    ``stage_boms`` — optional FE-computed per-stage BOM snapshot,
    keyed by stage uuid. When present it's persisted verbatim as
    :attr:`FormulationVersion.snapshot_stage_boms` and also flows
    into the PSP push cascade as a stage-BOM override so PSP
    receives exactly what NPD shows on each stage card. Missing
    payloads persist ``{}`` and the push falls back to the
    per-stage line derivation.
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
    normalised_stage_boms: dict[str, list[dict[str, Any]]] = {}
    if isinstance(stage_boms, dict):
        for stage_uuid, rows in stage_boms.items():
            if not isinstance(rows, list):
                continue
            normalised_stage_boms[str(stage_uuid)] = [
                row for row in rows if isinstance(row, dict)
            ]

    # Capture whether the formulation passed the "builder complete"
    # readiness gate at save time so the create-spec-sheet dropdown
    # can hide snapshots that were saved mid-edit. Auto-drafts skip
    # the compute — they're internal restore points, not commits.
    is_complete = False
    if not is_auto:
        from apps.formulations.overview import _compute_stage_gates

        gates = _compute_stage_gates(formulation)
        is_complete = bool(gates.builder_complete)

    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=highest + 1,
        label=label,
        snapshot_metadata=_snapshot_metadata(formulation),
        snapshot_lines=_snapshot_lines(formulation),
        snapshot_stages=_snapshot_stages(formulation),
        snapshot_totals=serialized_totals,
        snapshot_stage_boms=normalised_stage_boms,
        is_auto=is_auto,
        is_complete=is_complete,
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
    # Auto-versions are silent snapshots for the History tab's
    # Activity revert flow — they fire on every ``Save draft`` so
    # scientists can rewind to any point. Skipping the PSP push here
    # keeps PSP quiet on those (otherwise every keystroke-batch would
    # spam the integration). Named ``Save version`` clicks still push.
    if is_auto:
        return version

    # Push the fresh BOM snapshot to PSP if the formulation is
    # linked to a finished product. Silent-degrade — the push
    # service already swallows every PspError and logs it, so a
    # PSP outage doesn't block the version save. Called outside
    # any transaction on purpose: the local save is authoritative;
    # PSP eventually catches up on the next successful push.
    from apps.psp.services import push_bom_to_psp

    try:
        # Use the FE-computed per-stage snapshot as the PSP push
        # override so each stage's PSP BOM matches what NPD's stage
        # card holds (actives + excipient bands + prior-semi link).
        # Falls back to the ORM-line derivation for stages the FE
        # didn't include (or when the payload is empty).
        push_bom_to_psp(
            formulation=formulation,
            stage_bom_overrides=normalised_stage_boms or None,
        )
    except Exception:
        # Defensive belt-and-braces — the service should already
        # swallow everything, but if something slips through we
        # don't want the save flow to inherit the failure.
        logger.exception(
            "push_bom_to_psp bubbled an unexpected exception for "
            "formulation %s",
            formulation.pk,
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


#: Forward-only ranking for the project roadmap chip. Statuses not in
#: this map (``discontinued``) are excluded from auto-advance: that
#: state has to be a deliberate operator decision, never an
#: implicit side effect.
_PROJECT_STATUS_RANK: dict[str, int] = {
    ProjectStatus.CONCEPT.value: 0,
    ProjectStatus.IN_DEVELOPMENT.value: 1,
    ProjectStatus.PILOT.value: 2,
    ProjectStatus.APPROVED.value: 3,
}


def _maybe_advance_project_status(
    *,
    formulation: Formulation,
    target_status: str,
    actor: Any,
) -> bool:
    """Forward-only auto-advance for the project roadmap chip.

    Pushes ``formulation.project_status`` to ``target_status`` only
    when both the current and target sit in
    :data:`_PROJECT_STATUS_RANK` and the target ranks strictly higher
    than the current value. Returns ``True`` when an advance fired
    (so callers can short-circuit a second audit row if they want).

    The auto layer is intentionally narrow:

    * **Forward only.** Never demotes. A scientist who manually
      bumped a project to ``approved`` for testing won't see it slip
      back to ``pilot`` because a trial batch was created later.
    * **Skips discontinued.** A discontinued project ignores every
      auto-advance call — restarting it is an explicit re-status
      decision, not a side effect of someone touching a line.
    * **Skip-ahead allowed.** First trial batch on a ``concept``
      project jumps straight to ``pilot`` (target is what matters,
      not the intervening steps). Same rule for
      ``set_approved_version`` going ``concept`` → ``approved``.

    Audit row uses the ``formulation.auto_advance_status`` action so
    operators can filter / suppress it separately from manual
    transitions in the audit log.
    """

    current = formulation.project_status
    if current == ProjectStatus.DISCONTINUED.value:
        return False
    if target_status not in _PROJECT_STATUS_RANK:
        return False
    if current not in _PROJECT_STATUS_RANK:
        return False
    if _PROJECT_STATUS_RANK[target_status] <= _PROJECT_STATUS_RANK[current]:
        return False

    before = snapshot(formulation)
    formulation.project_status = target_status
    formulation.updated_by = actor
    formulation.save(
        update_fields=["project_status", "updated_by", "updated_at"]
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.auto_advance_status",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return True


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

    Under the customer-pipeline model this is mostly called
    automatically by the spec sheet flow: every time a sheet hits
    ``status=approved`` (director signature), the spec service calls
    this to pin its version as the formulation's quotable snapshot.
    The function deliberately does **not** advance the project
    roadmap chip — that's driven by customer-side signatures
    (``accept_as_customer`` on draft / final sheets), not by the
    scientist's internal commit.
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


#: Scalar Formulation fields that ``rollback_to_version`` restores
#: verbatim from ``snapshot_metadata``. Missing keys in the snapshot
#: silently skip so pre-migration versions restore cleanly with
#: whatever they DID capture and leave the rest untouched. Add new
#: mutable model fields to _snapshot_metadata AND this list on the
#: same PR that adds them to the model.
_ROLLBACK_SCALAR_FIELDS: tuple[str, ...] = (
    # Identity + dosage-form scaffold (originals)
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
    "target_fill_weight_mg",
    # Setup / finished-product spec (14 additions)
    "regulatory_category",
    "warnings_text",
    "shelf_life_months",
    "storage_conditions",
    "target_markets",
    "net_quantity",
    "net_quantity_uom_uuid",
    "serving_size_uom_uuid",
    "storage_tags",
    "min_stock_qty",
    "target_stock_qty",
    "allergen_uuids",
    "may_contain_allergen_keys",
    "may_contain_justification",
)


#: Mapping ``snapshot_metadata`` key → M2M manager attribute on
#: Formulation. Restored via ``.set(items)`` after resolving the
#: id list to Item instances scoped to the formulation's org.
_ROLLBACK_M2M_FIELDS: tuple[tuple[str, str], ...] = (
    ("gummy_base_item_ids", "gummy_base_items"),
    ("acidity_item_ids", "acidity_items"),
    ("flavouring_item_ids", "flavouring_items"),
    ("colour_item_ids", "colour_items"),
    ("sweetener_item_ids", "sweetener_items"),
    ("glazing_item_ids", "glazing_items"),
    ("gelling_item_ids", "gelling_items"),
    ("premix_sweetener_item_ids", "premix_sweetener_items"),
    ("capsule_shell_item_ids", "capsule_shell_items"),
    ("mcc_carrier_item_ids", "mcc_carrier_items"),
    ("dcp_carrier_item_ids", "dcp_carrier_items"),
    ("anti_caking_item_ids", "anti_caking_items"),
    ("powder_carrier_item_ids", "powder_carrier_items"),
)


#: Stage fields ``rollback_to_version`` restores when rebuilding the
#: production stage graph from ``snapshot_stages``. Missing keys on
#: a pre-migration snapshot silently fall to the model default.
_ROLLBACK_STAGE_FIELDS: tuple[str, ...] = (
    "sort_order",
    "name",
    "stage_key",
    "workstation_group_uuid",
    "workstation_group_name",
    "operation_description",
    "setup_time_min",
    "cycle_time_min",
    "fixed_cost",
    "variable_cost",
    "capacity",
    "other_fixed_cost",
    "other_variable_cost",
    "other_variable_cost_basis",
    "worker_psp_uuids",
    "psp_item_type",
    "psp_item_name",
    "psp_item_external_sku",
    "psp_item_description",
    "psp_item_attributes",
    "psp_item_barcode",
    "psp_item_stock_uom_uuid",
    "psp_item_product_family_uuid",
    "psp_finished_product_spec",
    "servings_per_output_unit",
    "notes",
    "psp_semi_finished_uuid",
    "psp_bom_uuid",
)


@transaction.atomic
def rollback_to_version(
    *,
    formulation: Formulation,
    actor: Any,
    version_number: int,
) -> Formulation:
    """Restore the formulation's mutable state from a past snapshot.

    Everything ``save_version`` captured comes back:
      * every scalar field on Formulation (Setup + finished-product
        spec + identity + dosage-form scaffold);
      * ``excipient_overrides`` map;
      * every M2M picker set (flavouring / sweetener / colour /
        gummy_base / capsule_shell / …) reset to the frozen id list;
      * the entire ``FormulationStage`` graph (wholesale-replaced from
        ``snapshot_stages``); and
      * every FormulationLine — actives, band_picks, manual picks —
        rebuilt with stage assignments remapped through the
        ``stage_index`` captured on each line snapshot.

    Then a new "rollback to vN" version is appended so history stays
    append-only, and the fresh state is pushed through the PSP
    cascade the same way any Save version does.
    """

    version = get_version(
        formulation=formulation, version_number=version_number
    )

    metadata = version.snapshot_metadata or {}

    # ---- 1. Scalar fields ------------------------------------------
    for key in _ROLLBACK_SCALAR_FIELDS:
        if key in metadata:
            setattr(formulation, key, metadata[key])
    # excipient_overrides used to be captured but never restored —
    # rolling back a gummy build silently kept the CURRENT overrides
    # instead of the frozen ones. Restore whenever the snapshot
    # carries them (missing keys on legacy rows keep current state).
    if "excipient_overrides" in metadata:
        formulation.excipient_overrides = dict(
            metadata["excipient_overrides"] or {}
        )
    formulation.updated_by = actor
    formulation.save()

    # ---- 2. M2M picker sets ----------------------------------------
    # Resolve every referenced id in a single query so we don't
    # multiply DB round-trips per picker. Ids that no longer resolve
    # (item deleted since snapshot) silently drop.
    referenced_item_ids: set[str] = set()
    for meta_key, _mgr in _ROLLBACK_M2M_FIELDS:
        for item_id in metadata.get(meta_key, []) or []:
            if item_id:
                referenced_item_ids.add(str(item_id))
    items_by_id: dict[str, Item] = {}
    if referenced_item_ids:
        items_by_id = {
            str(i.id): i
            for i in Item.objects.filter(
                catalogue__organization=formulation.organization,
                id__in=list(referenced_item_ids),
            )
        }
    for meta_key, manager_attr in _ROLLBACK_M2M_FIELDS:
        raw_ids = metadata.get(meta_key)
        if raw_ids is None:
            # Snapshot pre-dates this M2M being captured — leave the
            # current picker set alone rather than wiping it.
            continue
        resolved = [
            items_by_id[str(x)]
            for x in raw_ids
            if str(x) in items_by_id
        ]
        getattr(formulation, manager_attr).set(resolved)

    # ---- 3. Rebuild the stage graph --------------------------------
    # Delete every existing stage first — Line.stage FK is on_delete
    # SET_NULL so this only clears line assignments (which we'll
    # restore in step 4). Recreate stages from the snapshot; the
    # sort_order becomes the stable key for line remapping.
    snapshot_stages = list(version.snapshot_stages or [])
    stage_id_by_index: dict[int, str] = {}
    if snapshot_stages:
        # Wholesale wipe. Snapshot pre-dating snapshot_stages leaves
        # the current graph alone (falls into the ``else`` below).
        formulation.stages.all().delete()
        for stage_data in snapshot_stages:
            payload = {
                key: stage_data.get(key)
                for key in _ROLLBACK_STAGE_FIELDS
                if key in stage_data
            }
            # Normalise sort_order (must be int); default 0 so a
            # missing key falls into a deterministic slot.
            payload["sort_order"] = int(payload.get("sort_order") or 0)
            # ``psp_item_type`` must be a valid choice; default to
            # ``semi_finished`` (the historical implicit default for
            # non-terminal stages) if the snapshot omitted it.
            if not payload.get("psp_item_type"):
                payload["psp_item_type"] = "semi_finished"
            # JSON attribute bags default to {} so a snapshot with a
            # ``null`` (rare) doesn't 500 on the not-null constraint.
            for jsonbag in (
                "psp_item_attributes",
                "psp_finished_product_spec",
            ):
                if payload.get(jsonbag) is None:
                    payload[jsonbag] = {}
            # Worker uuids default to [] for the same reason.
            if payload.get("worker_psp_uuids") is None:
                payload["worker_psp_uuids"] = []
            new_stage = FormulationStage.objects.create(
                formulation=formulation, **payload
            )
            stage_id_by_index[int(payload["sort_order"])] = str(new_stage.id)

    # ---- 4. Restore lines (actives + band_picks + manuals) ---------
    snapshot_lines = version.snapshot_lines or []
    lines_payload: list[dict[str, Any]] = []
    for entry in snapshot_lines:
        stage_index = entry.get("stage_index")
        remapped_stage_id = (
            stage_id_by_index.get(int(stage_index))
            if stage_index is not None
            else None
        )
        lines_payload.append(
            {
                "item_id": entry["item_id"],
                "label_claim_mg": entry["label_claim_mg"],
                "serving_size_override": entry.get("serving_size_override"),
                "display_order": entry.get("display_order", 0),
                "notes": entry.get("notes", ""),
                "stage_ratio_mode": entry.get("stage_ratio_mode"),
                "stage_ratio_value": entry.get("stage_ratio_value"),
                # Pass through so replace_lines rebuilds band_pick +
                # manual rows with their identity intact — otherwise
                # every band pick becomes a plain active on rollback
                # and the Routing tab loses its band chips.
                "source_kind": entry.get("source_kind"),
                "band_key": entry.get("band_key"),
                # Remapped stage_id points at the freshly-created
                # stage row (fresh uuid, same sort_order + fields).
                "stage_id": remapped_stage_id,
            }
        )
    replace_lines(formulation=formulation, actor=actor, lines=lines_payload)

    # Reload from DB so scalar assignments (Decimal / int / JSON) come
    # back as their proper Python types rather than the raw JSON
    # strings ``_snapshot_metadata`` stored them as. Without this the
    # next ``compute_totals`` fires ``str > int`` on things like
    # ``target_fill_weight_mg`` and 500s the rollback.
    formulation.refresh_from_db()

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


# ---------------------------------------------------------------------------
# Wizard step 3 — routing: assign each ingredient (active + band pick)
# to a manufacturing stage.
# ---------------------------------------------------------------------------


@transaction.atomic
def save_wizard_routing(
    *,
    formulation: Formulation,
    actor: Any,
    line_assignments: dict[str, str | None] | None = None,
    band_assignments: list[dict[str, Any]] | None = None,
) -> Formulation:
    """Persist the routing wizard's per-ingredient stage assignments.

    Two payloads work together — one for existing operator-picked
    actives (already ``FormulationLine`` rows with
    ``source_kind='active'``), one for compute-derived band picks
    (materialised as ``FormulationLine(source_kind='band_pick')``
    rows keyed by ``(item, band_key)``).

    ``line_assignments`` — ``{formulation_line_id: stage_id | null}``.
      Updates ``stage_id`` on each existing line. Unknown line ids
      silently skip so a stale FE cache doesn't hard-fail the save.

    ``band_assignments`` — list of
      ``{item_id, band_key, mg, stage_id}``. Wholesale-replaces the
      formulation's ``band_pick`` lines: upsert on
      ``(item_id, band_key)``, delete any band-pick row not in the
      payload (the operator un-ticked it in the picker).

    Both payloads validate stage ids against THIS formulation's
    stages — a passed-through id from another formulation falls
    back to ``null`` rather than corrupting cross-formulation state.
    """

    before = snapshot(formulation)

    # Resolve stage ids to FormulationStage instances scoped to this
    # formulation; anything else nulls out. One query for all ids
    # referenced across both payloads.
    referenced_stage_ids: set[str] = set()
    for stage_id in (line_assignments or {}).values():
        if stage_id:
            referenced_stage_ids.add(str(stage_id))
    for row in band_assignments or []:
        if isinstance(row, dict):
            stage_id = row.get("stage_id")
            if stage_id:
                referenced_stage_ids.add(str(stage_id))
    stages_by_id: dict[str, FormulationStage] = {}
    if referenced_stage_ids:
        stages_by_id = {
            str(s.id): s
            for s in FormulationStage.objects.filter(
                formulation=formulation, id__in=referenced_stage_ids
            )
        }

    def _resolve_stage(stage_id: str | None) -> FormulationStage | None:
        if not stage_id:
            return None
        return stages_by_id.get(str(stage_id))

    # ---- 1. Update active line stage assignments --------------------
    if line_assignments:
        existing_lines_by_id: dict[str, FormulationLine] = {
            str(l.id): l
            for l in formulation.lines.filter(
                source_kind=FormulationLine.SOURCE_KIND_ACTIVE,
                id__in=list(line_assignments.keys()),
            )
        }
        for line_id, target_stage_id in line_assignments.items():
            line = existing_lines_by_id.get(str(line_id))
            if line is None:
                continue
            line.stage = _resolve_stage(target_stage_id)
            line.save(update_fields=["stage", "updated_at"])

    # ---- 2. Wholesale-replace band-pick lines ----------------------
    if band_assignments is not None:
        # Resolve item ids to catalogue rows scoped to the org so a
        # payload can't sneak in items from another tenant.
        wanted_item_ids: set[str] = set()
        for row in band_assignments:
            if not isinstance(row, dict):
                continue
            item_id = row.get("item_id")
            if item_id:
                wanted_item_ids.add(str(item_id))
        items_by_id: dict[str, Item] = {}
        if wanted_item_ids:
            items_by_id = {
                str(i.id): i
                for i in Item.objects.filter(
                    catalogue__organization=formulation.organization,
                    id__in=list(wanted_item_ids),
                )
            }

        # Existing band-pick rows keyed by (item_id, band_key) so we
        # can upsert-or-create + collect orphans for deletion.
        existing_band_lines = list(
            formulation.lines.filter(
                source_kind=FormulationLine.SOURCE_KIND_BAND_PICK
            )
        )
        existing_by_key: dict[tuple[str, str], FormulationLine] = {}
        for line in existing_band_lines:
            if line.item_id and line.band_key:
                existing_by_key[(str(line.item_id), line.band_key)] = line

        seen_keys: set[tuple[str, str]] = set()
        # Preserve display order relative to the operator's picker
        # order (payload order). Actives already own low display_order
        # values; band picks land above the max so the ingredient list
        # groups actives-first, excipients-after naturally.
        active_max_order = (
            formulation.lines.filter(
                source_kind=FormulationLine.SOURCE_KIND_ACTIVE
            ).count()
            or 0
        )
        for offset, row in enumerate(band_assignments):
            if not isinstance(row, dict):
                continue
            item_id = str(row.get("item_id") or "").strip()
            band_key = str(row.get("band_key") or "").strip()
            if not item_id or not band_key:
                continue
            item = items_by_id.get(item_id)
            if item is None:
                continue
            # Only accept known band_key values so a fat-fingered
            # payload can't pollute the column.
            valid_band_keys = {
                choice for choice, _ in FormulationLine.BAND_KEY_CHOICES
            }
            if band_key not in valid_band_keys:
                continue
            raw_mg = row.get("mg")
            try:
                mg = Decimal(str(raw_mg)) if raw_mg is not None else Decimal("0")
            except (InvalidOperation, TypeError):
                mg = Decimal("0")
            if mg < 0:
                mg = Decimal("0")
            stage = _resolve_stage(row.get("stage_id"))
            key = (item_id, band_key)
            seen_keys.add(key)
            existing = existing_by_key.get(key)
            if existing is not None:
                existing.mg_per_serving_cached = mg
                existing.stage = stage
                existing.display_order = active_max_order + offset
                existing.save(
                    update_fields=[
                        "mg_per_serving_cached",
                        "stage",
                        "display_order",
                        "updated_at",
                    ]
                )
            else:
                FormulationLine.objects.create(
                    formulation=formulation,
                    item=item,
                    item_source="local",
                    source_kind=FormulationLine.SOURCE_KIND_BAND_PICK,
                    band_key=band_key,
                    stage=stage,
                    # Band picks don't carry a label claim in the
                    # scientist-authored sense — the mg is the
                    # compute-derived share the FE calculated. We
                    # store it both on ``label_claim_mg`` (so
                    # existing code that reads it doesn't NPE) and
                    # on ``mg_per_serving_cached`` (the canonical
                    # per-serving value).
                    label_claim_mg=mg,
                    mg_per_serving_cached=mg,
                    display_order=active_max_order + offset,
                )

        # Orphans: existing band-pick rows the payload no longer
        # references — the operator un-ticked them in the sidebar
        # picker. Delete so the routing view stays in sync with the
        # M2M selections upstream.
        for key, line in existing_by_key.items():
            if key not in seen_keys:
                line.delete()

    formulation.refresh_from_db()
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.save_wizard_routing",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


# ---------------------------------------------------------------------------
# Ready-to-Go catalog — staff-side publish/unpublish
# ---------------------------------------------------------------------------
#
# The publish step is the moment a validated RTG recipe crosses from
# "internal record" to "customer-orderable SKU". We treat it as a
# discrete action rather than a bag of editable fields on the
# formulation form: a partially-configured publish would surface a
# broken card on the portal catalog, and a Custom project has no
# business being on the RTG track at all. Both invariants live here
# so the model layer stays additive and the API stays a thin shim.


#: Fields the marketing payload must carry before ``is_rtg_published``
#: may flip true. Keys map to the ``rtg_*`` model attribute; values
#: are the customer-facing label the API layer echoes back in the
#: field-errors dict so the FE can attach the message to the right
#: input.
_RTG_PUBLISH_REQUIRED_FIELDS: tuple[tuple[str, str], ...] = (
    ("rtg_short_description", "Short description"),
    ("rtg_base_price", "Base price"),
    ("rtg_moq", "Minimum order quantity"),
    ("rtg_packaging_options", "Packaging options"),
)


def _rtg_marketing_field_errors(
    payload: dict[str, Any],
) -> dict[str, str]:
    """Return ``{field: message}`` for every missing / invalid entry
    on a publish payload. Empty dict means the payload is safe to
    persist.

    ``payload`` is the merged view of the incoming request over the
    formulation's current values so partial patches keep the last
    known-good state — the caller passes the merged dict, not the
    raw request body.
    """

    errors: dict[str, str] = {}
    description = (payload.get("rtg_short_description") or "").strip()
    if not description:
        errors["rtg_short_description"] = (
            "A short description is required to publish."
        )

    base_price = payload.get("rtg_base_price")
    if base_price is None:
        errors["rtg_base_price"] = "A base price is required to publish."
    else:
        try:
            as_decimal = Decimal(str(base_price))
        except (InvalidOperation, TypeError, ValueError):
            errors["rtg_base_price"] = "Base price must be a number."
        else:
            if as_decimal <= 0:
                errors["rtg_base_price"] = "Base price must be positive."

    moq = payload.get("rtg_moq")
    if moq is None:
        errors["rtg_moq"] = "Minimum order quantity is required."
    else:
        try:
            as_int = int(moq)
        except (TypeError, ValueError):
            errors["rtg_moq"] = "MOQ must be a whole number."
        else:
            if as_int < 1:
                errors["rtg_moq"] = "MOQ must be at least 1."

    packaging = payload.get("rtg_packaging_options") or []
    if not isinstance(packaging, (list, tuple)):
        errors["rtg_packaging_options"] = (
            "Packaging options must be a list of labels."
        )
    else:
        cleaned = [
            str(entry).strip() for entry in packaging if str(entry).strip()
        ]
        if not cleaned:
            errors["rtg_packaging_options"] = (
                "Add at least one packaging option before publishing."
            )

    return errors


@transaction.atomic
def publish_to_rtg_catalog(
    formulation: Formulation,
    *,
    actor: Any,
    marketing_fields: dict[str, Any],
) -> Formulation:
    """Flip ``is_rtg_published`` on with an accompanying marketing
    payload, or update the marketing payload while the flag stays on.

    Guards enforced here (rather than at the API):

    * ``project_type`` must be ``ready_to_go``. Custom projects fail
      with :class:`FormulationRTGError` (``code='not_ready_to_go'``).
    * Every field in :data:`_RTG_PUBLISH_REQUIRED_FIELDS` must be
      present + valid. Missing values raise ``FormulationRTGError``
      with a ``field_errors`` dict the view echoes back as 400.

    ``marketing_fields`` is a partial dict — the caller only needs to
    thread the values they're changing. Missing keys fall back to the
    formulation's current values so a re-save without a new image
    doesn't wipe the existing one.
    """

    if formulation.project_type != ProjectType.READY_TO_GO:
        exc = FormulationRTGError(
            "Only Ready-to-Go projects can be published to the "
            "customer catalog. Convert the project first."
        )
        exc.code = "not_ready_to_go"  # type: ignore[attr-defined]
        raise exc

    merged: dict[str, Any] = {
        "rtg_display_name": formulation.rtg_display_name,
        "rtg_short_description": formulation.rtg_short_description,
        "rtg_base_price": formulation.rtg_base_price,
        "rtg_moq": formulation.rtg_moq,
        "rtg_packaging_options": list(formulation.rtg_packaging_options or []),
        "rtg_currency_code": formulation.rtg_currency_code,
    }
    for key, value in marketing_fields.items():
        # ``None`` on an ``rtg_hero_image`` upload = "don't touch the
        # image"; we manage the image field separately below.
        if key == "rtg_hero_image":
            continue
        merged[key] = value

    field_errors = _rtg_marketing_field_errors(merged)
    if field_errors:
        exc = FormulationRTGError(
            "Some marketing fields need attention before publishing."
        )
        exc.field_errors = field_errors  # type: ignore[attr-defined]
        raise exc

    before = snapshot(formulation)
    formulation.is_rtg_published = True
    # ``rtg_display_name`` is optional — blank stays blank and every
    # consumer falls back to ``name``. Trim to keep whitespace-only
    # values from looking like a set value.
    formulation.rtg_display_name = str(
        merged.get("rtg_display_name") or ""
    ).strip()[:200]
    formulation.rtg_short_description = str(
        merged["rtg_short_description"]
    ).strip()
    formulation.rtg_base_price = Decimal(str(merged["rtg_base_price"]))
    formulation.rtg_moq = int(merged["rtg_moq"])
    formulation.rtg_packaging_options = [
        str(entry).strip()
        for entry in merged["rtg_packaging_options"]
        if str(entry).strip()
    ]
    formulation.rtg_currency_code = (
        str(merged.get("rtg_currency_code") or "GBP").strip().upper()[:3]
    )
    hero = marketing_fields.get("rtg_hero_image")
    if hero is not None:
        # ``False`` is Django's "clear this file" sentinel on
        # ``ImageField``; anything else lands as the new upload.
        formulation.rtg_hero_image = hero
    formulation.updated_by = actor
    formulation.save()
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.rtg_publish",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation


@transaction.atomic
def unpublish_from_rtg_catalog(
    formulation: Formulation,
    *,
    actor: Any,
) -> Formulation:
    """Take a formulation off the customer RTG catalog.

    Leaves the marketing fields intact so a subsequent republish
    doesn't require re-typing everything. Idempotent: calling on an
    already-unpublished formulation still records an audit row so a
    "did anyone touch this?" query can answer honestly.
    """

    before = snapshot(formulation)
    formulation.is_rtg_published = False
    formulation.updated_by = actor
    formulation.save(
        update_fields=["is_rtg_published", "updated_by", "updated_at"]
    )
    record_audit(
        organization=formulation.organization,
        actor=actor,
        action="formulation.rtg_unpublish",
        target=formulation,
        before=before,
        after=snapshot(formulation),
    )
    return formulation
