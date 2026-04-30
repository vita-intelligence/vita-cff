"""One-shot fixup: promote raw-material AttributeDefinitions that
should be dropdowns from TEXT → SINGLE_SELECT.

Background
----------
``scripts/import_raw_materials.py`` auto-sniffs each column as
``NUMBER`` or ``TEXT`` only — it has no awareness of which fields
are controlled vocabularies (``type``, ``use_as``, the four
compliance flags, etc.). So those landed in the catalogue as
free-text fields, and the UI renders them as plain text inputs
instead of dropdowns. This script promotes the affected definitions
in place.

What it does NOT do
-------------------
* Touch any ``Item.attributes`` payloads. Existing values like
  ``"Active"`` or ``"Vegan"`` stay exactly as imported and remain
  valid options in the new SINGLE_SELECT vocab.
* Convert numeric fields (``purity``, ``nrv_mg``) that landed as
  TEXT because of stray ``"N/A"`` rows. That's a separate data
  hygiene step.

Run with::

    .venv/bin/python manage.py shell < scripts/fix_raw_material_dropdowns.py
"""

from __future__ import annotations

import os
import sys
from collections import OrderedDict

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.models import RAW_MATERIALS_SLUG, Catalogue
from apps.formulations.constants import USE_AS_CANONICAL_VALUES
from apps.organizations.models import Organization


# Override at run time with ``VITA_IMPORT_ORG=...`` — same convention
# as the other scripts so a single env var targets the whole pipeline.
ORG_NAME = os.environ.get("VITA_IMPORT_ORG", "Vita Manufacture Limited")


# Fields that should be SINGLE_SELECT and the static option vocab to
# seed when promoting them. ``None`` means "scan the catalogue's
# items for distinct values and use those" — keeps the script honest
# for fields like ``type`` where the canonical list lives in the
# Excel rather than the codebase.
STATIC_VOCABS: dict[str, tuple[str, ...]] = {
    "use_as": USE_AS_CANONICAL_VALUES,
    "vegan": ("Vegan", "Non-Vegan"),
    "organic": ("Organic", "Non-Organic"),
    "halal": ("Halal", "Non-Halal"),
    "kosher": ("Kosher", "Non-Kosher"),
    "regulated": ("Regulated", "Unregulated"),
    "overall_risk_level": ("Low", "Medium", "High"),
    "allergen": ("Yes", "No"),
    "active_ingredient": ("Active", "Inactive"),
}


# Fields that should be SINGLE_SELECT but with options scanned from
# actual data (no canonical list to pin against — let the source of
# truth be what's already in the catalogue).
DATA_DRIVEN_FIELDS: tuple[str, ...] = (
    "type",
    "allergen_source",
)


def _existing_values(catalogue: Catalogue, attribute_key: str) -> list[str]:
    """Return distinct attribute values present on items, sorted.

    Reads ``Item.attributes->key`` and trims down to the unique
    non-empty strings so the resulting vocab matches what's already
    been imported.
    """

    from apps.catalogues.models import Item  # local import — avoid AppRegistry warm-up

    seen: dict[str, None] = OrderedDict()
    qs = Item.objects.filter(catalogue=catalogue).values_list("attributes", flat=True)
    for attrs in qs.iterator():
        if not isinstance(attrs, dict):
            continue
        value = attrs.get(attribute_key)
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        seen.setdefault(text, None)
    return sorted(seen.keys(), key=lambda s: s.lower())


def _build_options(values: list[str]) -> list[dict[str, str]]:
    return [{"value": v, "label": v} for v in values]


def _promote(
    definition: AttributeDefinition, options: list[dict[str, str]]
) -> bool:
    """Switch the def to SINGLE_SELECT + set options. Returns True
    when something actually changed (idempotent on rerun)."""

    changed = False
    if definition.data_type != DataType.SINGLE_SELECT:
        definition.data_type = DataType.SINGLE_SELECT
        changed = True
    if definition.options != options:
        definition.options = options
        changed = True
    if changed:
        definition.save(update_fields=["data_type", "options"])
    return changed


def run() -> None:
    organization = Organization.objects.filter(name=ORG_NAME).first()
    if organization is None:
        print(f"[error] organization '{ORG_NAME}' not found")
        sys.exit(1)

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        print(f"[error] raw_materials catalogue missing for '{organization.name}'")
        sys.exit(1)

    print(f"[info] promoting dropdowns on '{organization.name}' / {catalogue.slug}")

    promoted = 0
    skipped_unchanged = 0
    skipped_missing = 0

    # Static-vocab fields ----------------------------------------------------
    for key, vocab in STATIC_VOCABS.items():
        definition = AttributeDefinition.objects.filter(
            catalogue=catalogue, key=key
        ).first()
        if definition is None:
            print(f"[skip ] {key:<24}  not present in catalogue")
            skipped_missing += 1
            continue
        options = _build_options(list(vocab))
        if _promote(definition, options):
            promoted += 1
            print(
                f"[fix  ] {key:<24}  → SINGLE_SELECT  ({len(options)} options)"
            )
        else:
            skipped_unchanged += 1
            print(f"[skip ] {key:<24}  already SINGLE_SELECT")

    # Data-driven fields -----------------------------------------------------
    for key in DATA_DRIVEN_FIELDS:
        definition = AttributeDefinition.objects.filter(
            catalogue=catalogue, key=key
        ).first()
        if definition is None:
            print(f"[skip ] {key:<24}  not present in catalogue")
            skipped_missing += 1
            continue
        values = _existing_values(catalogue, key)
        if not values:
            print(
                f"[skip ] {key:<24}  no values on any item — leaving as TEXT"
            )
            skipped_unchanged += 1
            continue
        options = _build_options(values)
        if _promote(definition, options):
            promoted += 1
            print(
                f"[fix  ] {key:<24}  → SINGLE_SELECT  ({len(options)} options "
                f"scanned from data)"
            )
        else:
            skipped_unchanged += 1
            print(f"[skip ] {key:<24}  already SINGLE_SELECT")

    print()
    print("=" * 60)
    print(f"promoted to SINGLE_SELECT: {promoted}")
    print(f"already correct:           {skipped_unchanged}")
    print(f"missing from catalogue:    {skipped_missing}")


run()
