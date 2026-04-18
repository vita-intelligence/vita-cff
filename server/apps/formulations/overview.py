"""Project overview aggregator — backs the new workspace dashboard.

One call returns everything the Project Overview tab shows:
identity (code / name / status), latest version summary, per-surface
counts (spec sheets by status, trial batches in flight, QC passes),
compliance + allergen snapshot from the latest saved version, and a
merged activity feed. Cheap to compute (handful of COUNTs + two
small SELECTs) and intentionally kept as a pure read so the page
stays snappy even at scale.

Lives in its own module rather than being piled into the already-
1,500-line ``services.py`` — the overview pipeline is orthogonal to
the math/versioning/CRUD concerns and will grow independently as the
Activity feed absorbs more event sources.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from django.db.models import Count

from apps.formulations.constants import (
    DosageForm,
    capsule_size_by_key,
    tablet_size_by_key,
)
from apps.formulations.models import (
    Formulation,
    FormulationVersion,
)


# ---------------------------------------------------------------------------
# DTOs
# ---------------------------------------------------------------------------


@dataclass
class SpecSheetCounts:
    total: int = 0
    draft: int = 0
    in_review: int = 0
    approved: int = 0
    sent: int = 0
    accepted: int = 0
    rejected: int = 0


@dataclass
class TrialBatchCounts:
    total: int = 0
    #: ``total`` minus every batch whose QC has settled on a terminal
    #: state (``passed`` / ``failed``) — a rough proxy for "still
    #: being validated". Batches without any validation yet count as
    #: in-flight since they haven't been cleared.
    in_flight: int = 0
    latest_label: str = ""
    latest_packs: int = 0


@dataclass
class QCCounts:
    total: int = 0
    passed: int = 0
    failed: int = 0
    in_progress: int = 0


@dataclass
class AllergenSnapshot:
    sources: list[str] = field(default_factory=list)
    count: int = 0


@dataclass
class ComplianceSnapshot:
    vegan: bool | None = None
    organic: bool | None = None
    halal: bool | None = None
    kosher: bool | None = None


@dataclass
class TotalsSnapshot:
    total_active_mg: str | None = None
    total_weight_mg: str | None = None
    filled_total_mg: str | None = None
    viability: str | None = None


@dataclass
class ActivityEntry:
    id: str
    #: ``"version_saved" | "spec_sheet_created" | "spec_sheet_status"``
    kind: str
    text: str
    actor_name: str
    created_at: str


@dataclass
class ProjectOverview:
    id: str
    code: str
    name: str
    description: str
    project_status: str
    dosage_form: str
    size_label: str
    updated_at: str
    created_at: str
    owner_name: str
    latest_version: int | None
    latest_version_label: str
    latest_version_saved_at: str | None
    spec_sheets: SpecSheetCounts
    trial_batches: TrialBatchCounts
    qc: QCCounts
    allergens: AllergenSnapshot
    compliance: ComplianceSnapshot
    totals: TotalsSnapshot
    activity: list[ActivityEntry]


# ---------------------------------------------------------------------------
# Helpers — kept private so the public surface is just compute_*
# ---------------------------------------------------------------------------


def _size_label(formulation: Formulation) -> str:
    """Produce a human-readable size descriptor for the header —
    ``"Double 00"`` for capsules, ``"13mm Round"`` for tablets, or
    the plain dosage form word for everything else."""

    if formulation.dosage_form == DosageForm.CAPSULE.value and formulation.capsule_size:
        size = capsule_size_by_key(formulation.capsule_size)
        if size is not None:
            return size.label
    if formulation.dosage_form == DosageForm.TABLET.value and formulation.tablet_size:
        size = tablet_size_by_key(formulation.tablet_size)
        if size is not None:
            return size.label
    return formulation.dosage_form.replace("_", " ").title() or ""


def _owner_name(formulation: Formulation) -> str:
    user = formulation.created_by
    if user is None:
        return ""
    full = (user.get_full_name() or "").strip()
    return full or (user.email or "").strip()


def _filled_total_mg(latest: FormulationVersion | None) -> str | None:
    """Sum of fill weight + capsule shell where applicable. Mirrors
    the spec sheet's ``totals.filled_total_mg`` so the Overview
    number matches what lands on the client-facing document."""

    if latest is None:
        return None
    totals = latest.snapshot_totals or {}
    metadata = latest.snapshot_metadata or {}
    raw = totals.get("total_weight_mg")
    if raw is None:
        return None
    try:
        fill = Decimal(str(raw))
    except (InvalidOperation, ValueError, TypeError):
        return None
    if (
        metadata.get("dosage_form") == DosageForm.CAPSULE.value
        and isinstance(totals.get("size_key"), str)
    ):
        capsule = capsule_size_by_key(totals["size_key"])
        if capsule is not None:
            fill = fill + Decimal(str(capsule.shell_weight_mg))
    return str(fill.quantize(Decimal("0.0001")))


def _latest_version(formulation: Formulation) -> FormulationVersion | None:
    return (
        FormulationVersion.objects.filter(formulation=formulation)
        .order_by("-version_number")
        .first()
    )


def _spec_sheet_counts(formulation: Formulation) -> SpecSheetCounts:
    # Scoped import so the overview module can be imported before
    # ``apps.specifications`` finishes registering its models.
    from apps.specifications.models import SpecificationSheet

    grouped = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation
        )
        .values("status")
        .annotate(n=Count("id"))
    )
    counts = SpecSheetCounts()
    counter = Counter({row["status"]: row["n"] for row in grouped})
    counts.total = sum(counter.values())
    counts.draft = counter.get("draft", 0)
    counts.in_review = counter.get("in_review", 0)
    counts.approved = counter.get("approved", 0)
    counts.sent = counter.get("sent", 0)
    counts.accepted = counter.get("accepted", 0)
    counts.rejected = counter.get("rejected", 0)
    return counts


def _qc_counts(formulation: Formulation) -> QCCounts:
    from apps.product_validation.models import ProductValidation

    grouped = (
        ProductValidation.objects.filter(
            trial_batch__formulation_version__formulation=formulation
        )
        .values("status")
        .annotate(n=Count("id"))
    )
    counts = QCCounts()
    counter = Counter({row["status"]: row["n"] for row in grouped})
    counts.total = sum(counter.values())
    counts.passed = counter.get("passed", 0)
    counts.failed = counter.get("failed", 0)
    counts.in_progress = counter.get("in_progress", 0) + counter.get("draft", 0)
    return counts


def _trial_batch_counts(formulation: Formulation) -> TrialBatchCounts:
    from apps.trial_batches.models import TrialBatch

    qs = TrialBatch.objects.filter(
        formulation_version__formulation=formulation
    ).order_by("-created_at")
    total = qs.count()
    # "In flight" = total minus those whose linked validation has
    # reached a terminal state. Subquery via .values rather than a
    # join keeps this a single roundtrip.
    settled = qs.filter(
        validation__status__in=("passed", "failed"),
    ).count()
    counts = TrialBatchCounts()
    counts.total = total
    counts.in_flight = max(total - settled, 0)
    latest = qs.first()
    if latest is not None:
        counts.latest_label = latest.label
        counts.latest_packs = latest.batch_size_units
    return counts


def _compliance_snapshot(latest: FormulationVersion | None) -> ComplianceSnapshot:
    """Re-read the aggregated compliance flags from the snapshot.
    Falls back to ``None`` triplets when the formulation has no
    saved versions yet."""

    snap = ComplianceSnapshot()
    if latest is None:
        return snap
    flags = (latest.snapshot_totals or {}).get("compliance", {}).get("flags", [])
    by_key = {row.get("key"): row for row in flags if isinstance(row, dict)}
    snap.vegan = by_key.get("vegan", {}).get("status")
    snap.organic = by_key.get("organic", {}).get("status")
    snap.halal = by_key.get("halal", {}).get("status")
    snap.kosher = by_key.get("kosher", {}).get("status")
    return snap


def _totals_snapshot(latest: FormulationVersion | None) -> TotalsSnapshot:
    snap = TotalsSnapshot()
    if latest is None:
        return snap
    totals = latest.snapshot_totals or {}
    snap.total_active_mg = totals.get("total_active_mg")
    snap.total_weight_mg = totals.get("total_weight_mg")
    snap.filled_total_mg = _filled_total_mg(latest)
    via = totals.get("viability") or {}
    codes = via.get("codes") or []
    if "can_make" in codes:
        snap.viability = "can_make"
    elif "cannot_make" in codes:
        snap.viability = "cannot_make"
    elif codes:
        snap.viability = codes[0]
    return snap


def _allergens_snapshot(latest: FormulationVersion | None) -> AllergenSnapshot:
    snap = AllergenSnapshot()
    if latest is None:
        return snap
    block = (latest.snapshot_totals or {}).get("allergens") or {}
    sources = block.get("sources")
    if isinstance(sources, list):
        snap.sources = [str(s) for s in sources if isinstance(s, str)]
    snap.count = int(block.get("allergen_count", 0) or 0)
    return snap


def _activity_feed(
    formulation: Formulation, *, limit: int = 10
) -> list[ActivityEntry]:
    """Merged event stream. Pulls the formulation version saves and
    the last handful of spec sheet transitions, interleaves by time,
    caps at ``limit``. Deliberately small — the workspace's Activity
    tab will widen the query later."""

    from apps.specifications.models import (
        SpecificationSheet,
        SpecificationTransition,
    )

    entries: list[ActivityEntry] = []

    version_qs = (
        FormulationVersion.objects.filter(formulation=formulation)
        .select_related("created_by")
        .order_by("-created_at")[:limit]
    )
    for v in version_qs:
        actor = v.created_by
        name = ""
        if actor is not None:
            name = (actor.get_full_name() or actor.email or "").strip()
        label_suffix = f" — {v.label}" if v.label else ""
        entries.append(
            ActivityEntry(
                id=f"version:{v.id}",
                kind="version_saved",
                text=f"Saved version v{v.version_number}{label_suffix}",
                actor_name=name,
                created_at=v.created_at.isoformat(),
            )
        )

    sheet_ids = SpecificationSheet.objects.filter(
        formulation_version__formulation=formulation
    ).values_list("id", flat=True)
    transition_qs = (
        SpecificationTransition.objects.filter(sheet_id__in=list(sheet_ids))
        .select_related("actor", "sheet")
        .order_by("-created_at")[:limit]
    )
    for t in transition_qs:
        code = (t.sheet.code or "").strip() or str(t.sheet_id)[:8]
        actor = t.actor
        name = ""
        if actor is not None:
            name = (actor.get_full_name() or actor.email or "").strip()
        entries.append(
            ActivityEntry(
                id=f"transition:{t.id}",
                kind="spec_sheet_status",
                text=f"Advanced spec sheet {code} — {t.from_status} → {t.to_status}",
                actor_name=name,
                created_at=t.created_at.isoformat(),
            )
        )

    entries.sort(key=lambda e: e.created_at, reverse=True)
    return entries[:limit]


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def compute_project_overview(formulation: Formulation) -> ProjectOverview:
    """Build the :class:`ProjectOverview` for one formulation.

    Pure read across the formulation + all child tables — no writes,
    no side effects. Safe to call on an empty formulation (no lines,
    no versions); the returned structure degrades to zero-counts
    and ``None`` compliance fields in that case.
    """

    latest = _latest_version(formulation)

    return ProjectOverview(
        id=str(formulation.id),
        code=formulation.code,
        name=formulation.name,
        description=formulation.description,
        project_status=formulation.project_status,
        dosage_form=formulation.dosage_form,
        size_label=_size_label(formulation),
        updated_at=formulation.updated_at.isoformat(),
        created_at=formulation.created_at.isoformat(),
        owner_name=_owner_name(formulation),
        latest_version=latest.version_number if latest else None,
        latest_version_label=latest.label if latest else "",
        latest_version_saved_at=(
            latest.created_at.isoformat() if latest else None
        ),
        spec_sheets=_spec_sheet_counts(formulation),
        trial_batches=_trial_batch_counts(formulation),
        qc=_qc_counts(formulation),
        allergens=_allergens_snapshot(latest),
        compliance=_compliance_snapshot(latest),
        totals=_totals_snapshot(latest),
        activity=_activity_feed(formulation),
    )
