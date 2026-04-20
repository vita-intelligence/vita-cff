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
    "safety_limits",
    "actives",
    "nutrition",
    "amino_acids",
    "excipients",
    "ingredients",
    "signatures",
)


#: Default weight-uniformity tolerance as a percentage. Standard for
#: capsule + tablet dosage forms in the workbook.
DEFAULT_WEIGHT_UNIFORMITY_PCT = "10%"


#: Copy rendered in place of packaging selections until F3b adds real
#: linkage to the packaging catalogue.
PACKAGING_PLACEHOLDER = "TBD"
