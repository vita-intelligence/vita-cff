"""Service layer for the trial-batches app.

The public surface is deliberately small: CRUD on :class:`TrialBatch`
plus the pure :func:`compute_batch_scaleup` function that turns a
batch + its locked-in formulation snapshot into the procurement BOM.

Views never touch the ORM directly — they call these functions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet

from apps.audit.services import record as record_audit, snapshot
from apps.formulations.constants import (
    CAPSULE_SHELL_LABEL,
    DosageForm,
    EXCIPIENT_LABEL_DCP,
    EXCIPIENT_LABEL_MCC,
    EXCIPIENT_LABEL_MG_STEARATE,
    EXCIPIENT_LABEL_SILICA,
    capsule_size_by_key,
)
from apps.formulations.models import FormulationVersion
from apps.organizations.models import Organization
from apps.trial_batches.models import TrialBatch


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class TrialBatchNotFound(Exception):
    code = "trial_batch_not_found"


class FormulationVersionNotInOrg(Exception):
    """The caller tried to attach a trial batch to a version that does
    not belong to their organization. We refuse loudly rather than
    silently attach someone else's snapshot to an unrelated batch."""

    code = "formulation_version_not_in_org"


class InvalidBatchSize(Exception):
    """A trial batch needs a strictly positive unit count — zero or
    negative values would produce an empty or negative BOM which is
    never what the scientist meant."""

    code = "invalid_batch_size"


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def list_batches_for_formulation(
    *, organization: Organization, formulation_id: Any
) -> QuerySet[TrialBatch]:
    return (
        TrialBatch.objects.filter(
            organization=organization,
            formulation_version__formulation_id=formulation_id,
        )
        .select_related("formulation_version__formulation", "created_by")
        .order_by("-updated_at")
    )


def get_batch(
    *, organization: Organization, batch_id: Any
) -> TrialBatch:
    batch = (
        TrialBatch.objects.select_related(
            "formulation_version__formulation",
            "created_by",
            "updated_by",
        )
        .filter(organization=organization, id=batch_id)
        .first()
    )
    if batch is None:
        raise TrialBatchNotFound()
    return batch


@transaction.atomic
def create_batch(
    *,
    organization: Organization,
    actor: Any,
    formulation_version_id: Any,
    batch_size_units: int,
    label: str = "",
    notes: str = "",
) -> TrialBatch:
    """Plan a new manufacturing run against a saved version snapshot.

    ``formulation_version_id`` must live in the caller's org —
    attaching a batch to another tenant's version is the loudest
    possible failure and we refuse rather than silently accept the
    cross-tenant attach.
    """

    if not isinstance(batch_size_units, int) or batch_size_units <= 0:
        raise InvalidBatchSize()

    version = (
        FormulationVersion.objects.select_related("formulation")
        .filter(id=formulation_version_id)
        .first()
    )
    if version is None or version.formulation.organization_id != organization.id:
        raise FormulationVersionNotInOrg()

    batch = TrialBatch.objects.create(
        organization=organization,
        formulation_version=version,
        label=label,
        batch_size_units=batch_size_units,
        notes=notes,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="trial_batch.create",
        target=batch,
        after=snapshot(batch),
    )
    return batch


@transaction.atomic
def update_batch(
    *,
    batch: TrialBatch,
    actor: Any,
    **changes: Any,
) -> TrialBatch:
    """Patch-style update. Only ``label``, ``batch_size_units`` and
    ``notes`` are mutable — the ``formulation_version`` is immutable
    by design, so a different snapshot means a different batch."""

    before = snapshot(batch)
    if "batch_size_units" in changes and changes["batch_size_units"] is not None:
        size = changes["batch_size_units"]
        if not isinstance(size, int) or size <= 0:
            raise InvalidBatchSize()
        batch.batch_size_units = size
    if changes.get("label") is not None:
        batch.label = changes["label"]
    if changes.get("notes") is not None:
        batch.notes = changes["notes"]

    batch.updated_by = actor
    batch.save()
    record_audit(
        organization=batch.organization,
        actor=actor,
        action="trial_batch.update",
        target=batch,
        before=before,
        after=snapshot(batch),
    )
    return batch


# ---------------------------------------------------------------------------
# BOM scale-up — pure function of snapshot × batch_size_units
# ---------------------------------------------------------------------------


@dataclass
class BOMEntry:
    """One line in the scaled-up bill of materials.

    Every row carries three granularities so procurement and the
    scientist see the same number at every level — per individual
    capsule/tablet, per shipped pack (bottle of 60, pouch, tub), and
    per full manufacturing run. Collapsing any of the three into a
    "most useful one" column hides the arithmetic the scientist
    needs to sanity-check the scale-up.

    The ``uom`` axis separates how the *line* is procured from how
    it's dosed. Actives and excipients are bought by **weight** (kg
    of powder) — their per-batch figure is ``kg_per_batch``. Empty
    capsule shells are bought by **count** ("10,000 Size 00 shells")
    — for those the headline figure is ``count_per_batch``, and the
    weight columns are kept only as context.
    """

    #: ``"active" | "excipient" | "shell"`` — drives UI grouping.
    category: str
    label: str
    internal_code: str
    #: ``"weight"`` for powders / oils / extracts procured in kg;
    #: ``"count"`` for discrete components like empty capsule shells
    #: that MRPeasy and similar ERPs track as ``each`` (``ea``).
    uom: str
    mg_per_unit: Decimal
    #: ``mg_per_unit × units_per_pack / 1000`` — weight per shipped
    #: pack, in grams. Useful for checking a bottle's advertised net
    #: weight against what actually ends up inside it.
    g_per_pack: Decimal
    mg_per_batch: Decimal
    g_per_batch: Decimal
    kg_per_batch: Decimal
    #: Raw count of discrete pieces needed for the whole batch.
    #: Equal to ``total_units_in_batch`` for every count-UOM line
    #: (one shell per capsule), zero for weight-UOM lines.
    count_per_batch: int = 0


@dataclass
class BOMResult:
    """Scaled-up view of one trial batch.

    ``batch_size_units`` is the number of **finished packs** (bottles,
    pouches, tubs, blisters — whatever the scientist ships) in the
    run. Each pack contains ``units_per_pack`` individual capsules /
    tablets / gummies / etc., so ``total_units_in_batch`` is the raw
    number the BOM math multiplies mg-per-unit against. Exposing all
    three in the render payload lets the UI disambiguate "500" in
    bold type without the user having to solve the arithmetic.

    Totals are reported **per UOM** so the weight-procured powder
    lines (actives + excipients) do not get summed with the
    count-procured shell lines. ``total_mg_per_unit`` is therefore
    the *fill weight* (what the machine puts inside a capsule), and
    ``total_count_per_batch`` is the count of discrete components
    (empty capsule shells) procurement orders as ``each``. A
    scientist comparing the capsule's physical weight against the
    dosage form spec adds ``total_mg_per_unit`` + the shell weight
    from the shell row themselves.
    """

    batch_id: str
    label: str
    batch_size_units: int
    units_per_pack: int
    total_units_in_batch: int
    formulation_id: str
    formulation_name: str
    version_number: int
    version_label: str
    dosage_form: str
    size_label: str | None
    entries: list[BOMEntry] = field(default_factory=list)
    #: Sum across weight-UOM lines only — the fill weight of one
    #: individual capsule / tablet / gummy (excludes shell).
    total_mg_per_unit: Decimal = Decimal("0")
    total_g_per_pack: Decimal = Decimal("0")
    total_mg_per_batch: Decimal = Decimal("0")
    total_g_per_batch: Decimal = Decimal("0")
    total_kg_per_batch: Decimal = Decimal("0")
    #: Sum across count-UOM lines — typically the number of empty
    #: shells procurement orders. Zero for non-capsule products.
    total_count_per_batch: int = 0


def _coerce_decimal(raw: Any) -> Decimal | None:
    if raw is None or raw == "":
        return None
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError):
        return None


#: Map each line category to its procurement unit of measure. Keeps
#: the weight↔count switch-over in one place — the rest of the
#: pipeline just reads ``entry.uom`` and does not branch on category.
_CATEGORY_UOM: dict[str, str] = {
    "active": "weight",
    "excipient": "weight",
    "shell": "count",
}


def _build_bom_entry(
    *,
    category: str,
    label: str,
    internal_code: str,
    mg_per_unit: Decimal,
    units_per_pack: int,
    total_units_in_batch: int,
) -> BOMEntry:
    """Scale a single line from per-unit mg out to every granularity
    the BOM table exposes: per individual unit (mg), per shipped pack
    (g), and per batch (mg / g / kg).

    The scientist uses per-unit to sanity-check the dosage form, the
    per-pack column to cross-reference a bottle's advertised net
    weight, and per-batch for the procurement purchase order. Each
    column is pre-computed at render time so the UI is dumb.
    """

    mg_per_pack = mg_per_unit * Decimal(units_per_pack)
    g_per_pack = (mg_per_pack / Decimal(1000)).quantize(Decimal("0.0001"))

    mg_per_batch = (mg_per_unit * Decimal(total_units_in_batch)).quantize(
        Decimal("0.0001")
    )
    g_per_batch = (mg_per_batch / Decimal(1000)).quantize(Decimal("0.0001"))
    kg_per_batch = (mg_per_batch / Decimal(1_000_000)).quantize(
        Decimal("0.000001")
    )
    uom = _CATEGORY_UOM.get(category, "weight")
    return BOMEntry(
        category=category,
        label=label,
        internal_code=internal_code,
        uom=uom,
        mg_per_unit=mg_per_unit.quantize(Decimal("0.0001")),
        g_per_pack=g_per_pack,
        mg_per_batch=mg_per_batch,
        g_per_batch=g_per_batch,
        kg_per_batch=kg_per_batch,
        # One discrete piece per individual capsule/tablet — the
        # shell line scales 1:1 with ``total_units_in_batch``. Zero
        # on weight-UOM lines so procurement doesn't accidentally
        # read "kg of MCC" as a piece count.
        count_per_batch=total_units_in_batch if uom == "count" else 0,
    )


def compute_batch_scaleup(batch: TrialBatch) -> BOMResult:
    """Turn a ``TrialBatch`` into the procurement-ready BOM.

    Iterates the locked-in ``FormulationVersion`` snapshot rather than
    the live formulation state — a batch planned on v2 stays planned
    on v2 even if v3 later lands with different actives.

    Excipients are reported as **separate** lines (Mg Stearate, Silica,
    MCC, DCP, Capsule Shell) rather than the label-copy grouping the
    spec sheet uses. Procurement buys stearate and silica as distinct
    SKUs; collapsing them into "Anticaking Agents" would be wrong for
    this audience.
    """

    version = batch.formulation_version
    snapshot_lines = version.snapshot_lines or []
    totals = version.snapshot_totals or {}
    metadata = version.snapshot_metadata or {}

    # Resolve how many individual capsules/tablets/etc. sit inside
    # each shipped pack. Falls back to 1 so products without a
    # meaningful pack size (e.g. powders sold as a single tub) still
    # scale 1:1 from the input count.
    raw_units_per_pack = metadata.get("servings_per_pack")
    try:
        units_per_pack = int(raw_units_per_pack or 1)
    except (TypeError, ValueError):
        units_per_pack = 1
    if units_per_pack <= 0:
        units_per_pack = 1
    total_units_in_batch = batch.batch_size_units * units_per_pack

    result = BOMResult(
        batch_id=str(batch.id),
        label=batch.label,
        batch_size_units=batch.batch_size_units,
        units_per_pack=units_per_pack,
        total_units_in_batch=total_units_in_batch,
        formulation_id=str(version.formulation_id),
        formulation_name=metadata.get("name", ""),
        version_number=version.version_number,
        version_label=version.label,
        dosage_form=totals.get("dosage_form", metadata.get("dosage_form", "")),
        size_label=totals.get("size_label"),
    )

    # Actives — iterate the snapshot_lines in the order the scientist
    # sees them on the builder, preserving display_order.
    ordered_lines = sorted(
        (line for line in snapshot_lines if isinstance(line, dict)),
        key=lambda line: line.get("display_order", 0),
    )
    for line in ordered_lines:
        mg_per_unit = _coerce_decimal(line.get("mg_per_serving"))
        if mg_per_unit is None or mg_per_unit <= 0:
            continue
        result.entries.append(
            _build_bom_entry(
                category="active",
                label=line.get("item_name", "") or "",
                internal_code=line.get("item_internal_code", "") or "",
                mg_per_unit=mg_per_unit,
                units_per_pack=units_per_pack,
                total_units_in_batch=total_units_in_batch,
            )
        )

    # Excipients — each slot as its own row when present. DCP only
    # applies on tablets; MCC / stearate / silica appear on both
    # capsules and tablets.
    excipients = totals.get("excipients") or {}
    for key, label in (
        ("mcc_mg", EXCIPIENT_LABEL_MCC),
        ("dcp_mg", EXCIPIENT_LABEL_DCP),
        ("mg_stearate_mg", EXCIPIENT_LABEL_MG_STEARATE),
        ("silica_mg", EXCIPIENT_LABEL_SILICA),
    ):
        mg_per_unit = _coerce_decimal(excipients.get(key))
        if mg_per_unit is None or mg_per_unit <= 0:
            continue
        result.entries.append(
            _build_bom_entry(
                category="excipient",
                label=label,
                internal_code="",
                mg_per_unit=mg_per_unit,
                units_per_pack=units_per_pack,
                total_units_in_batch=total_units_in_batch,
            )
        )

    # Capsule shell — one per unit, weight keyed off the selected
    # capsule size. Tablets/powders/gummies/liquids have no shell.
    dosage_form = result.dosage_form
    size_key = totals.get("size_key")
    if dosage_form == DosageForm.CAPSULE.value and isinstance(size_key, str):
        capsule = capsule_size_by_key(size_key)
        if capsule is not None and capsule.shell_weight_mg > 0:
            result.entries.append(
                _build_bom_entry(
                    category="shell",
                    label=CAPSULE_SHELL_LABEL,
                    internal_code="",
                    mg_per_unit=Decimal(str(capsule.shell_weight_mg)),
                    units_per_pack=units_per_pack,
                    total_units_in_batch=total_units_in_batch,
                )
            )

    # Totals — split by UOM so bulk-procured powder (kg) never
    # accidentally gets summed with count-procured shells (ea). Each
    # roll-up sums the already-quantised line values rather than
    # multiplying a pre-summed per-unit total out, which keeps the
    # column-totals and row-by-row math reconcilable to the penny.
    weight_entries = [e for e in result.entries if e.uom == "weight"]
    count_entries = [e for e in result.entries if e.uom == "count"]

    total_mg_per_unit = sum(
        (entry.mg_per_unit for entry in weight_entries), Decimal("0")
    )
    total_g_per_pack = sum(
        (entry.g_per_pack for entry in weight_entries), Decimal("0")
    )
    total_mg_per_batch = sum(
        (entry.mg_per_batch for entry in weight_entries), Decimal("0")
    )
    result.total_mg_per_unit = total_mg_per_unit.quantize(Decimal("0.0001"))
    result.total_g_per_pack = total_g_per_pack.quantize(Decimal("0.0001"))
    result.total_mg_per_batch = total_mg_per_batch.quantize(Decimal("0.0001"))
    result.total_g_per_batch = (total_mg_per_batch / Decimal(1000)).quantize(
        Decimal("0.0001")
    )
    result.total_kg_per_batch = (
        total_mg_per_batch / Decimal(1_000_000)
    ).quantize(Decimal("0.000001"))
    result.total_count_per_batch = sum(
        (entry.count_per_batch for entry in count_entries), 0
    )
    return result
