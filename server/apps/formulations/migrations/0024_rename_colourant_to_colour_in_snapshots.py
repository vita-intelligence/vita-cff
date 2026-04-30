"""Rewrite the legacy ``colourant`` slug/label to ``colour`` on every
existing FormulationVersion.snapshot.

Background
----------
The powder flavour-system constant used to ship its colourant row as
``("colourant", "Colourant", 0.04)``. Every formulation snapshot
saved since then carries that slug + label inside its
``excipients.rows`` array — and the spec-sheet renderer reads
straight from the snapshot, so leaving the legacy strings in place
would render "Colourant (Beetroot)" forever even after the catalogue
side is renamed.

This migration walks every FormulationVersion, rewrites:

* any excipient row's ``slug == "colourant"`` to ``"colour"``
* any excipient row's ``label == "Colourant"`` to ``"Colour"``
* compound slugs of the form ``"colourant:<uuid>"`` (per-pick rows
  emitted by the picker logic — kept for forward-compat even though
  none should exist yet) to ``"colour:<uuid>"``

Lossless and idempotent — re-running on already-migrated snapshots
is a no-op.

Reverse migration restores the legacy strings so a rollback is
clean if ever needed (the in-flight Phase B frontend ships the new
strings, but holding back the rewrite means existing snapshots
still render under the old name — bookended cleanly).
"""

from __future__ import annotations

from django.db import migrations


def _rewrite_rows(rows: list, *, old: str, new: str) -> bool:
    """Mutate the ``rows`` list in place. Returns True if anything
    actually changed so the caller can avoid a no-op write."""

    changed = False
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict):
            continue
        slug = row.get("slug")
        if isinstance(slug, str):
            if slug == old:
                row["slug"] = new
                changed = True
            elif slug.startswith(f"{old}:"):
                row["slug"] = f"{new}{slug[len(old):]}"
                changed = True
        label = row.get("label")
        if isinstance(label, str) and label == old.title():
            row["label"] = new.title()
            changed = True
    return changed


def _walk_snapshot(snapshot: dict, *, old: str, new: str) -> bool:
    """Walk every nested ``rows`` array in the snapshot and rewrite
    legacy slug/label pairs. Snapshot shape is stable enough to
    target the known sites (``excipients.rows``,
    ``totals.excipients.rows`` for older shapes) without risking a
    blanket recursive rewrite that might touch unrelated keys.
    """

    changed = False
    if not isinstance(snapshot, dict):
        return False
    excipients = snapshot.get("excipients")
    if isinstance(excipients, dict):
        rows = excipients.get("rows")
        if _rewrite_rows(rows, old=old, new=new):
            changed = True
    totals = snapshot.get("totals")
    if isinstance(totals, dict):
        legacy_excipients = totals.get("excipients")
        if isinstance(legacy_excipients, dict):
            rows = legacy_excipients.get("rows")
            if _rewrite_rows(rows, old=old, new=new):
                changed = True
    return changed


def _rewrite(apps, *, old: str, new: str) -> None:
    FormulationVersion = apps.get_model("formulations", "FormulationVersion")
    updated = 0
    for version in FormulationVersion.objects.all():
        snapshot = version.snapshot or {}
        if _walk_snapshot(snapshot, old=old, new=new):
            version.snapshot = snapshot
            version.save(update_fields=["snapshot"])
            updated += 1
    print(f"  [colourant_rename] formulation versions updated: {updated}")


def forward(apps, schema_editor):
    _rewrite(apps, old="colourant", new="colour")


def reverse(apps, schema_editor):
    _rewrite(apps, old="colour", new="colourant")


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0023_formulation_sweetener_items"),
    ]

    operations = [
        migrations.RunPython(forward, reverse),
    ]
