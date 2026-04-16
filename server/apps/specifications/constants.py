"""Default safety/regulatory limits shown on every specification sheet.

Values are copied from the ``FINAL - Specification Sheet`` tab of the
Valley Low Fat Burner workbook. Scientists can override on a per-sheet
basis in F3b; for F3a we render the defaults directly.
"""

from __future__ import annotations


#: Fixed microbiological + heavy metal + pesticide limits shown on
#: every specification sheet. The display order matches the left
#: column of the ``FINAL - Specification Sheet`` tab.
DEFAULT_SAFETY_LIMITS: tuple[tuple[str, str], ...] = (
    ("Total Aerobic Microbial Count", "≤10,000"),
    ("Total Yeast Microbial Count", "≤1,000"),
    ("E. Coli", "Absence in 1g"),
    ("Salmonella", "Absence in 10g"),
    ("PAH", "≤50μg/kg"),
    ("Heavy Metal", "≤10ppm"),
    ("Pesticides", "Complies to EU regulatory"),
)


#: Default weight-uniformity tolerance as a percentage. Standard for
#: capsule + tablet dosage forms in the workbook.
DEFAULT_WEIGHT_UNIFORMITY_PCT = "10%"


#: Copy rendered in place of packaging selections until F3b adds real
#: linkage to the packaging catalogue.
PACKAGING_PLACEHOLDER = "TBD"
