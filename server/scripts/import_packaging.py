"""One-off import for the `Packaging Information` sheet.

The sheet lays out five packaging sections side-by-side (primary
material, closure, label, tamper proof, tertiary), each with the same
8-column shape. We import every row into the ``packaging`` catalogue
of the ``Drink Better`` organization and tag it with a
``packaging_type`` attribute so the formulation engine can filter by
section later.

Run it with::

    .venv/bin/python manage.py shell < scripts/import_packaging.py
"""

from __future__ import annotations

import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.models import PACKAGING_SLUG, Catalogue
from apps.catalogues.services import ItemInternalCodeConflict, create_item
from apps.organizations.models import Organization


FILE_PATH = "/Users/maxchergik/Downloads/Raw Material Data (FOR FORMULATION - DO NOT MOVE OR CHANGE NAME) NEW.xlsx"
SHEET_NAME = "Packaging Information"
ORG_NAME = "Drink Better"

HEADER_ROW_INDEX = 2  # row 3 in the spreadsheet, the short header labels
DATA_START_INDEX = 5  # row 6 onward is real data (row 5 is a "None -" placeholder)


# Each section has the same 8-column layout. ``start`` is the column
# index of its name/code/attrs block. Names were sourced from the
# long-form header row above the short labels.
SECTIONS: tuple[tuple[str, int], ...] = (
    ("material", 0),
    ("closure", 9),
    ("label", 18),
    ("tamper_proof", 27),
    ("tertiary", 36),
)


# Attribute definitions we want on the ``packaging`` catalogue. Keys
# are stable snake_case; labels are the human-facing copy.
ATTR_DEFINITIONS: tuple[tuple[str, str, str], ...] = (
    ("packaging_type", "Packaging Type", DataType.SINGLE_SELECT),
    ("volume", "Volume", DataType.TEXT),
    ("dimension", "Dimension", DataType.TEXT),
    ("material", "Material", DataType.TEXT),
    ("resealable", "Resealable", DataType.TEXT),
    ("hole", "Hole", DataType.TEXT),
    ("tamper_type", "Tamper Type", DataType.TEXT),
    ("others", "Others", DataType.TEXT),
    ("weight", "Weight (g)", DataType.NUMBER),
)


PACKAGING_TYPE_OPTIONS: tuple[dict[str, str], ...] = (
    {"value": "material", "label": "Material"},
    {"value": "closure", "label": "Closure"},
    {"value": "label", "label": "Label"},
    {"value": "tamper_proof", "label": "Tamper Proof"},
    {"value": "tertiary", "label": "Tertiary"},
)


def _blank(value: object) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        trimmed = value.strip()
        return not trimmed or trimmed == "-"
    return False


def _str(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _num(value: object) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float, Decimal)):
        try:
            return float(value)
        except (InvalidOperation, ValueError):
            return None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed or trimmed == "-":
            return None
        try:
            return float(Decimal(trimmed))
        except (InvalidOperation, ValueError):
            return None
    return None


def _row_is_blank(row: tuple, start: int) -> bool:
    return _blank(row[start]) or _str(row[start]).lower() == "none"


def _extract_attributes(
    row: tuple,
    start: int,
    section_type: str,
) -> dict[str, object]:
    """Turn a row-slice into a dict keyed by AttributeDefinition key.

    Column layout per section (relative to ``start``):

    * 0 — name (handled by caller)
    * 1 — code (handled by caller)
    * 2 — volume
    * 3 — dimension / diameter
    * 4 — material / type
    * 5 — resealable (material) / tamper (closure) / type (label+) /
          resealable equivalent for others
    * 6 — hole (material) / others (rest)
    * 7 — weight
    """

    attrs: dict[str, object] = {"packaging_type": section_type}

    volume = _str(row[start + 2])
    if volume and volume != "-":
        attrs["volume"] = volume

    dimension = _str(row[start + 3])
    if dimension and dimension != "-":
        attrs["dimension"] = dimension

    material = _str(row[start + 4])
    if material and material != "-":
        attrs["material"] = material

    col5 = _str(row[start + 5])
    col6 = _str(row[start + 6])

    if section_type == "material":
        if col5 and col5 != "-":
            attrs["resealable"] = col5
        if col6 and col6 != "-":
            attrs["hole"] = col6
    elif section_type == "closure":
        if col5 and col5 != "-":
            attrs["tamper_type"] = col5
        if col6 and col6 != "-":
            attrs["others"] = col6
    else:  # label, tamper_proof, tertiary — all share the same layout
        if col5 and col5 != "-":
            attrs["tamper_type"] = col5
        if col6 and col6 != "-":
            attrs["others"] = col6

    weight = _num(row[start + 7])
    if weight is not None:
        attrs["weight"] = weight

    return attrs


def _ensure_definitions(catalogue: Catalogue, actor) -> None:
    """Create the attribute definitions we need, idempotently."""

    existing = {
        d.key: d
        for d in AttributeDefinition.objects.filter(catalogue=catalogue)
    }
    for order, (key, label, data_type) in enumerate(ATTR_DEFINITIONS):
        if key in existing:
            print(f"[def ] reusing  {key:<18} [{existing[key].data_type}]")
            continue
        options: list[dict[str, str]] = []
        if data_type == DataType.SINGLE_SELECT and key == "packaging_type":
            options = list(PACKAGING_TYPE_OPTIONS)
        AttributeDefinition.objects.create(
            catalogue=catalogue,
            key=key,
            label=label,
            data_type=data_type,
            required=False,
            options=options,
            display_order=order,
            created_by=actor,
            updated_by=actor,
        )
        print(f"[def ] created  {key:<18} [{data_type}]")


def run() -> None:
    if not Path(FILE_PATH).exists():
        print(f"[error] file not found: {FILE_PATH}")
        sys.exit(1)

    organization = Organization.objects.filter(name=ORG_NAME).first()
    if organization is None:
        print(f"[error] organization '{ORG_NAME}' not found")
        sys.exit(1)
    actor = organization.created_by

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=PACKAGING_SLUG
    ).first()
    if catalogue is None:
        print(f"[error] packaging catalogue missing for '{organization.name}'")
        sys.exit(1)

    print(
        f"[info] importing into '{organization.name}' / {catalogue.slug} "
        f"as {actor.email}"
    )

    _ensure_definitions(catalogue, actor)

    workbook = openpyxl.load_workbook(FILE_PATH, read_only=True, data_only=True)
    sheet = workbook[SHEET_NAME]
    rows = list(sheet.iter_rows(values_only=True))
    print(f"[info] raw rows in '{SHEET_NAME}': {len(rows)}")

    per_section_created: dict[str, int] = {name: 0 for name, _ in SECTIONS}
    skipped_duplicates = 0
    skipped_empty = 0
    failed = 0

    for section_type, start in SECTIONS:
        for row_number in range(DATA_START_INDEX, len(rows)):
            row = rows[row_number]
            # Guard against short rows that don't reach this section.
            if start + 8 > len(row):
                continue
            if _row_is_blank(row, start):
                skipped_empty += 1
                continue

            name = _str(row[start])
            if not name:
                skipped_empty += 1
                continue

            code = _str(row[start + 1])
            attributes = _extract_attributes(row, start, section_type)

            try:
                create_item(
                    catalogue=catalogue,
                    actor=actor,
                    name=name,
                    internal_code=code,
                    unit="",
                    base_price=None,
                    attributes=attributes,
                )
                per_section_created[section_type] += 1
            except ItemInternalCodeConflict:
                skipped_duplicates += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"[warn] row {row_number} ({name!r}) failed: {exc}")

    print()
    print("=" * 60)
    total_created = sum(per_section_created.values())
    for section_type, count in per_section_created.items():
        print(f"  {section_type:<14} {count:>4}")
    print(f"  {'TOTAL':<14} {total_created:>4}")
    print(f"skipped empty rows:  {skipped_empty}")
    print(f"skipped duplicates:  {skipped_duplicates}")
    print(f"failed rows:         {failed}")


run()
