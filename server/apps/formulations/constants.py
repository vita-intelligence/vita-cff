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

#: Gummy excipient ratios. Water is a **fixed** 5.5% of the target
#: gummy weight (small enough that actives never push against it).
#: Gummy base is a **minimum** — scientists treat 65% as the floor
#: below which the gel matrix won't set reliably. The MCC-style
#: remainder-fill rule applies: gummy base = target - water -
#: actives - flavour, and the viability check flags the formulation
#: as ``cannot_make`` when that remainder drops below
#: ``GUMMY_BASE_MIN_PCT × target``. Scientists can keep actives
#: light and let the base grow above the floor; they cannot push
#: actives so heavy that the base collapses below it.
GUMMY_BASE_MIN_PCT = 0.65
GUMMY_WATER_PCT = 0.055

#: Acidity regulator auto-fills at 2% of the target gummy weight —
#: scales linearly with the gummy mass (a 3000 mg gummy → 60 mg, a
#: 5000 mg gummy → 100 mg). Scientist direction, 2026-04-24 revision.
GUMMY_ACIDITY_PCT = 0.02

#: Flavouring auto-fills at 0.4% of the target gummy weight — flavour
#: picks (strawberry, lemon, etc.) split this total equally; generic
#: fallback row shows when nothing's picked.
GUMMY_FLAVOURING_PCT = 0.004

#: Colour auto-fills at 2% of the target gummy weight — colour picks
#: (beetroot extract, turmeric, spirulina, etc.) split this total
#: equally; separate from flavouring because the two bands differ
#: significantly (0.4% vs 2%) and scientists tag items accordingly.
GUMMY_COLOUR_PCT = 0.02

#: Glazing agent (carnauba wax, coconut oil, beeswax, etc.) at 0.1%
#: of the target gummy weight — applied as a thin surface coating.
#: Scales linearly with the gummy mass (a 3000 mg gummy → 3 mg).
GUMMY_GLAZING_PCT = 0.001

#: Gelling agent (pectin, gelatin, agar) at 3% of the target gummy
#: weight — provides the gel matrix. Only emitted when the scientist
#: has actually picked a gelling agent; an empty pick list means a
#: non-gelling gummy and no gelling band shows up.
GUMMY_GELLING_PCT = 0.03

#: Premix sweetener at 6% of the target gummy weight — carved out of
#: the gummy base remainder (so the visible gummy base shrinks by 6%
#: when a gelling agent is picked). Together with the 3% gelling
#: agent it forms the in-house "Pectin Premix" line on the MRPeasy
#: BOM (3% + 6% = 9% combined). Only emitted when gelling items are
#: present — coupled to the gelling band.
GUMMY_PREMIX_SWEETENER_PCT = 0.06

#: Legacy alias — kept so any in-flight consumer reading the flat
#: 65% target still sees a sensible number. Prefer
#: :data:`GUMMY_BASE_MIN_PCT` going forward.
GUMMY_BASE_PCT = GUMMY_BASE_MIN_PCT


#: Slugs the formulation's ``excipient_overrides`` JSON dict accepts.
#: Each band has a default percentage (the constants above); the
#: scientist can override any of them per-formulation by writing a
#: float into this map. Unknown slugs are silently ignored at compute
#: time so a stray key from a future band never crashes older
#: formulations.
GUMMY_BAND_OVERRIDE_KEYS: tuple[str, ...] = (
    "water",
    "acidity",
    "flavouring",
    "colour",
    "glazing",
    "gelling",
    "premix_sweetener",
)


#: Default percentages for each gummy band, keyed by override slug.
#: ``_compute_fill_target`` reads this map to resolve "default unless
#: overridden" without a long if/elif ladder.
GUMMY_BAND_DEFAULT_PCT: dict[str, float] = {
    "water": GUMMY_WATER_PCT,
    "acidity": GUMMY_ACIDITY_PCT,
    "flavouring": GUMMY_FLAVOURING_PCT,
    "colour": GUMMY_COLOUR_PCT,
    "glazing": GUMMY_GLAZING_PCT,
    "gelling": GUMMY_GELLING_PCT,
    "premix_sweetener": GUMMY_PREMIX_SWEETENER_PCT,
}


# ---------------------------------------------------------------------------
# ``use_as`` — functional category of a raw-material item
# ---------------------------------------------------------------------------
#
# The catalogue's ``use_as`` attribute classifies every raw material by
# its functional role (Active / Sweeteners / Colourant / ...). Two
# places consume it:
#
# 1. The **ingredient declaration builder** groups non-Active items by
#    this value so the EU 1169/2011 label copy reads as
#    ``"Sweeteners (Xylitol, Maltitol), Colourant (Beetroot)"``.
# 2. The **gummy-base picker** filters items where ``use_as`` ∈
#    :data:`GUMMY_BASE_USE_CATEGORIES` — Sweeteners for sugar-alcohol
#    bases (Xylitol, Maltitol, Erythritol), Bulking Agent for
#    starch / pectin / gelatin bases.
#
# ``USE_AS_CANONICAL_VALUES`` is the controlled vocabulary the
# catalogue's ``use_as`` attribute is locked to (``single_select``).
# ``USE_AS_NORMALISATION`` collapses historical free-text typos and
# casing drift onto the canonical value. A data migration reads this
# map on upgrade; the attribute validator reads the canonical list at
# save time so nothing off-vocab can re-enter.

#: Canonical controlled vocabulary for ``use_as`` values. Plural
#: category names where the EU label convention expects plural copy
#: (``Sweeteners`` not ``Sweetener``); singular elsewhere. Order
#: roughly matches how often each category shows up on a typical
#: spec sheet so the single-select picker surfaces common picks first.
USE_AS_CANONICAL_VALUES: tuple[str, ...] = (
    "Active",
    "Sweeteners",
    "Bulking Agent",
    "Flavouring",
    "Colour",
    "Acidity Regulator",
    "Glazing Agent",
    "Gelling Agent",
    "Emulsifier",
    "Disintegrant",
    "Stabiliser",
    "Anti-caking Agent",
    "Coating Agent",
    "Preservative",
    "Carrier",
    "Excipient",
    "Other",
)


#: Fold historical free-text values (typos, casing variants) onto the
#: canonical vocab. Applied both by the one-shot normalisation
#: migration and at read time by :func:`normalize_use_as_value` so a
#: value sourced from an Excel import with an old spelling still maps
#: cleanly. Keys are **lowercase** so the lookup is case-insensitive.
USE_AS_NORMALISATION: dict[str, str] = {
    "active": "Active",
    "sweeteners": "Sweeteners",
    "sweetners": "Sweeteners",  # historical typo in the 1114-row import
    "sweetener": "Sweeteners",
    "bulking agent": "Bulking Agent",
    "bulking agents": "Bulking Agent",
    # Flavouring + Colour are separate canonical categories (split
    # 2026-04-24 at scientist direction — gummies spec flavours at
    # 0.4% and colours at 2% of target, different rates so they must
    # land in different buckets).
    "flavouring": "Flavouring",
    "flavourings": "Flavouring",
    "flavoring": "Flavouring",
    "flavor": "Flavouring",
    # The old merged "Flavouring and Colour" canonical collapses onto
    # "Flavouring" here as the safer default — flavour mg is the
    # smaller of the two bands, so mis-bucketing a colour into the
    # flavour picker merely understates weight (the floor check
    # still catches any overshoot). Scientists retag colours via
    # the Items page when the split is rolled out.
    "flavouring and colour": "Flavouring",
    "flavouring & colour": "Flavouring",
    "flavouring and colourant": "Flavouring",
    "flavouring & colourant": "Flavouring",
    "colourant": "Colour",
    "colourants": "Colour",
    "colorant": "Colour",
    "colour": "Colour",
    "colours": "Colour",
    "color": "Colour",
    "colors": "Colour",
    "acidity regulator": "Acidity Regulator",
    "acidity regulators": "Acidity Regulator",
    "acid": "Acidity Regulator",
    "emulsifier": "Emulsifier",
    "emulsifiers": "Emulsifier",
    "disintegrant": "Disintegrant",
    "disintegrants": "Disintegrant",
    "stabiliser": "Stabiliser",
    "stabilizers": "Stabiliser",
    "stabilizer": "Stabiliser",
    "stabilisers": "Stabiliser",
    "anti-caking agent": "Anti-caking Agent",
    "anti-caking agents": "Anti-caking Agent",
    "anticaking agent": "Anti-caking Agent",
    "coating agent": "Coating Agent",
    "coating agents": "Coating Agent",
    "glazing agent": "Glazing Agent",
    "glazing agents": "Glazing Agent",
    "glazing": "Glazing Agent",
    "glaze": "Glazing Agent",
    "glazes": "Glazing Agent",
    "wax": "Glazing Agent",
    "waxes": "Glazing Agent",
    # Gelling agent — pectin / gelatin / agar variants. The canonical
    # spelling is ``Gelling Agent`` (matches the EU 1169/2011 label
    # category). Specific items keep their own names; this normalises
    # the ``use_as`` tag scientists assign in the catalogue.
    "gelling agent": "Gelling Agent",
    "gelling agents": "Gelling Agent",
    "gelling": "Gelling Agent",
    "gel": "Gelling Agent",
    "gel base": "Gelling Agent",
    "gelling base": "Gelling Agent",
    "pectin": "Gelling Agent",
    "gelatin": "Gelling Agent",
    "gelatine": "Gelling Agent",
    "agar": "Gelling Agent",
    "agar agar": "Gelling Agent",
    "agar-agar": "Gelling Agent",
    "carrageenan": "Gelling Agent",
    "preservative": "Preservative",
    "preservatives": "Preservative",
    "carrier": "Carrier",
    "carriers": "Carrier",
    "excipient": "Excipient",
    "excipients": "Excipient",
    "other": "Other",
    "others": "Other",
}


def normalize_use_as_value(value: str | None) -> str:
    """Fold a free-text ``use_as`` into the canonical vocab.

    Empty / unknown values return ``""`` rather than defaulting to
    ``"Other"`` — a missing classification is a data issue to surface,
    not something to silently bucket. The gummy-base picker and the
    declaration builder both treat empty values as "uncategorised" and
    handle them explicitly.
    """

    if value is None:
        return ""
    key = value.strip().lower()
    if not key:
        return ""
    return USE_AS_NORMALISATION.get(key, value.strip())


#: The categories the gummy-base picker surfaces. Sugar-alcohol bases
#: (xylitol, maltitol, erythritol, allulose) all live under
#: ``Sweeteners``; starch / pectin / gelatin bases live under
#: ``Bulking Agent``. Extend this tuple if a future base ends up
#: under a different canonical category — don't loosen the filter to
#: match items outside the list.
GUMMY_BASE_USE_CATEGORIES: tuple[str, ...] = (
    "Sweeteners",
    "Bulking Agent",
)

#: Categories the Acidity Regulator picker surfaces. Scientists
#: pick from items tagged with this single canonical value (Citric
#: Acid, Trisodium Citrate, etc.). The 2% acidity total splits
#: equally across picks the same way Flavouring + Colour do.
ACIDITY_USE_CATEGORIES: tuple[str, ...] = ("Acidity Regulator",)

#: Categories the Flavouring picker surfaces — a single value
#: today, held as a tuple for filter-shape consistency.
FLAVOURING_USE_CATEGORIES: tuple[str, ...] = ("Flavouring",)

#: Categories the Colour picker surfaces. Includes ``Flavouring``
#: alongside ``Colour`` because most flavour items in the catalogue
#: double as colourants (beetroot extract, turmeric oleoresin,
#: spirulina powder all carry colour as well as flavour) — the
#: scientist picks them under whichever band they want the mg
#: allocated to. The per-pick row still tags as ``use_as = "Colour"``
#: so the EU 1169 declaration groups it under "Colour (...)" even
#: when the source catalogue item is canonically Flavouring.
COLOUR_USE_CATEGORIES: tuple[str, ...] = ("Colour", "Flavouring")

#: Categories the glazing-agent picker surfaces (carnauba wax,
#: coconut oil, beeswax, shellac, etc.). Single canonical value
#: for now — same tuple shape as the siblings so filter logic
#: reads uniformly.
GLAZING_USE_CATEGORIES: tuple[str, ...] = (
    "Glazing Agent",
)

#: Categories the gelling-agent picker surfaces (pectin, gelatin,
#: agar, carrageenan, etc.). Tagged ``Gelling Agent`` in the
#: catalogue and rendered as ``Gelling Agent (Pectin)`` on the EU
#: 1169/2011 ingredient declaration.
GELLING_USE_CATEGORIES: tuple[str, ...] = (
    "Gelling Agent",
)

#: The premix-sweetener picker reuses the gummy-base catalogue pool —
#: scientists pick from the same maltitol/xylitol/sucrose universe.
#: Holding it as a constant keeps "what does the picker filter on"
#: in one place and lets a future split (a curated premix-only pool)
#: change just this tuple.
PREMIX_SWEETENER_USE_CATEGORIES: tuple[str, ...] = GUMMY_BASE_USE_CATEGORIES


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


#: Pre-filled text defaults seeded at :func:`create_formulation`
#: time so the scientist lands on a sensible draft of the four
#: free-text product cells (Directions of use / Suggested dosage /
#: Appearance / Disintegration spec) rather than four blank inputs.
#:
#: Defaults only apply when the caller submits a blank value AND the
#: dosage form has an entry below — non-blank input always wins, so
#: the AI-builder + import flows that already know what to put in
#: each cell are not overridden. Liquid / other-solid forms stay
#: blank because their conventions vary too widely to seed safely.
FORMULATION_TEXT_DEFAULTS: dict[str, dict[str, str]] = {
    "capsule": {
        "directions_of_use": "Take 1 capsule with food, daily.",
        "suggested_dosage": "1 capsule per day",
        "appearance": "Off-white powder filled in HPMC capsule",
        "disintegration_spec": "Disintegrate within 30 minutes",
    },
    "tablet": {
        "directions_of_use": "Take 1 tablet with water, daily.",
        "suggested_dosage": "1 tablet per day",
        "appearance": "Off-white round tablet",
        "disintegration_spec": "Disintegrate within 30 minutes",
    },
    "gummy": {
        "directions_of_use": (
            "Chew 2 gummies daily, preferably with food."
        ),
        "suggested_dosage": "2 gummies per day",
        "appearance": "Coloured dome-shape gummy",
        # Gummies dissolve on chewing — disintegration spec stays
        # blank by convention; scientists fill it only when the QC
        # protocol calls for one (rare on consumer chewables).
        "disintegration_spec": "",
    },
    "powder": {
        "directions_of_use": (
            "Mix 1 scoop (10 g) with 500 ml water. Shake well. "
            "Drink once daily."
        ),
        "suggested_dosage": "1 scoop per day",
        "appearance": "Free-flowing powder",
        # Powders dissolve in water rather than disintegrate, so
        # the cell stays blank.
        "disintegration_spec": "",
    },
}


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


#: Label-copy strings used in the ingredient declaration (F2a). Kept
#: next to the ratios so the whole label-facing surface area lives in
#: one file. Each entry is the exact string that ends up on the
#: product's ingredient list.
EXCIPIENT_LABEL_MCC = "Microcrystalline Cellulose (Carrier)"
EXCIPIENT_LABEL_MG_STEARATE = "Magnesium Stearate"
EXCIPIENT_LABEL_SILICA = "Silicon Dioxide"
EXCIPIENT_LABEL_DCP = "Dicalcium Phosphate"
EXCIPIENT_LABEL_GUMMY_BASE = "Gummy Base"
EXCIPIENT_LABEL_GELLING_AGENT = "Gelling Agent"
EXCIPIENT_LABEL_PREMIX_SWEETENER = "Premix Sweetener"
EXCIPIENT_LABEL_PECTIN_PREMIX = "Pectin Premix"
EXCIPIENT_LABEL_WATER = "Water"
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
