"""Hard-coded dosage form reference data, transcribed from the Valley
Low Fat Burner workbook's ``Lists`` sheet.

These values are load-bearing for the viability math — they match the
Excel formulas byte-for-byte. If the scientists ever add a new capsule
size or tablet size, extend the corresponding tuple here and re-run
the test suite; the unit tests check every entry.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class DosageForm(str, Enum):
    POWDER = "powder"
    CAPSULE = "capsule"
    TABLET = "tablet"
    GUMMY = "gummy"
    LIQUID = "liquid"
    OTHER_SOLID = "other_solid"


class PowderType(str, Enum):
    """Powder sub-variant chosen by the scientist.

    The flavour-system preset swaps with this value — protein powders
    drop the acidity-regulator pair (Trisodium Citrate + Citric Acid)
    that the hydration / electrolyte sachets rely on, because the
    protein matrix already buffers itself and adding more acid hurts
    mouthfeel.
    """

    STANDARD = "standard"
    PROTEIN = "protein"


#: Dosage forms F1 supports with full excipient math + viability. Other
#: forms store metadata but return ``None`` for the computed totals.
FULLY_SUPPORTED_FORMS: frozenset[DosageForm] = frozenset(
    {
        DosageForm.CAPSULE,
        DosageForm.TABLET,
        DosageForm.POWDER,
        DosageForm.GUMMY,
    }
)


@dataclass(frozen=True)
class CapsuleSize:
    key: str
    label: str
    #: Maximum total fill weight in mg.
    max_weight_mg: float
    #: Upper bound of total active weight for auto-selecting this size.
    #: Values copied verbatim from Lists!G6:G8 in the Valley workbook.
    #: ``None`` means the size is not part of the automatic cascade.
    auto_pick_threshold_mg: float | None
    #: Empty shell weight in mg. Used when building the ingredient
    #: declaration so the capsule shell contributes to the sort order
    #: alongside actives and excipients. Values from Lists!K20:L23.
    shell_weight_mg: float


CAPSULE_SIZES: tuple[CapsuleSize, ...] = (
    CapsuleSize("size_1", "Size 1", 380.0, 300.0, 75.0),
    CapsuleSize("single_0", "Single 0", 453.0, 446.658, 96.0),
    CapsuleSize("double_00", "Double 00", 730.0, 719.78, 118.0),
    CapsuleSize("size_3", "Size 3", 216.0, None, 50.0),
)


@dataclass(frozen=True)
class TabletSize:
    key: str
    label: str
    max_weight_mg: float


TABLET_SIZES: tuple[TabletSize, ...] = (
    TabletSize("round_6mm", "6mm Round", 150.0),
    TabletSize("round_7_5mm", "7.5mm Round", 225.0),
    TabletSize("round_8mm", "8mm Round", 275.0),
    TabletSize("round_11mm", "11mm Round", 700.0),
    TabletSize("round_13mm", "13mm Round", 1000.0),
    TabletSize("oval_14_5x8_5mm", "14.5mm x 8.5mm", 700.0),
    TabletSize("oval_15x7mm", "15mm x 7mm", 600.0),
    TabletSize("oval_19_5x8_2mm", "19.5mm x 8.2mm", 1100.0),
    TabletSize("oval_22_5x9mm", "22.5mm x 9mm", 1500.0),
    TabletSize("oval_22_5x10mm", "22.5mm x 10mm", 1750.0),
)


#: Excipient ratios copied straight from the ``Formulation Calculation
#: Sheet`` cell formulas. Changing these requires a scientist sign-off,
#: not a code review.
CAPSULE_MG_STEARATE_PCT = 0.01
CAPSULE_SILICA_PCT = 0.004

TABLET_MG_STEARATE_PCT = 0.01
TABLET_SILICA_PCT = 0.004
TABLET_DCP_PCT = 0.10
TABLET_MCC_PCT = 0.20


#: Powder flavour system — reference rows that the scientist sees in
#: their ``BOM Actives Calculation`` scratchpad in every workbook.
#: Excel hand-types these with product-specific mg values (Rave Lytes
#: has TSC at 50mg, Soza at 25mg) but every powder gets the same five
#: categories. We surface them as editable excipient rows so the
#: scientist can tune each mg per product while still seeing the full
#: recipe at a glance. Values default to the Rave Lytes / Moonlytes
#: standard — the most common numbers across the reference set.
#:
#: Carrier / bulking agent (maltodextrin, etc.) is **not** in this
#: list. Excel treats it as a real catalogue line (``MA200161
#: Maltodextrin``) that the scientist adds explicitly — same way they
#: add actives. We keep it out of the auto-computed list so we don't
#: fabricate a phantom row without a procurement code.
#: Powder flavour system — each row is ``(slug, label, mg_per_ml)``
#: with ``mg_per_ml`` the concentration the scientist dissolves into
#: a serving's water. Values copied verbatim from the master
#: Formulation Calculation Sheet (``=K7 * 0.1% * 100`` ⇒ 0.1 mg/ml
#: for Trisodium Citrate, etc.). Multiplying by the serving's
#: ``water_volume_ml`` produces the per-serving mg exactly as the
#: Rave Lytes / Moonlytes / Soza reference workbooks compute it.
POWDER_FLAVOUR_SYSTEM: tuple[tuple[str, str, float], ...] = (
    ("trisodium_citrate", "Trisodium Citrate", 0.1),
    ("citric_acid", "Citric Acid", 0.3),
    ("flavouring", "Flavouring", 0.25),
    ("sweetener", "Sweetener", 0.06),
    ("colourant", "Colourant", 0.04),
)


#: Protein-powder flavour system — same mg/ml convention as the
#: standard powder preset but without the Trisodium Citrate /
#: Citric Acid pair. Protein matrices buffer themselves and
#: additional acid degrades mouthfeel, so scientists omit the
#: acidity regulators on every reference protein formulation.
PROTEIN_POWDER_FLAVOUR_SYSTEM: tuple[tuple[str, str, float], ...] = (
    ("flavouring", "Flavouring", 0.25),
    ("sweetener", "Sweetener", 0.06),
    ("colourant", "Colourant", 0.04),
)


#: Default water volume seeded into a new powder formulation when the
#: scientist lands on the builder. The Formulation Calculation Sheet
#: template defaults to 250 ml; Rave Lytes ships at 500 ml. We pick
#: the Rave Lytes number because the preset mg values are printed
#: against it in the user's primary reference workbook, but the
#: scientist overrides per product.
POWDER_REFERENCE_WATER_ML = 500.0


def powder_flavour_system_for(
    powder_type: str | None,
) -> tuple[tuple[str, str, float], ...]:
    """Pick the right flavour-system preset for a powder variant.

    ``None`` and unknown values fall back to the standard preset so an
    in-flight migration from an older client never loses the acidity
    regulators silently.
    """

    if powder_type == PowderType.PROTEIN.value:
        return PROTEIN_POWDER_FLAVOUR_SYSTEM
    return POWDER_FLAVOUR_SYSTEM


#: Gummy base / flavour system. Same convention as the powder preset
#: — reference rows the scientist tunes per product. ``Gummy Base``
#: (usually sugar + glucose syrup) is picked from the catalogue as a
#: real line like Maltodextrin, not auto-filled.
GUMMY_FLAVOUR_SYSTEM: tuple[tuple[str, str, float], ...] = (
    ("water", "Water", 275.0),
    ("acidity_regulator", "Acidity Regulator", 75.0),
    ("flavouring_colourant", "Flavouring & Colourant", 100.0),
)


#: Label-copy strings used in the ingredient declaration (F2a). Kept
#: next to the ratios so the whole label-facing surface area lives in
#: one file. Each entry is the exact string that ends up on the
#: product's ingredient list.
EXCIPIENT_LABEL_MCC = "Microcrystalline Cellulose (Carrier)"
EXCIPIENT_LABEL_MG_STEARATE = "Magnesium Stearate"
EXCIPIENT_LABEL_SILICA = "Silicon Dioxide"
EXCIPIENT_LABEL_DCP = "Dicalcium Phosphate"
CAPSULE_SHELL_LABEL = "Capsule Shell (Hypromellose)"


#: Candidate names we probe in the org's ``raw_materials`` catalogue
#: when resolving the procurement code for a hard-coded excipient.
#: Tried in order; the first active (non-archived) item whose name
#: matches case-insensitively wins. Tuples stay flat rather than
#: nested regexes so an admin can drop a variant into the catalogue
#: verbatim and it'll resolve without any code change.
EXCIPIENT_CATALOGUE_NAME_CANDIDATES: dict[str, tuple[str, ...]] = {
    "mcc_mg": (
        "Microcrystalline Cellulose",
        "MCC",
    ),
    "dcp_mg": (
        "Dicalcium Phosphate",
        "DCP",
    ),
    "mg_stearate_mg": (
        "Magnesium Stearate",
        "Mg Stearate",
    ),
    "silica_mg": (
        "Silicon Dioxide",
        "Silica",
    ),
    "capsule_shell": (
        "Capsule Shell",
        "Hypromellose Capsule Shell",
        "HPMC Capsule Shell",
        "Hypromellose",
        "HPMC",
    ),
    # Powder flavour-system rows — the preset slugs emitted by
    # :func:`_compute_fill_target` map to real catalogue items the
    # team procures against. Generic categories (``flavouring``,
    # ``sweetener``, ``colourant``) are deliberately broad because
    # scientists pick a specific SKU per product; the istartswith
    # match catches the first one in the catalogue so the BOM at
    # least shows *a* code instead of an empty cell.
    "trisodium_citrate": (
        "Trisodium Citrate",
        "Sodium Citrate",
    ),
    "citric_acid": (
        "Citric Acid",
    ),
    "flavouring": (
        "Flavouring",
        "Flavour",
        "Natural Flavour",
    ),
    "sweetener": (
        "Sweetener",
        "Sucralose",
        "Stevia",
        "Steviol",
    ),
    "colourant": (
        "Colourant",
        "Colour",
        "Colorant",
        "Beetroot",
    ),
    # Gummy-specific slugs. ``water`` is not a catalogued raw
    # material so it intentionally has no mapping.
    "acidity_regulator": (
        "Citric Acid",
        "Trisodium Citrate",
        "Sodium Citrate",
    ),
    "flavouring_colourant": (
        "Flavouring",
        "Colourant",
        "Natural Flavour",
    ),
}
#: Combined label for the magnesium-stearate + silica pair. The Valley
#: workbook collapses both flow agents into a single ingredient-list
#: entry; rendering them separately exposes manufacturing detail
#: customers do not need to see.
EXCIPIENT_LABEL_ANTICAKING = (
    "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)"
)


#: Compliance flags tracked by every raw material and aggregated on
#: the formulation. The attribute key matches the raw material's
#: ``attributes`` column; the label is the human-facing word.
COMPLIANCE_FLAGS: tuple[tuple[str, str], ...] = (
    ("vegan", "Vegan"),
    ("organic", "Organic"),
    ("halal", "Halal"),
    ("kosher", "Kosher"),
)


#: Nutrition keys stored on raw material attributes. Each value in
#: the catalogue is recorded as "per 100g of ingredient". The
#: aggregator multiplies by ``mg_per_serving / 100000`` to produce
#: the per-serving contribution.
NUTRITION_KEYS: tuple[str, ...] = (
    "energy_kcal",
    "energy_kj",
    "fat",
    "fat_saturated",
    "fat_monounsaturated",
    "fat_polyunsaturated",
    "carbohydrate",
    "sugar",
    "fibre",
    "protein",
    "salt",
)


#: Amino acid keys with their grouping for the FINAL Specification
#: Sheet. ``asparatic_acid`` is spelled to match the workbook header.
AMINO_ACID_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "essential",
        (
            "isoleucine",
            "leucine",
            "lysine",
            "methionine",
            "phenylalanine",
            "threonine",
            "tryptophan",
            "valine",
        ),
    ),
    (
        "conditionally_essential",
        (
            "arginine",
            "cystine",
            "glutamic_acid",
            "histidine",
            "proline",
            "tyrosine",
        ),
    ),
    (
        "non_essential",
        (
            "alanine",
            "asparatic_acid",
            "glycine",
            "serine",
        ),
    ),
)

#: Flat tuple of every amino acid key in fixed display order.
AMINO_ACID_KEYS: tuple[str, ...] = tuple(
    key for _, keys in AMINO_ACID_GROUPS for key in keys
)


def capsule_size_by_key(key: str) -> CapsuleSize | None:
    for size in CAPSULE_SIZES:
        if size.key == key:
            return size
    return None


def normalize_compliance_value(raw: object) -> bool | None:
    """Interpret a raw material's compliance attribute as a tri-state
    ``True / False / None`` boolean.

    ``None`` encodes "uncertain" — the source catalogue did not record
    a value, so the aggregation cannot speak for this ingredient.
    This keeps "missing data" visibly different from a confident
    "Non-Vegan", which matters when the UI decides whether to show a
    green, red, or grey compliance chip.
    """

    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if not isinstance(raw, str):
        return None
    lowered = raw.strip().lower()
    if not lowered:
        return None
    if lowered.startswith("non-") or lowered in {"no", "false"}:
        return False
    if lowered in {"yes", "true"}:
        return True
    # Any other non-empty value (e.g. "Vegan", "Organic") is compliant
    # by convention — the catalogue prefixes negatives with "Non-".
    return True


def tablet_size_by_key(key: str) -> TabletSize | None:
    for size in TABLET_SIZES:
        if size.key == key:
            return size
    return None


def auto_pick_capsule_size(total_active_mg: float) -> CapsuleSize | None:
    """Walk the size cascade and return the smallest capsule that fits.

    Mirrors the ``D39`` formula's nested ``IF`` ladder from the
    workbook. Returns ``None`` if the total active weight exceeds the
    biggest auto-pickable size; the caller surfaces that as an error.
    """

    for size in CAPSULE_SIZES:
        if size.auto_pick_threshold_mg is None:
            continue
        if total_active_mg < size.auto_pick_threshold_mg:
            return size
    return None
