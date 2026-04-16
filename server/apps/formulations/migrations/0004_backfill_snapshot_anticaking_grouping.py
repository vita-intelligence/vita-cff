"""Collapse the separate ``Magnesium Stearate`` + ``Silicon Dioxide``
declaration entries on every existing ``FormulationVersion`` into the
combined ``Anticaking Agents (Magnesium Stearate, Silicon Dioxide)``
entry the spec sheet now renders.

The Valley Low Fat Burner workbook collapses both flow agents into a
single ingredient-list line; rendering them apart leaks unnecessary
manufacturing detail to the customer. This migration rewrites the
``snapshot_totals['declaration']`` block in place — frozen-in-time,
inlined logic so a later refactor of the runtime services cannot
retroactively rewrite history. Idempotent: re-running the migration
is a no-op once the merged entry is present.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.db import migrations


_LABEL_MG_STEARATE = "Magnesium Stearate"
_LABEL_SILICA = "Silicon Dioxide"
_LABEL_ANTICAKING = (
    "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)"
)


def _coerce_decimal(raw):
    if raw is None or raw == "":
        return Decimal("0")
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal("0")


def _needs_backfill(declaration: dict) -> bool:
    entries = declaration.get("entries") or []
    has_separate = any(
        isinstance(e, dict) and e.get("label") in {_LABEL_MG_STEARATE, _LABEL_SILICA}
        for e in entries
    )
    return has_separate


def _rebuild_declaration(declaration: dict) -> dict:
    entries = list(declaration.get("entries") or [])
    stearate_mg = Decimal("0")
    silica_mg = Decimal("0")
    kept: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            kept.append(entry)
            continue
        label = entry.get("label")
        if label == _LABEL_MG_STEARATE:
            stearate_mg += _coerce_decimal(entry.get("mg"))
            continue
        if label == _LABEL_SILICA:
            silica_mg += _coerce_decimal(entry.get("mg"))
            continue
        kept.append(entry)

    combined = stearate_mg + silica_mg
    if combined > 0:
        kept.append(
            {
                "label": _LABEL_ANTICAKING,
                "mg": str(combined),
                "category": "excipient",
            }
        )

    # Re-sort by mg descending to match the runtime sort key.
    def _sort_key(entry):
        mg = _coerce_decimal(entry.get("mg"))
        # Descending mg, then label asc as a stable tiebreaker.
        return (-float(mg), entry.get("label", ""))

    kept.sort(key=_sort_key)

    return {
        "text": ", ".join(
            entry.get("label", "")
            for entry in kept
            if isinstance(entry, dict) and entry.get("label")
        ),
        "entries": kept,
    }


def backfill(apps, schema_editor):
    FormulationVersion = apps.get_model("formulations", "FormulationVersion")

    touched = 0
    skipped = 0
    for version in FormulationVersion.objects.all():
        totals = version.snapshot_totals or {}
        declaration = totals.get("declaration") or {}
        if not _needs_backfill(declaration):
            skipped += 1
            continue

        new_declaration = _rebuild_declaration(declaration)
        totals["declaration"] = new_declaration
        version.snapshot_totals = totals
        version.save(update_fields=["snapshot_totals"])
        touched += 1

    print(
        f"    rewrote {touched} formulation version(s) to use the "
        f"Anticaking Agents declaration entry; {skipped} already up-to-date"
    )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0003_backfill_snapshot_nutrition_amino"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
