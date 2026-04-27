"""Default safety/regulatory limits shown on every specification sheet.

Values are copied from the ``FINAL - Specification Sheet`` tab of the
Valley workbook. The ``Organization.default_spec_limits`` JSON field
seeds with these on every new org; individual sheets can further
override via :attr:`SpecificationSheet.limits_override`.
"""

from __future__ import annotations


#: Canonical slug → display label for every row in the
#: ``Microbiological, PAH, Pesticides and Heavy Metal`` block. The
#: iteration order is the render order on the printable sheet. Any
#: new row goes here first — the rest of the codebase (default
#: seeding, override serializer, template) walks this tuple rather
#: than hardcoding individual keys.
SAFETY_LIMIT_ROWS: tuple[tuple[str, str], ...] = (
    ("total_aerobic", "Total Aerobic Microbial Count"),
    ("total_yeast", "Total Yeast Microbial Count"),
    ("e_coli", "E. Coli"),
    ("salmonella", "Salmonella"),
    ("pah", "PAH"),
    ("heavy_metal", "Heavy Metal"),
    ("pesticides", "Pesticides"),
    ("others", "Others"),
)


#: Default values seeded into ``Organization.default_spec_limits`` on
#: org creation. Keys match :data:`SAFETY_LIMIT_ROWS`.
DEFAULT_SAFETY_LIMITS: dict[str, str] = {
    "total_aerobic": "≤10,000",
    "total_yeast": "≤1,000",
    "e_coli": "Absence in 1g",
    "salmonella": "Absence in 10g",
    "pah": "≤50μg/kg",
    "heavy_metal": "≤10ppm",
    "pesticides": "Complies to EU regulatory",
    "others": "Non-GMO, Non-Irradiated, BSE/TSE free",
}


#: Section slugs the customer-facing renderer knows about. Each is an
#: independent toggle in ``SpecificationSheet.section_visibility`` —
#: absence from the dict is treated as visible so existing sheets
#: keep rendering as they always did.
SECTION_SLUGS: tuple[str, ...] = (
    "product_specification",
    "packaging_specification",
    "compliance",
    "allergens",
    "safety_limits",
    "actives",
    "nutrition",
    "amino_acids",
    "excipients",
    "ingredients",
    "signatures",
)


#: Section toggles that hide *cells* inside an otherwise-visible
#: section rather than the section as a whole. Mirrors the same
#: ``{slug: bool}`` shape used by :data:`SECTION_SLUGS` so writes
#: to ``section_visibility`` accept either a section name or one
#: of these column-level flags.
#:
#: ``excipients_numbers`` keeps the Excipient Information block
#: visible (header + ingredient names) but redacts the mg + %
#: cells. Useful when sharing a sheet with a customer who should
#: see the formulation outline without the exact quantities. The
#: bullet renderer collapses those cells to an em-dash.
COLUMN_VISIBILITY_SLUGS: tuple[str, ...] = (
    "excipients_numbers",
)


#: Combined whitelist the visibility validator accepts — section
#: toggles + column-level toggles in one map. Keeps the storage
#: schema backwards-compatible (still a flat ``{slug: bool}`` JSON).
VISIBILITY_SLUGS: tuple[str, ...] = SECTION_SLUGS + COLUMN_VISIBILITY_SLUGS


#: Default weight-uniformity tolerance as a percentage. Standard for
#: capsule + tablet dosage forms in the workbook.
DEFAULT_WEIGHT_UNIFORMITY_PCT = "10%"


#: Default copy rendered for the ``food_contact_status`` cell when
#: the scientist has not typed a sheet-specific value. Matches the
#: standing line every spec sheet carries (until a customer asks for
#: a more specific phrasing). Free-text override per sheet still wins.
DEFAULT_FOOD_CONTACT_STATUS = (
    "Packaging to be food-grade and fit for purpose."
)


#: Copy rendered in place of packaging selections until F3b adds real
#: linkage to the packaging catalogue.
PACKAGING_PLACEHOLDER = "TBD"


#: Per-dosage-form defaults seeded at :func:`create_sheet` time so the
#: scientist lands on a populated spec sheet rather than four blank
#: shelf-life / storage / weight-uniformity cells. Non-blank input
#: always wins; the snapshot's ``dosage_form`` decides which sub-map
#: to read. Liquid / other-solid forms stay blank — their conventions
#: vary too widely to seed safely.
SPECIFICATION_TEXT_DEFAULTS: dict[str, dict[str, str]] = {
    "capsule": {
        "shelf_life": "24 months from manufacture",
        "storage_conditions": (
            "Store in a cool, dry place below 25°C. "
            "Keep out of reach of children."
        ),
        "weight_uniformity": "10%",
    },
    "tablet": {
        "shelf_life": "24 months from manufacture",
        "storage_conditions": (
            "Store in a cool, dry place below 25°C. "
            "Keep out of reach of children."
        ),
        "weight_uniformity": "10%",
    },
    "gummy": {
        # Gummies have a noticeably shorter shelf life — sugar
        # alcohol matrices crystallise and lose chew over time, so
        # 12 months is the usual cap on the customer-facing sheet.
        "shelf_life": "12 months from manufacture",
        "storage_conditions": (
            "Store in a cool, dry place below 25°C. "
            "Keep out of reach of children."
        ),
        "weight_uniformity": "10%",
    },
    "powder": {
        "shelf_life": "24 months from manufacture",
        "storage_conditions": (
            "Store in a cool, dry place below 25°C. "
            "Keep out of reach of children."
        ),
        "weight_uniformity": "5%",
    },
}
