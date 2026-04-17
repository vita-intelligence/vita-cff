"""Backfill allergen data on existing :class:`FormulationVersion`
snapshots.

The V2 NPD template added ``Allergen``, ``Allergen Source`` and
``Typical Country of Origin`` columns to the raw materials catalogue.
Existing version snapshots pre-date those keys, so every spec sheet
rendered from an old version would show no allergen information even
when the source ingredients are flagged in the live catalogue.

This migration walks every version once and:

1. Extends each ``snapshot_lines[*]['item_attributes']`` with the
   three new keys (null when the catalogue row has no value).
2. Tags every existing declaration entry whose source ingredient is
   an allergen with ``is_allergen`` and ``allergen_source`` — mirrors
   how :func:`build_ingredient_declaration` now stamps those fields
   at save time.
3. Writes ``snapshot_totals['allergens']`` with the aggregated
   distinct-source list.

Idempotent: re-running ``migrate`` is a no-op. The probe is whether
``snapshot_totals`` already carries an ``allergens`` key.

Inlines the minimal allergen logic instead of importing from
:mod:`apps.formulations.services` so the migration stays frozen
against the V2 contract — a later refactor of the runtime service
will not retroactively rewrite history.
"""

from __future__ import annotations

from django.db import migrations


_ALLERGEN_KEYS: tuple[str, ...] = (
    "allergen",
    "allergen_source",
    "typical_country_of_origin",
)


def _is_allergen(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"yes", "true", "1"}
    return False


def _clean_source(value: object) -> str:
    if not isinstance(value, str):
        return ""
    trimmed = value.strip()
    if not trimmed or trimmed.lower() in {"none", "#value!"}:
        return ""
    return trimmed


def _needs_backfill(version) -> bool:
    totals = version.snapshot_totals or {}
    return "allergens" not in totals


def backfill(apps, schema_editor):
    FormulationVersion = apps.get_model("formulations", "FormulationVersion")
    Item = apps.get_model("catalogues", "Item")

    touched = 0
    skipped = 0

    for version in FormulationVersion.objects.all():
        if not _needs_backfill(version):
            skipped += 1
            continue

        snapshot_lines = list(version.snapshot_lines or [])
        snapshot_totals = dict(version.snapshot_totals or {})

        # Pull the live catalogue rows once for the lines that
        # reference a real item — cheaper than hammering the DB
        # per line. Missing items (rare, but possible after a
        # catalogue purge) fall back to ``None`` and contribute
        # ``False`` to the allergen flag.
        item_ids = [
            line.get("item_id") for line in snapshot_lines if isinstance(line, dict)
        ]
        items_by_id = {
            str(item.id): item
            for item in Item.objects.filter(pk__in=[i for i in item_ids if i])
        }

        sources: set[str] = set()
        allergen_count = 0

        for line in snapshot_lines:
            if not isinstance(line, dict):
                continue
            item = items_by_id.get(str(line.get("item_id") or ""))
            existing = dict(line.get("item_attributes") or {})
            if item is not None:
                attrs = item.attributes or {}
                for key in _ALLERGEN_KEYS:
                    if key not in existing:
                        existing[key] = attrs.get(key)
            line["item_attributes"] = existing

            if _is_allergen(existing.get("allergen")):
                allergen_count += 1
                source = _clean_source(existing.get("allergen_source"))
                if source:
                    sources.add(source)

        # Patch the declaration entries in place — the runtime now
        # emits ``is_allergen`` / ``allergen_source`` on every entry,
        # so historic snapshots need the same fields to stay
        # renderable by the new template without special-casing.
        declaration = snapshot_totals.get("declaration") or {}
        entries = list(declaration.get("entries") or [])
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if entry.get("category") != "active":
                entry.setdefault("is_allergen", False)
                entry.setdefault("allergen_source", "")
                continue
            # Match the entry back to a catalogue item by scanning
            # snapshot_lines — ingredient labels may have been
            # templated (``(From ??mg of 10:1 Extract)``) so a
            # naive name match is not reliable.
            label = entry.get("label", "")
            matching_line = None
            for line in snapshot_lines:
                if not isinstance(line, dict):
                    continue
                attrs = line.get("item_attributes") or {}
                ingredient_name = (
                    attrs.get("ingredient_list_name") or ""
                ).strip().rstrip(",").strip()
                if ingredient_name and ingredient_name == label:
                    matching_line = line
                    break
                # Fallback: templated label starts with the base
                # name (e.g. ``Citrus Bioflavonoid Extract (From
                # 35mg of 5:1 Extract)`` starts with the list name).
                if ingredient_name and label.startswith(ingredient_name):
                    matching_line = line
                    break
            if matching_line is None:
                entry.setdefault("is_allergen", False)
                entry.setdefault("allergen_source", "")
                continue
            attrs = matching_line.get("item_attributes") or {}
            is_allergen = _is_allergen(attrs.get("allergen"))
            entry["is_allergen"] = is_allergen
            entry["allergen_source"] = (
                _clean_source(attrs.get("allergen_source"))
                if is_allergen
                else ""
            )
        if entries:
            declaration["entries"] = entries
            snapshot_totals["declaration"] = declaration

        snapshot_totals["allergens"] = {
            "sources": sorted(sources),
            "allergen_count": allergen_count,
        }

        version.snapshot_totals = snapshot_totals
        version.snapshot_lines = snapshot_lines
        version.save(update_fields=["snapshot_totals", "snapshot_lines"])
        touched += 1

    print(
        f"    backfilled {touched} formulation version(s) with allergen "
        f"data; {skipped} already up-to-date"
    )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0004_backfill_snapshot_anticaking_grouping"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
