"""Backfill ``nutrition`` + ``amino_acids`` on existing ``FormulationVersion``
snapshots and extend every snapshot line's ``item_attributes`` with
the 11 nutrition keys + 18 amino acid keys.

F2b added the nutrition panel and amino-acid aggregator to
``save_version``'s snapshot output. Existing versions ship without
those keys, so every spec sheet rendered from an old version shows
zeros in both tables even when the source catalogue has real data.
This migration walks every version once and populates the missing
keys in place. Idempotent: re-running ``migrate`` is a no-op.

Nutrition / amino logic is inlined rather than imported from
:mod:`apps.formulations.services` so the migration stays frozen
against the F2b contract — a later refactor of the runtime services
will not retroactively rewrite history.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.db import migrations


_NUTRITION_KEYS = (
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

_AMINO_GROUPS = (
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

_AMINO_KEYS = tuple(k for _, keys in _AMINO_GROUPS for k in keys)


def _coerce_decimal(raw):
    if raw is None or raw == "":
        return None
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _nutrient_per_100g(attributes, key):
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


def _aggregate_nutrient(key, items_with_mg, total_weight_mg):
    per_serving = 0.0
    contributors = 0
    for item, mg in items_with_mg:
        per_100g = _nutrient_per_100g(item.attributes or {}, key)
        if per_100g is None:
            continue
        g_per_serving = float(mg) / 1000.0
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
    return {
        "key": key,
        "per_serving": str(Decimal(str(per_serving)).quantize(Decimal("0.0001"))),
        "per_100g": str(Decimal(str(per_100g_value)).quantize(Decimal("0.0001"))),
        "contributors": contributors,
    }


def _needs_backfill(version) -> bool:
    totals = version.snapshot_totals or {}
    has_nutrition = "nutrition" in totals and bool(
        totals.get("nutrition", {}).get("rows")
    )
    has_amino = "amino_acids" in totals and bool(
        totals.get("amino_acids", {}).get("groups")
    )
    lines = version.snapshot_lines or []
    attrs_complete = True
    if lines and isinstance(lines[0], dict):
        first_attrs = (lines[0].get("item_attributes") or {})
        # Use a single canonical probe — ``energy_kcal`` is the most
        # broadly populated nutrition field, so its presence is a
        # safe proxy for "this snapshot already learnt the new keys".
        attrs_complete = "energy_kcal" in first_attrs
    return not (has_nutrition and has_amino and attrs_complete)


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
        total_weight_mg = _coerce_decimal(snapshot_totals.get("total_weight_mg"))

        items_with_mg = []
        for line in snapshot_lines:
            if not isinstance(line, dict):
                continue
            item_id = line.get("item_id")
            if not item_id:
                continue
            item = Item.objects.filter(pk=item_id).first()
            if item is None:
                continue
            mg = _coerce_decimal(line.get("mg_per_serving"))
            if mg is None or mg <= 0:
                continue
            items_with_mg.append((item, mg))

            # Extend snapshot line attributes with the nutrition +
            # amino keys so future reads do not have to round-trip to
            # the catalogue.
            existing = dict(line.get("item_attributes") or {})
            attrs = item.attributes or {}
            for key in (*_NUTRITION_KEYS, *_AMINO_KEYS):
                if key not in existing:
                    existing[key] = attrs.get(key)
            line["item_attributes"] = existing

        snapshot_totals["nutrition"] = {
            "rows": [
                _aggregate_nutrient(key, items_with_mg, total_weight_mg)
                for key in _NUTRITION_KEYS
            ]
        }
        snapshot_totals["amino_acids"] = {
            "groups": [
                {
                    "key": group_key,
                    "acids": [
                        _aggregate_nutrient(
                            acid_key, items_with_mg, total_weight_mg
                        )
                        for acid_key in acids
                    ],
                }
                for group_key, acids in _AMINO_GROUPS
            ]
        }

        version.snapshot_totals = snapshot_totals
        version.snapshot_lines = snapshot_lines
        version.save(update_fields=["snapshot_totals", "snapshot_lines"])
        touched += 1

    print(
        f"    backfilled {touched} formulation version(s); "
        f"{skipped} already up-to-date"
    )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0002_backfill_snapshot_compliance_declaration"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
