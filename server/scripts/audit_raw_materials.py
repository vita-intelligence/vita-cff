"""One-off data-quality audit for the raw materials catalogue.

Reports, across every item in the ``raw_materials`` catalogue of the
``Drink Better`` organization:

1. **F1 blockers** — items that cannot produce an ``mg/serving`` value
   because they are missing the field the formulation cascade needs
   (``extract_ratio`` for botanicals, ``purity`` for everything else).
   Any formulation line that picks one of these rows silently
   contributes ``0`` to the total until the catalogue row is fixed.

2. **F2 nutrition gaps** — items missing any of the eleven nutrition
   columns (kcal, kJ, fat × 4, carb, sugar, fibre, protein, salt).
   A product whose formula includes one of these will have an
   incomplete nutrition facts panel.

3. **F2 compliance gaps** — items missing the vegan / organic / halal
   / kosher Yes-No flags. A missing flag prevents the aggregation
   from returning a confident answer for the whole product.

4. **Label copy gaps** — items missing ``Ingredient list Name`` or
   ``Nutrition information Name``. The final ingredient declaration
   falls back to the raw material's internal name, which is usually
   more technical than the label-friendly version.

5. **%NRV gap** — items whose ``NRV (mg)`` column is non-numeric
   (imported as ``N/A`` text), blocking the F3 %NRV column on the
   spec sheet.

Run with::

    .venv/bin/python manage.py shell < scripts/audit_raw_materials.py

Non-destructive: reads only, never writes.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from apps.catalogues.models import Catalogue, Item, RAW_MATERIALS_SLUG
from apps.organizations.models import Organization


ORG_NAME = "Drink Better"


NUTRITION_KEYS: tuple[str, ...] = (
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

COMPLIANCE_KEYS: tuple[str, ...] = ("vegan", "organic", "halal", "kosher")


def _is_numeric(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float, Decimal)):
        return True
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed or trimmed.upper() in {"N/A", "NA", "-"}:
            return False
        try:
            Decimal(trimmed)
            return True
        except (InvalidOperation, ValueError):
            return False
    return False


def _is_present(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _is_botanical(attrs: dict) -> bool:
    raw = attrs.get("type")
    return isinstance(raw, str) and raw.strip().lower() == "botanical"


def _blocking_math_reason(attrs: dict) -> str | None:
    if _is_botanical(attrs):
        if not _is_numeric(attrs.get("extract_ratio")):
            return "missing extract_ratio"
        return None
    if not _is_numeric(attrs.get("purity")):
        return "missing purity"
    return None


def _missing_nutrition_keys(attrs: dict) -> list[str]:
    return [k for k in NUTRITION_KEYS if not _is_numeric(attrs.get(k))]


def _missing_compliance_keys(attrs: dict) -> list[str]:
    return [k for k in COMPLIANCE_KEYS if not _is_present(attrs.get(k))]


def _bar(count: int, total: int, width: int = 30) -> str:
    filled = int(round((count / total) * width)) if total else 0
    return "█" * filled + "·" * (width - filled)


def run() -> None:
    organization = Organization.objects.filter(name=ORG_NAME).first()
    if organization is None:
        print(f"[error] organization '{ORG_NAME}' not found")
        return
    catalogue = Catalogue.objects.filter(
        organization=organization, slug=RAW_MATERIALS_SLUG
    ).first()
    if catalogue is None:
        print(f"[error] raw_materials catalogue missing for '{ORG_NAME}'")
        return

    items = list(
        Item.objects.filter(catalogue=catalogue, is_archived=False).order_by("name")
    )
    total = len(items)
    if total == 0:
        print("[info] catalogue is empty — nothing to audit")
        return

    print(f"Auditing {total} raw materials in '{organization.name}'\n")

    # ------------------------------------------------------------------
    # 1. F1 blockers
    # ------------------------------------------------------------------
    math_blocked: list[tuple[Item, str]] = []
    botanical_missing_extract = 0
    non_botanical_missing_purity = 0
    for item in items:
        reason = _blocking_math_reason(item.attributes or {})
        if reason is None:
            continue
        math_blocked.append((item, reason))
        if reason == "missing extract_ratio":
            botanical_missing_extract += 1
        else:
            non_botanical_missing_purity += 1

    print("=" * 72)
    print("F1 formulation math readiness")
    print("=" * 72)
    ready = total - len(math_blocked)
    pct = (ready / total) * 100 if total else 0
    print(f"  {_bar(ready, total)}  {ready} / {total} ({pct:.1f}%) can compute mg/serving")
    print(f"  {len(math_blocked)} rows are blocked:")
    print(f"    · {botanical_missing_extract} botanicals missing extract_ratio")
    print(f"    · {non_botanical_missing_purity} non-botanicals missing purity")
    if math_blocked:
        print("\n  First 15 blocked rows:")
        for item, reason in math_blocked[:15]:
            print(f"    · {item.name[:55]:<55}  ({reason})")
        if len(math_blocked) > 15:
            print(f"    · … and {len(math_blocked) - 15} more")

    # ------------------------------------------------------------------
    # 2. F2 nutrition gaps
    # ------------------------------------------------------------------
    nutrition_complete = 0
    partial_missing: list[tuple[Item, int]] = []
    fully_missing: list[Item] = []
    missing_by_key = {k: 0 for k in NUTRITION_KEYS}
    for item in items:
        attrs = item.attributes or {}
        missing = _missing_nutrition_keys(attrs)
        for k in missing:
            missing_by_key[k] += 1
        if not missing:
            nutrition_complete += 1
        elif len(missing) == len(NUTRITION_KEYS):
            fully_missing.append(item)
        else:
            partial_missing.append((item, len(missing)))

    print()
    print("=" * 72)
    print("F2 nutrition panel readiness")
    print("=" * 72)
    pct = (nutrition_complete / total) * 100 if total else 0
    print(
        f"  {_bar(nutrition_complete, total)}  {nutrition_complete} / {total} "
        f"({pct:.1f}%) have complete nutrition data"
    )
    print(f"    · {len(partial_missing)} rows with partial data (some fields missing)")
    print(f"    · {len(fully_missing)} rows with no nutrition data at all")
    print("\n  Missing-count per nutrition field:")
    for key in NUTRITION_KEYS:
        count = missing_by_key[key]
        pct = (count / total) * 100 if total else 0
        print(f"    {key:<22} {count:>4} rows missing  ({pct:5.1f}%)")

    # ------------------------------------------------------------------
    # 3. F2 compliance flags
    # ------------------------------------------------------------------
    compliance_complete = 0
    missing_compliance_by_key = {k: 0 for k in COMPLIANCE_KEYS}
    for item in items:
        attrs = item.attributes or {}
        missing = _missing_compliance_keys(attrs)
        for k in missing:
            missing_compliance_by_key[k] += 1
        if not missing:
            compliance_complete += 1

    print()
    print("=" * 72)
    print("F2 compliance aggregation readiness")
    print("=" * 72)
    pct = (compliance_complete / total) * 100 if total else 0
    print(
        f"  {_bar(compliance_complete, total)}  {compliance_complete} / {total} "
        f"({pct:.1f}%) have all four flags set"
    )
    print("\n  Missing-count per flag:")
    for key in COMPLIANCE_KEYS:
        count = missing_compliance_by_key[key]
        pct = (count / total) * 100 if total else 0
        print(f"    {key:<12} {count:>4} rows missing  ({pct:5.1f}%)")

    # ------------------------------------------------------------------
    # 4. Label copy
    # ------------------------------------------------------------------
    missing_list_name = 0
    missing_nutrition_name = 0
    for item in items:
        attrs = item.attributes or {}
        if not _is_present(attrs.get("ingredient_list_name")):
            missing_list_name += 1
        if not _is_present(attrs.get("nutrition_information_name")):
            missing_nutrition_name += 1

    print()
    print("=" * 72)
    print("Label copy readiness")
    print("=" * 72)
    print(f"  Missing 'Ingredient list Name':         {missing_list_name:>4} / {total}")
    print(f"  Missing 'Nutrition information Name':  {missing_nutrition_name:>4} / {total}")
    print(
        "  (Rows without these fall back to the internal raw-material name,"
    )
    print("   which is usually too technical for customer labels.)")

    # ------------------------------------------------------------------
    # 5. NRV
    # ------------------------------------------------------------------
    nrv_usable = 0
    for item in items:
        if _is_numeric((item.attributes or {}).get("nrv_mg")):
            nrv_usable += 1
    pct = (nrv_usable / total) * 100 if total else 0

    print()
    print("=" * 72)
    print("F3 %NRV readiness (spec sheet)")
    print("=" * 72)
    print(
        f"  {_bar(nrv_usable, total)}  {nrv_usable} / {total} ({pct:.1f}%) "
        f"have numeric NRV (mg)"
    )
    print("  (Remaining rows hold 'N/A' or are blank — %NRV cannot be computed.)")

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print()
    print("=" * 72)
    print("Summary")
    print("=" * 72)
    f1_pct = ((total - len(math_blocked)) / total) * 100 if total else 0
    f2_nut_pct = (nutrition_complete / total) * 100 if total else 0
    f2_comp_pct = (compliance_complete / total) * 100 if total else 0
    f3_pct = (nrv_usable / total) * 100 if total else 0
    print(f"  F1 formulation math:      {f1_pct:5.1f}% ready")
    print(f"  F2 nutrition panel:       {f2_nut_pct:5.1f}% ready")
    print(f"  F2 compliance flags:      {f2_comp_pct:5.1f}% ready")
    print(f"  F3 %NRV (spec sheet):     {f3_pct:5.1f}% ready")


run()
