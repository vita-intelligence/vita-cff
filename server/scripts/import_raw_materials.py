"""One-off import script for the Raw Material Information spreadsheet.

Reads the ``Raw Material Information`` sheet from the user's raw-material
workbook, resolves ``Raw Material`` as the item name, ``Code`` as the
internal code, and every other column as a typed dynamic attribute.

Column types are sniffed from the data:

* Every non-null value parses as a number → ``NUMBER``
* Otherwise → ``TEXT``

Run it with::

    .venv/bin/python manage.py shell < scripts/import_raw_materials.py
"""

from __future__ import annotations

import os
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

import openpyxl

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.models import RAW_MATERIALS_SLUG, Catalogue
from apps.catalogues.services import create_item, ItemInternalCodeConflict
from apps.formulations.constants import AMINO_ACID_KEYS, NUTRITION_KEYS
from apps.organizations.models import Organization


FILE_PATH = "/Users/maxchergik/Downloads/Raw Material Data (FOR FORMULATION - DO NOT MOVE OR CHANGE NAME) NEW.xlsx"
SHEET_NAME = "Raw Material Information"
# Override at run time with ``VITA_IMPORT_ORG=...`` so the same script
# can target prod's "Vita Manufacture Limited" or a local dev org
# (e.g. "Vita Dev Server") without editing the file.
ORG_NAME = os.environ.get("VITA_IMPORT_ORG", "Vita Manufacture Limited")
HEADER_ROW_INDEX = 3  # Row 4 in the spreadsheet (0-indexed here)
DATA_START_INDEX = 4  # Row 5 onwards is real data


# Header → canonical-key remap. The source workbook is hand-typed and
# carries a few persistent typos that downstream features can't fold
# at read time (unlike ``use_as`` which has its own normalisation
# layer). Each entry is ``slug_from_excel → key_features_expect``.
HEADER_KEY_ALIASES: dict[str, str] = {
    # Workbook has 'Phylalanine' (missing the 'en'); spec sheet's
    # amino acid panel reads from 'phenylalanine'.
    "phylalanine": "phenylalanine",
}


# Canonical attribute keys the features depend on. Used by the
# end-of-import audit so we can spot-check that everything landed.
CANONICAL_KEYS: dict[str, list[str]] = {
    "math/identity": [
        "purity",
        "extract_ratio",
        "overage",
        "ingredient_list_name",
        "nutrition_information_name",
    ],
    "classification": ["type", "use_as"],
    "compliance": ["vegan", "organic", "halal", "kosher"],
    "allergens": ["allergen", "allergen_source"],
    "nrv": ["nrv_mg"],
    "nutrition": list(NUTRITION_KEYS),
    "amino_acids": list(AMINO_ACID_KEYS),
}


def _slugify(label: str) -> str:
    """Turn a spreadsheet column label into a stable snake_case key."""

    slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
    if not slug:
        slug = "attr"
    if not slug[0].isalpha():
        slug = f"col_{slug}"
    return slug[:64]


def _is_numeric(value: object) -> bool:
    if value is None or value == "":
        return True  # treat blanks as "compatible with number"
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float, Decimal)):
        return True
    if isinstance(value, str):
        try:
            Decimal(value.strip())
            return True
        except (InvalidOperation, ValueError):
            return False
    return False


def _all_blank(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


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
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        print(
            f"[error] raw_materials catalogue missing for '{organization.name}'"
        )
        sys.exit(1)

    print(
        f"[info] importing into '{organization.name}' / {catalogue.slug} "
        f"as {actor.email}"
    )

    workbook = openpyxl.load_workbook(FILE_PATH, read_only=True, data_only=True)
    sheet = workbook[SHEET_NAME]
    rows = list(sheet.iter_rows(values_only=True))
    header = rows[HEADER_ROW_INDEX]
    data_rows = rows[DATA_START_INDEX:]
    print(f"[info] header columns: {len(header)}")
    print(f"[info] raw data rows (pre-filter): {len(data_rows)}")

    # Filter out fully blank rows up-front so sniffing is accurate.
    data_rows = [r for r in data_rows if not all(_all_blank(c) for c in r)]
    print(f"[info] non-empty data rows: {len(data_rows)}")

    # Column 0 = name, column 1 = code. Everything else is an attribute.
    NAME_COL = 0
    CODE_COL = 1

    attribute_columns: list[tuple[int, str, str]] = []
    existing_by_key = {
        d.key: d
        for d in AttributeDefinition.objects.filter(catalogue=catalogue)
    }
    used_keys: set[str] = set()
    created_defs = 0

    for col_idx, label in enumerate(header):
        if col_idx in (NAME_COL, CODE_COL):
            continue
        if label is None or (isinstance(label, str) and not label.strip()):
            continue
        label_clean = str(label).strip()

        base_key = _slugify(label_clean)
        # Apply known header → canonical-key aliases (Phylalanine
        # typo etc.) before the dedupe loop so a renamed column still
        # collides with itself if the workbook ever lists it twice.
        base_key = HEADER_KEY_ALIASES.get(base_key, base_key)
        key = base_key
        suffix = 2
        while key in used_keys:
            key = f"{base_key}_{suffix}"
            suffix += 1
        used_keys.add(key)

        # Sniff data type from every sample in this column.
        samples = [r[col_idx] if col_idx < len(r) else None for r in data_rows]
        if all(_is_numeric(v) for v in samples):
            data_type = DataType.NUMBER
        else:
            data_type = DataType.TEXT

        # Create (or reuse) the definition.
        existing = existing_by_key.get(key)
        if existing is None:
            AttributeDefinition.objects.create(
                catalogue=catalogue,
                key=key,
                label=label_clean,
                data_type=data_type,
                required=False,
                options=[],
                display_order=col_idx,
                created_by=actor,
                updated_by=actor,
            )
            created_defs += 1
            print(f"[def ] created  {key:<28} [{data_type}]  '{label_clean}'")
        else:
            print(f"[def ] reusing  {key:<28} [{existing.data_type}]  '{label_clean}'")

        attribute_columns.append((col_idx, key, data_type))

    print(f"[info] attribute definitions created: {created_defs}")
    print(f"[info] total attribute columns mapped: {len(attribute_columns)}")

    # Import rows.
    created_items = 0
    skipped_empty_name = 0
    skipped_duplicate = 0
    failed = 0

    for row_number, row in enumerate(data_rows, start=DATA_START_INDEX + 1):
        raw_name = row[NAME_COL] if NAME_COL < len(row) else None
        if raw_name is None or (
            isinstance(raw_name, str) and not raw_name.strip()
        ):
            skipped_empty_name += 1
            continue
        name = str(raw_name).strip()

        code_value = row[CODE_COL] if CODE_COL < len(row) else None
        internal_code = (
            "" if code_value is None else str(code_value).strip()
        )

        attributes: dict[str, object] = {}
        for col_idx, key, data_type in attribute_columns:
            raw = row[col_idx] if col_idx < len(row) else None
            if raw is None or (isinstance(raw, str) and not raw.strip()):
                continue
            if data_type == DataType.NUMBER:
                try:
                    attributes[key] = float(
                        Decimal(str(raw).strip())
                    )
                except (InvalidOperation, ValueError):
                    # Leave the cell out rather than fail the row.
                    continue
            else:
                attributes[key] = str(raw).strip()

        try:
            create_item(
                catalogue=catalogue,
                actor=actor,
                name=name,
                internal_code=internal_code,
                unit="",
                base_price=None,
                attributes=attributes,
            )
            created_items += 1
        except ItemInternalCodeConflict:
            skipped_duplicate += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"[warn] row {row_number} ({name!r}) failed: {exc}")

    print()
    print("=" * 60)
    print(f"created items:        {created_items}")
    print(f"skipped empty names:  {skipped_empty_name}")
    print(f"skipped duplicates:   {skipped_duplicate}")
    print(f"failed rows:          {failed}")
    print(f"attribute defs added: {created_defs}")

    # Canonical schema audit — confirm every key the features rely
    # on actually has a definition after the import. A missing key
    # here means the matching column was absent from the workbook
    # OR the slug didn't survive the alias step.
    print()
    print("=" * 60)
    print("Canonical schema audit:")
    all_keys = {
        d.key
        for d in AttributeDefinition.objects.filter(catalogue=catalogue)
    }
    missing_total = 0
    for group, keys in CANONICAL_KEYS.items():
        print(f"\n  [{group}]")
        for key in keys:
            ok = key in all_keys
            marker = "OK     " if ok else "MISSING"
            print(f"    [{marker}] {key}")
            if not ok:
                missing_total += 1
    print()
    print(f"canonical keys missing: {missing_total}")


run()
