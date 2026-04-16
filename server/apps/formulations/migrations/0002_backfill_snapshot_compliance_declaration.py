"""Backfill ``compliance`` + ``declaration`` + ``item_attributes`` on
existing ``FormulationVersion`` snapshots.

F2a added compliance aggregation and the ingredient declaration to
``save_version``'s snapshot, but versions saved before that release
ship without those keys. Every spec sheet generated from an old
version therefore renders empty Compliance and Ingredients sections.

This migration walks every existing ``FormulationVersion`` once,
re-reads each line's source ``Item`` from the catalogue, and fills
the missing keys in place. It is intentionally idempotent — running
``migrate`` again after the fact does nothing. Historical snapshots
that still reference a deleted raw material (impossible today thanks
to ``on_delete=PROTECT`` on ``FormulationLine.item``, but possible in
a future ``IngredientImport`` flow) are skipped for that one
ingredient rather than failing the whole migration.

Logic is inlined rather than imported from
:mod:`apps.formulations.services` so the migration stays frozen
against the current contract. A future refactor that changes the
runtime compute cascade will not retroactively alter history.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.db import migrations


# Label-copy and compliance constants, frozen against the F2a release.
# Must stay in lockstep with ``apps/formulations/constants.py`` for
# the backfill output to match a fresh ``save_version`` call.
_EXCIPIENT_LABEL_MCC = "Microcrystalline Cellulose (Carrier)"
_EXCIPIENT_LABEL_MG_STEARATE = "Magnesium Stearate"
_EXCIPIENT_LABEL_SILICA = "Silicon Dioxide"
_EXCIPIENT_LABEL_DCP = "Dicalcium Phosphate"
_CAPSULE_SHELL_LABEL = "Capsule Shell (Hypromellose)"

_COMPLIANCE_FLAGS = (
    ("vegan", "Vegan"),
    ("organic", "Organic"),
    ("halal", "Halal"),
    ("kosher", "Kosher"),
)

_CAPSULE_SHELL_WEIGHTS = {
    "size_1": 75.0,
    "single_0": 96.0,
    "double_00": 118.0,
    "size_3": 50.0,
}

# Math-critical attribute subset mirrored from ``_SNAPSHOT_ATTRIBUTE_KEYS``
# in the current services module. Keep in sync if that tuple grows.
_SNAPSHOT_ATTRIBUTE_KEYS = (
    "type",
    "purity",
    "extract_ratio",
    "overage",
    "ingredient_list_name",
    "nutrition_information_name",
    "vegan",
    "organic",
    "halal",
    "kosher",
    "nrv_mg",
)


def _normalize_compliance_value(raw):
    if raw is None:
        return None
    if isinstance(raw, bool):
        return raw
    if not isinstance(raw, str):
        return None
    lowered = raw.strip().lower()
    if not lowered:
        return None
    if lowered.startswith("non-") or lowered in {"no", "false"}:
        return False
    if lowered in {"yes", "true"}:
        return True
    return True


def _coerce_decimal(raw):
    if raw is None or raw == "":
        return None
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _needs_backfill(version) -> bool:
    totals = version.snapshot_totals or {}
    has_compliance = "compliance" in totals and bool(
        totals.get("compliance", {}).get("flags")
    )
    has_declaration = "declaration" in totals and "text" in totals.get(
        "declaration", {}
    )
    lines = version.snapshot_lines or []
    if not lines:
        # Empty snapshots still need the empty compliance block for
        # consistency so the UI's optional chain does not trip.
        return not (has_compliance and has_declaration)
    first = lines[0] if isinstance(lines[0], dict) else {}
    has_attrs = "item_attributes" in first
    return not (has_compliance and has_declaration and has_attrs)


def _build_line_attributes(item) -> dict:
    attrs = item.attributes or {}
    return {key: attrs.get(key) for key in _SNAPSHOT_ATTRIBUTE_KEYS}


def _aggregate_compliance(items) -> dict:
    flags = []
    for key, label in _COMPLIANCE_FLAGS:
        compliant = 0
        non_compliant = 0
        unknown = 0
        for item in items:
            decision = _normalize_compliance_value(
                (item.attributes or {}).get(key)
            )
            if decision is True:
                compliant += 1
            elif decision is False:
                non_compliant += 1
            else:
                unknown += 1
        if non_compliant > 0:
            status = False
        elif compliant > 0:
            status = True
        else:
            status = None
        flags.append(
            {
                "key": key,
                "label": label,
                "status": status,
                "compliant_count": compliant,
                "non_compliant_count": non_compliant,
                "unknown_count": unknown,
            }
        )
    return {"flags": flags}


def _build_declaration(items_by_external_id, snapshot_totals) -> dict:
    entries = []

    # Actives — pull the saved mg_per_serving from the parallel
    # snapshot_lines we are iterating in the caller. We receive them
    # here as a list of (external_id, item, mg) triples so sort is
    # stable against whatever key the caller picked (line.id for new
    # snapshots, item_id for backfilled old ones).
    for external_id, item, mg in items_by_external_id:
        if mg is None or mg <= 0:
            continue
        raw_list_name = (item.attributes or {}).get("ingredient_list_name")
        label = (
            raw_list_name.strip()
            if isinstance(raw_list_name, str) and raw_list_name.strip()
            else item.name
        )
        if not label:
            continue
        entries.append({"label": label, "mg": mg, "category": "active"})

    excipients = (snapshot_totals or {}).get("excipients") or {}
    mcc = _coerce_decimal(excipients.get("mcc_mg"))
    if mcc is not None and mcc > 0:
        entries.append(
            {"label": _EXCIPIENT_LABEL_MCC, "mg": mcc, "category": "excipient"}
        )
    dcp = _coerce_decimal(excipients.get("dcp_mg"))
    if dcp is not None and dcp > 0:
        entries.append(
            {"label": _EXCIPIENT_LABEL_DCP, "mg": dcp, "category": "excipient"}
        )
    stearate = _coerce_decimal(excipients.get("mg_stearate_mg"))
    if stearate is not None and stearate > 0:
        entries.append(
            {
                "label": _EXCIPIENT_LABEL_MG_STEARATE,
                "mg": stearate,
                "category": "excipient",
            }
        )
    silica = _coerce_decimal(excipients.get("silica_mg"))
    if silica is not None and silica > 0:
        entries.append(
            {
                "label": _EXCIPIENT_LABEL_SILICA,
                "mg": silica,
                "category": "excipient",
            }
        )

    dosage_form = (snapshot_totals or {}).get("dosage_form")
    size_key = (snapshot_totals or {}).get("size_key")
    if dosage_form == "capsule" and size_key:
        shell_weight = _CAPSULE_SHELL_WEIGHTS.get(size_key)
        if shell_weight:
            entries.append(
                {
                    "label": _CAPSULE_SHELL_LABEL,
                    "mg": Decimal(str(shell_weight)),
                    "category": "shell",
                }
            )

    # Descending by weight, tie-break by label so the string is
    # deterministic across runs. Serialise mg back to ``str`` for the
    # JSON column so reloads see the same shape the runtime code
    # produces.
    entries.sort(key=lambda e: (-float(e["mg"]), e["label"]))
    serialised = [
        {"label": e["label"], "mg": str(e["mg"]), "category": e["category"]}
        for e in entries
    ]
    text = ", ".join(e["label"] for e in entries)
    return {"text": text, "entries": serialised}


def backfill(apps, schema_editor):
    FormulationVersion = apps.get_model("formulations", "FormulationVersion")
    Item = apps.get_model("catalogues", "Item")

    versions = list(FormulationVersion.objects.all())
    touched = 0
    skipped = 0

    for version in versions:
        if not _needs_backfill(version):
            skipped += 1
            continue

        snapshot_lines = list(version.snapshot_lines or [])

        # Resolve each line's live Item so we can pull compliance +
        # label copy. Missing items are silently skipped for that
        # single line rather than failing the whole migration.
        resolved = []
        for line in snapshot_lines:
            if not isinstance(line, dict):
                continue
            item_id = line.get("item_id")
            if not item_id:
                continue
            item = Item.objects.filter(pk=item_id).first()
            if item is None:
                continue
            resolved.append((line, item))

        # Fill item_attributes on each snapshot line so the spec
        # sheet render context can reach them without re-querying.
        for line, item in resolved:
            if "item_attributes" not in line:
                line["item_attributes"] = _build_line_attributes(item)

        items = [item for _, item in resolved]
        compliance = _aggregate_compliance(items)

        declaration_inputs = [
            (
                line.get("item_id", ""),
                item,
                _coerce_decimal(line.get("mg_per_serving")),
            )
            for line, item in resolved
        ]
        declaration = _build_declaration(
            declaration_inputs, version.snapshot_totals or {}
        )

        totals = dict(version.snapshot_totals or {})
        totals["compliance"] = compliance
        totals["declaration"] = declaration

        version.snapshot_totals = totals
        version.snapshot_lines = snapshot_lines
        version.save(update_fields=["snapshot_totals", "snapshot_lines"])
        touched += 1

    print(
        f"    backfilled {touched} formulation version(s); "
        f"{skipped} already up-to-date"
    )


def noop_reverse(apps, schema_editor):
    # No reverse — the forward migration only *adds* keys. Rolling it
    # back would throw away legitimate data written after the fact.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(backfill, noop_reverse),
    ]
