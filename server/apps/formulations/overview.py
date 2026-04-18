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
    formulation: Formulation, *, limit: int = 20
) -> list[ActivityEntry]:
    """Recent audit log entries scoped to this formulation's
    workspace — the formulation itself, its versions, its lines,
    every spec sheet wrapping one of its versions, every trial
    batch under those versions, and every validation under those
    batches.

    Reads directly from :class:`apps.audit.models.AuditLog`, which
    is now the canonical event stream (Phase A wired every write
    path into it). Deletions of cascaded resources don't surface
    here because the target id is gone — the org-wide audit
    viewer (Phase C) picks those up through action-prefix filters.
    """

    from apps.audit.models import AuditLog
    from apps.product_validation.models import ProductValidation
    from apps.specifications.models import SpecificationSheet
    from apps.trial_batches.models import TrialBatch

    target_ids: set[str] = {str(formulation.id)}

    version_ids = list(
        FormulationVersion.objects.filter(formulation=formulation)
        .values_list("id", flat=True)
    )
    target_ids.update(str(v) for v in version_ids)

    sheet_ids = list(
        SpecificationSheet.objects.filter(
            formulation_version_id__in=version_ids
        ).values_list("id", flat=True)
    )
    target_ids.update(str(s) for s in sheet_ids)

    batch_ids = list(
        TrialBatch.objects.filter(
            formulation_version_id__in=version_ids
        ).values_list("id", flat=True)
    )
    target_ids.update(str(b) for b in batch_ids)

    validation_ids = list(
        ProductValidation.objects.filter(
            trial_batch_id__in=batch_ids
        ).values_list("id", flat=True)
    )
    target_ids.update(str(v) for v in validation_ids)

    rows = (
        AuditLog.objects.filter(
            organization=formulation.organization,
            target_id__in=target_ids,
        )
        .select_related("actor")
        .order_by("-created_at")[:limit]
    )

    return [_render_activity_entry(row) for row in rows]


def _render_activity_entry(row: "AuditLog") -> ActivityEntry:  # type: ignore[name-defined]
    """Turn a raw :class:`AuditLog` row into the feed DTO.

    The frontend renders ``text`` verbatim, so this is the one
    place that needs to know the vocabulary. Each action slug gets
    a short English summary — keep them terse, past tense, no
    timestamps (the UI formats those separately).
    """

    actor = row.actor
    actor_name = ""
    if actor is not None:
        actor_name = (actor.get_full_name() or actor.email or "").strip()

    text = _describe_audit_row(row)

    return ActivityEntry(
        id=f"audit:{row.id}",
        kind=row.action,
        text=text,
        actor_name=actor_name,
        created_at=row.created_at.isoformat(),
    )


def _describe_audit_row(row: "AuditLog") -> str:  # type: ignore[name-defined]
    """One-line English summary for each action slug we record.

    Kept simple: pick the salient detail from ``before`` /
    ``after`` when it reads naturally (version number, status
    transition, sheet code) and fall back to a generic verb
    otherwise. No translation here — the backend only speaks
    English for now; when we internationalise this feed we'll
    return a structured ``(kind, params)`` shape and move the
    formatting client-side.
    """

    after = row.after or {}
    before = row.before or {}
    action = row.action

    if action == "formulation.create":
        return "Created the project"
    if action == "formulation.update":
        return "Updated project metadata"
    if action == "formulation.delete":
        return "Deleted the project"
    if action == "formulation_line.replace":
        count = len((after.get("lines") or [])) if isinstance(after, dict) else 0
        return f"Replaced ingredient BOM ({count} lines)"
    if action == "formulation_version.save":
        num = after.get("version_number")
        label = (after.get("label") or "").strip()
        suffix = f" — {label}" if label else ""
        return f"Saved version v{num}{suffix}" if num is not None else "Saved a new version"
    if action == "formulation_version.rollback":
        num = after.get("rolled_back_to_version_number")
        return f"Rolled back to v{num}" if num is not None else "Rolled back a version"

    if action == "spec_sheet.create":
        code = (after.get("code") or "").strip() or _short_id(row.target_id)
        return f"Created spec sheet {code}"
    if action == "spec_sheet.update":
        code = (after.get("code") or before.get("code") or "").strip() or _short_id(row.target_id)
        return f"Updated spec sheet {code}"
    if action == "spec_sheet.set_packaging":
        code = (after.get("code") or before.get("code") or "").strip() or _short_id(row.target_id)
        return f"Updated packaging on spec sheet {code}"
    if action == "spec_sheet.status_transition":
        prev = before.get("status", "?")
        nxt = after.get("status", "?")
        return f"Advanced spec sheet: {prev} → {nxt}"
    if action == "spec_sheet.rotate_public_token":
        return "Rotated spec sheet public link"
    if action == "spec_sheet.revoke_public_token":
        return "Revoked spec sheet public link"
    if action == "spec_sheet.delete":
        code = (before.get("code") or "").strip() or _short_id(row.target_id)
        return f"Deleted spec sheet {code}"

    if action == "trial_batch.create":
        label = (after.get("label") or "").strip() or _short_id(row.target_id)
        return f"Created trial batch {label}"
    if action == "trial_batch.update":
        label = (after.get("label") or before.get("label") or "").strip() or _short_id(row.target_id)
        return f"Updated trial batch {label}"
    if action == "trial_batch.delete":
        label = (before.get("label") or "").strip() or _short_id(row.target_id)
        return f"Deleted trial batch {label}"

    if action == "product_validation.create":
        return "Started a QC validation"
    if action == "product_validation.update":
        return "Updated QC validation"
    if action == "product_validation.status_transition":
        prev = before.get("status", "?")
        nxt = after.get("status", "?")
        return f"QC validation: {prev} → {nxt}"
    if action == "product_validation.delete":
        return "Deleted a QC validation"

    # Unknown slug — surface the raw verb so nothing silently
    # disappears from the feed. Future actions light up as soon as
    # this mapping catches up.
    return action


def _short_id(raw: str | None) -> str:
    """Display fallback when we have nothing but an id. Shows the
    first segment of a UUID so two deleted targets don't both
    render as ``???``."""

    if not raw:
        return "?"
    return str(raw).split("-", 1)[0]


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
