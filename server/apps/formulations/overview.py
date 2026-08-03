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

from django.db.models import Count, Q

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
class RiskLineEntry:
    #: Item UUID — lets the FE deep-link into the item detail page.
    item_id: str
    #: Human-readable name for the row list.
    name: str
    #: ``low`` / ``medium`` / ``high``.
    tier: str


@dataclass
class RiskSnapshot:
    """Project-level regulatory-risk rollup.

    ``worst_tier`` is the ceiling across all bundled ingredients — a
    single ``high`` line pins the whole product to ``high``. ``counts``
    is a per-tier line count so the card can render "1 high · 3
    medium · 12 low" without a second round-trip. ``high_lines`` and
    ``medium_lines`` surface the offending items so scientists can
    click straight through.
    """

    #: ``low`` / ``medium`` / ``high``. Defaults to ``low`` when the
    #: formulation has no lines yet.
    worst_tier: str = "low"
    counts: dict = field(default_factory=lambda: {"low": 0, "medium": 0, "high": 0})
    high_lines: list[RiskLineEntry] = field(default_factory=list)
    medium_lines: list[RiskLineEntry] = field(default_factory=list)


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
class SalesPersonSnapshot:
    """Flat projection of the formulation's commercial owner.

    Mirrors ``FormulationReadSerializer.get_sales_person`` so the
    project shell can render the assigned user from the overview
    payload alone — no extra round-trip to the detail endpoint.
    """

    id: str
    name: str
    email: str


@dataclass
class LeadScientistSnapshot:
    """Flat projection of the formulation's R&D lead.

    Mirror of :class:`SalesPersonSnapshot` — same shape so the
    project shell can render either chip identically.
    """

    id: str
    name: str
    email: str


@dataclass
class StageGates:
    """Which project workspace tabs are unlocked.

    The workspace behaves like a wizard — later tabs stay disabled
    until earlier gates pass. Computed server-side so the FE doesn't
    have to re-derive the flow from raw counts. Values are pure
    booleans; a locked tab still renders in the strip (per the
    "grayed out + tooltip" spec) but its button is disabled.

    * ``builder_complete`` — every stage has at least one ingredient
      line assigned AND every ingredient line is assigned to a stage.
      Reported separately so the FE can compose a "which specific
      thing is missing" tooltip on the Spec-sheets tab, and light up
      a checklist inside Builder itself.
    * ``spec_sheets`` — Builder must be complete AND at least one
      explicit ``FormulationVersion`` must exist (``is_auto=False``).
      Save-draft auto-snapshots don't count so scientists have to
      intentionally cut a version before drafting a spec.
    * ``proposals`` — Custom projects need a spec sheet stamped
      ``approved`` (scientist + director sign-off both done);
      RTG projects skip the approval step and unlock as soon as
      Builder has a version.
    * ``trial_batches`` — Custom projects need a customer-signed
      proposal (``customer_signed_at IS NOT NULL``). RTG projects
      need an approved spec sheet — the intended workflow is
      build → draft spec → spec approved → trial batches → final
      spec → final approved, so trials can't jump ahead of spec
      approval on either track.
    * ``qc`` — unlocked once at least one trial batch exists.
    """

    builder_complete: bool = False
    spec_sheets: bool = False
    proposals: bool = False
    trial_batches: bool = False
    qc: bool = False


@dataclass
class LinkedCFFSnapshot:
    """Slim projection of a linked CFF for the workspace warnings +
    reminder card.

    Wide enough to render "CFF from Jane Doe (jane@acme.com)" in a
    chip; narrow enough that the overview payload doesn't ship a
    50-KB ``raw_payload`` per link. The picker fetch uses a wider
    endpoint when the user opens the link modal.
    """

    id: str
    submitter_name: str
    submitter_email: str
    submission_kind: str
    provenance: str


@dataclass(frozen=True)
class LinkedCustomerSnapshot:
    """Slim projection of the linked customer for the workspace card.

    Wide enough to render a "James Brown @ Acme Ltd" chip; narrow
    enough that we're not shipping every phone / address every
    render. The picker fetch has its own list endpoint for search.
    """

    id: str
    name: str
    company: str
    email: str


@dataclass
class ProjectOverview:
    id: str
    code: str
    name: str
    description: str
    project_status: str
    #: ``custom`` vs ``ready_to_go``. Drives per-type UI decisions on
    #: the project overview page (e.g. RTG suppresses customer / sales /
    #: CFF warning rows because catalog SKUs don't have owning
    #: customers, commercial owners, or origin CFF submissions).
    project_type: str
    dosage_form: str
    size_label: str
    updated_at: str
    created_at: str
    owner_name: str
    sales_person: SalesPersonSnapshot | None
    lead_scientist: LeadScientistSnapshot | None
    latest_version: int | None
    latest_version_label: str
    latest_version_saved_at: str | None
    spec_sheets: SpecSheetCounts
    trial_batches: TrialBatchCounts
    qc: QCCounts
    allergens: AllergenSnapshot
    compliance: ComplianceSnapshot
    #: Regulatory-risk rollup across the formulation's live lines.
    #: Product-level worst tier drives the risk chip on the overview
    #: card; the offending-item lists power the drill-down.
    risk: RiskSnapshot
    totals: TotalsSnapshot
    activity: list[ActivityEntry]
    #: Wizard-style gating map for the project workspace tabs.
    stage_gates: StageGates = field(default_factory=StageGates)
    #: PSP finished-product UUID this project is linked to. Powers
    #: the "Open on PSP" chip in the workspace header + the shortcut
    #: to the item's BOM page on PSP. ``None`` for custom-only
    #: formulations or orgs without PSP live.
    psp_finished_product_uuid: str | None = None
    #: CFF submissions currently attached to this project. Empty
    #: list is a legitimate state (project was created directly
    #: without a CFF origin) — the workspace surfaces it as a soft
    #: reminder, not a blocking warning. Ordered by attach date
    #: descending so the most recent link renders first.
    linked_cffs: list[LinkedCFFSnapshot] = field(default_factory=list)
    #: Linked customer. One-per-project (like the CFF link) — Sales
    #: sets it via ``POST /formulations/<id>/link-customer/`` from
    #: the project page. ``None`` until a client is attached. Mirrored
    #: to PSP so the kanban swaps the placeholder for the real name.
    linked_customer: "LinkedCustomerSnapshot | None" = None
    #: Trial-batch gate status — deposit paid / pending / not
    #: required. Powers the yellow banner shown across every tab of
    #: the project workspace when the customer owes a deposit before
    #: scientists can schedule a run. Shape mirrors
    #: :func:`apps.payments.services.trial_batch_gate_status`.
    deposit_gate: dict = field(default_factory=dict)
    #: Current RTG catalog visibility. Meaningful only when
    #: ``project_type == 'ready_to_go'``; ``False`` otherwise. Powers
    #: the header's Live-in-catalog pill so the workspace flags a
    #: published SKU at-a-glance.
    is_rtg_published: bool = False
    #: Gate that unlocks the header's Publish action — mirrors
    #: :meth:`FormulationReadSerializer.get_has_approved_final_spec`.
    has_approved_final_spec: bool = False
    #: Customer-facing display name on the RTG catalog. Empty string
    #: on Custom projects and on RTG projects that haven't been named
    #: for the catalog yet. Header prefers this over the internal
    #: ``name`` when non-empty so the workspace matches what customers
    #: see on ``/portal/cffs/new/rtg``.
    rtg_display_name: str = ""


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


def _sales_person_snapshot(
    formulation: Formulation,
) -> SalesPersonSnapshot | None:
    user = formulation.sales_person
    if user is None:
        return None
    full = (user.get_full_name() or "").strip()
    return SalesPersonSnapshot(
        id=str(user.id),
        name=full or user.email,
        email=user.email,
    )


def _lead_scientist_snapshot(
    formulation: Formulation,
) -> LeadScientistSnapshot | None:
    user = formulation.lead_scientist
    if user is None:
        return None
    full = (user.get_full_name() or "").strip()
    return LeadScientistSnapshot(
        id=str(user.id),
        name=full or user.email,
        email=user.email,
    )


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
    # One aggregation query gives us both totals — the previous
    # shape fired ``qs.count()`` and ``qs.filter(...).count()`` as
    # two separate round-trips. Under the overview burst on prod
    # those round-trips stack up across every helper and starve
    # the pool; collapsing here saves one trip per overview call.
    agg = qs.aggregate(
        total=Count("id"),
        settled=Count(
            "id", filter=Q(validation__status__in=("passed", "failed"))
        ),
    )
    counts = TrialBatchCounts()
    counts.total = agg["total"] or 0
    counts.in_flight = max(counts.total - (agg["settled"] or 0), 0)
    # ``latest`` still needs its own SELECT because aggregations
    # can't return row columns alongside their counts. ``.only()``
    # keeps the payload to the two fields we actually read.
    latest = qs.only("label", "batch_size_units").first()
    if latest is not None:
        counts.latest_label = latest.label
        counts.latest_packs = latest.batch_size_units
    return counts


#: Priority ordering used to compute the "worst tier" ceiling on the
#: project rollup. Higher index = worse. Lets ``max(tiers, key=...)``
#: pick the highest tier present across the bundled lines.
_RISK_TIER_ORDER = {"low": 0, "medium": 1, "high": 2}
#: Cap on how many item names we surface per tier — a bloated recipe
#: could otherwise ship a 40-row payload. Ten is enough to jog memory
#: without turning the card into a wall of text.
_RISK_LINES_LIMIT = 10


def _risk_snapshot(formulation: Formulation) -> RiskSnapshot:
    """Roll up ``Item.regulatory_risk`` across the formulation's live
    lines. Reads through the FK; the caller has already prefetched
    ``select_related('item')`` on the lines relation via the standard
    Formulation queryset used by ``compute_project_overview``.

    Reads live lines (not the version snapshot) so a scientist adding
    a high-risk ingredient sees the card flip red immediately —
    same-tick feedback matches the compliance card's semantics.
    """

    snap = RiskSnapshot()
    for line in formulation.lines.select_related("item"):
        if not line.item_id or line.item is None:
            continue
        tier = (line.item.regulatory_risk or "low").strip().lower()
        if tier not in _RISK_TIER_ORDER:
            tier = "low"
        snap.counts[tier] = snap.counts.get(tier, 0) + 1
        if tier == "high" and len(snap.high_lines) < _RISK_LINES_LIMIT:
            snap.high_lines.append(
                RiskLineEntry(
                    item_id=str(line.item_id),
                    name=line.item.name or "",
                    tier=tier,
                )
            )
        elif tier == "medium" and len(snap.medium_lines) < _RISK_LINES_LIMIT:
            snap.medium_lines.append(
                RiskLineEntry(
                    item_id=str(line.item_id),
                    name=line.item.name or "",
                    tier=tier,
                )
            )
    if snap.counts.get("high", 0):
        snap.worst_tier = "high"
    elif snap.counts.get("medium", 0):
        snap.worst_tier = "medium"
    else:
        snap.worst_tier = "low"
    return snap


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

    # Collapse the four "find the resource ids that hang off this
    # formulation" queries into a single ``UNION ALL`` so we make one
    # DB round-trip instead of four. The previous shape ran a chain of
    # ``values_list -> list -> filter(id__in=...)`` to materialise each
    # set in Python before the next; the union version pushes the
    # whole tree into one statement and lets Postgres plan it.
    #
    # ``.order_by()`` is applied (with no args) to every branch because
    # Postgres rejects ORDER BY inside the operands of a compound
    # statement and the source models all carry a default ordering.
    version_qs = (
        FormulationVersion.objects.filter(formulation=formulation)
        .order_by()
        .values_list("id", flat=True)
    )
    sheet_qs = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation
        )
        .order_by()
        .values_list("id", flat=True)
    )
    batch_qs = (
        TrialBatch.objects.filter(
            formulation_version__formulation=formulation
        )
        .order_by()
        .values_list("id", flat=True)
    )
    validation_qs = (
        ProductValidation.objects.filter(
            trial_batch__formulation_version__formulation=formulation
        )
        .order_by()
        .values_list("id", flat=True)
    )
    related_ids = version_qs.union(sheet_qs, batch_qs, validation_qs, all=True)

    target_ids: set[str] = {str(formulation.id)}
    target_ids.update(str(row) for row in related_ids)

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


def _refresh_incomplete_batch_chain_status(formulation: Formulation) -> None:
    """Best-effort refresh of ``TrialBatch.psp_all_stages_completed``
    for every batch on this formulation that:

    * has a linked PSP MO (``psp_manufacturing_order_uuid`` set), and
    * is still cached as ``False`` (i.e. the last known chain state
      had at least one non-completed stage).

    Called before the QC-tab gate is computed so the gate lifts on
    the very first overview render after the shop floor closes out
    the trial run — even if the user never opens the trial-batch
    detail page (which is the other place the flag gets refreshed).

    Silent-degrade posture:

    * If PSP isn't configured / is unreachable / returns an error →
      we leave the flag alone. The overview endpoint absolutely
      cannot 500 because PSP is having a bad afternoon.
    * If the chain is empty or malformed → we leave the flag alone.
    * Once a batch's flag flips to ``True`` we stop touching it —
      MOs don't un-complete themselves.
    """

    from apps.trial_batches.models import TrialBatch

    incomplete = list(
        TrialBatch.objects.filter(
            formulation_version__formulation=formulation,
            psp_all_stages_completed=False,
            psp_manufacturing_order_uuid__isnull=False,
        ).only("id", "organization_id", "psp_manufacturing_order_uuid")
    )
    if not incomplete:
        return

    from apps.psp.services import get_psp_manufacturing_order_chain

    for batch in incomplete:
        try:
            payload = get_psp_manufacturing_order_chain(
                organization=batch.organization,
                mo_uuid=batch.psp_manufacturing_order_uuid,
            )
        except Exception:
            # Any PSP failure — network, auth, decrypt, server —
            # keeps the flag stale rather than blowing up the
            # overview render. The panel-side poll will retry later.
            continue
        if not payload:
            continue
        chain = payload.get("chain") or []
        all_completed = bool(chain) and all(
            (node.get("status") or "") == "completed" for node in chain
        )
        if all_completed:
            batch.psp_all_stages_completed = True
            batch.save(update_fields=["psp_all_stages_completed"])


def _compute_stage_gates(formulation: Formulation) -> StageGates:
    """Wizard-style gate map for the project workspace tabs.

    See :class:`StageGates` docstring for the per-tab rule.
    """

    # Scoped imports so the overview module can be imported before
    # the specifications / proposals / trial_batches apps register
    # their models.
    from apps.formulations.models import FormulationVersion
    from apps.proposals.models import Proposal
    from apps.specifications.models import SpecificationSheet
    from apps.trial_batches.models import TrialBatch

    has_explicit_version = FormulationVersion.objects.filter(
        formulation=formulation, is_auto=False
    ).exists()

    has_approved_spec = SpecificationSheet.objects.filter(
        formulation_version__formulation=formulation,
        status__in=("approved", "sent", "accepted"),
    ).exists()

    has_customer_signed_proposal = Proposal.objects.filter(
        formulation_version__formulation=formulation,
        customer_signed_at__isnull=False,
    ).exists()

    # QC unlocks only when at least one trial batch has actually
    # been produced end-to-end — i.e. its PSP MO chain (finished-
    # product parent + every semi-finished child) is all
    # ``status = completed``. The flag is cached locally on the
    # trial batch and refreshed by the trial-batch panel poll
    # (20s cadence) plus the inline refresh below on overview
    # renders. Existing behaviour ("any trial batch") isn't good
    # enough — validating a formulation before the trial run is
    # done gives a QC certificate for a product that doesn't
    # physically exist yet.
    _refresh_incomplete_batch_chain_status(formulation)
    has_completed_trial_batch = TrialBatch.objects.filter(
        formulation_version__formulation=formulation,
        psp_all_stages_completed=True,
    ).exists()

    # Builder-complete: at least one stage exists, at least one line
    # exists, every line is assigned to a stage, and every stage has
    # at least one line assigned. Enforced here so a scientist can't
    # jump to Spec sheets while the recipe is still half-scaffolded
    # (which happened on MA01421 — one stage was empty and Spec
    # sheets was reachable because an explicit version existed from
    # an earlier iteration).
    stage_ids = list(
        formulation.stages.values_list("id", flat=True),
    )
    line_stage_ids = list(
        formulation.lines.values_list("stage_id", flat=True),
    )
    has_stages = bool(stage_ids)
    has_lines = bool(line_stage_ids)
    all_lines_assigned = has_lines and all(
        stage_id is not None for stage_id in line_stage_ids
    )
    stage_ids_with_lines = {
        stage_id for stage_id in line_stage_ids if stage_id is not None
    }
    all_stages_have_lines = has_stages and all(
        stage_id in stage_ids_with_lines for stage_id in stage_ids
    )
    # Packaging check — different for RTG vs Custom projects.
    #
    # * Custom projects declare packaging as an ingredient line typed
    #   ``psp_item_type = packaging``. The gate passes when at least one
    #   such line exists (any bottle / jar / sachet / pouch / carton).
    #
    # * RTG projects offer customers a picker of ``PackagingCombo``
    #   bundles (bottle + label + lid, or pouch + sticker). The gate
    #   passes when the SKU has at least one combo defined AND every
    #   combo has a ``stage_id`` — the Routing tab decision that says
    #   which stage assembles the packaging on the customer's PO. Any
    #   still-unassigned combo blocks the gate because at order time
    #   the packaging cascade would have nowhere to land.
    if formulation.project_type == "ready_to_go":
        combos = list(formulation.packaging_combos.all())
        has_packaging = bool(combos) and all(
            c.stage_id is not None for c in combos
        )
    else:
        has_packaging = False
        for line in formulation.lines.select_related("item"):
            attrs = line.effective_item_attributes or {}
            psp_type = str(attrs.get("psp_item_type") or "").strip().lower()
            if psp_type == "packaging":
                has_packaging = True
                break

    # Stage-type flow check — sequential stages auto-consume the prior
    # stage's semi output, so every non-last stage MUST be
    # ``semi_finished`` and the last stage MUST be ``finished_product``.
    # Any other combination leaves a stage's output stranded (blended
    # powder no downstream consumer, or a finished-product stage in
    # the middle with orphan stages after it).
    ordered_stages = list(formulation.stages.order_by("sort_order"))
    stage_types_ok = True
    for idx, stage in enumerate(ordered_stages):
        is_last = idx == len(ordered_stages) - 1
        expected = "finished_product" if is_last else "semi_finished"
        if stage.psp_item_type != expected:
            stage_types_ok = False
            break

    # Semi-consumption check — for every non-terminal stage that has
    # a mirrored PSP semi item, verify some line on a downstream
    # stage points at that PSP uuid. Otherwise the stage produces a
    # semi (Alex Gummies Liquid Mix, etc.) that nothing downstream
    # uses — cooking output has to be routed into pouch filling or
    # it's stranded. Skip stages with ``psp_semi_finished_uuid`` NULL
    # (never pushed) — check refires after the first save version.
    stage_by_id: dict[str, Any] = {str(s.id): s for s in ordered_stages}
    stage_semis_ok = True
    if len(ordered_stages) > 1:
        # Preload each line's item.psp_source_uuid + stage_id so we
        # only make one round-trip. select_related covers the FK.
        lines_by_stage: dict[str, list[str]] = {}
        for line in formulation.lines.select_related("item"):
            stage_id = str(line.stage_id) if line.stage_id else ""
            if not stage_id:
                continue
            psp_uuid = str(
                getattr(line.item, "psp_source_uuid", None) or ""
            )
            if not psp_uuid:
                continue
            lines_by_stage.setdefault(stage_id, []).append(psp_uuid)
        for idx, stage in enumerate(ordered_stages):
            is_last = idx == len(ordered_stages) - 1
            if is_last:
                continue
            semi_uuid = str(stage.psp_semi_finished_uuid or "")
            if not semi_uuid:
                continue
            consumed = False
            for downstream in ordered_stages[idx + 1 :]:
                if semi_uuid in lines_by_stage.get(str(downstream.id), []):
                    consumed = True
                    break
            if not consumed:
                stage_semis_ok = False
                break

    # Setup spec-sheet minimums — human-answer fields that PSP treats
    # as optional but that a real spec sheet legally / procedurally
    # can't ship without. Force them here so Spec sheets stays locked
    # until the scientist has actually filled them.
    def _has_str(name: str) -> bool:
        raw = getattr(formulation, name, None)
        return bool(raw and str(raw).strip())

    def _has_num(name: str) -> bool:
        raw = getattr(formulation, name, None)
        return raw is not None and str(raw).strip() != ""

    def _has_list(name: str) -> bool:
        raw = getattr(formulation, name, None)
        return bool(raw)

    has_regulatory = _has_str("regulatory_category")
    has_serving = _has_num("serving_size") and _has_num(
        "serving_size_uom_uuid"
    )
    has_servings_per_pack = _has_num("servings_per_pack")
    has_net_qty = _has_num("net_quantity") and _has_num(
        "net_quantity_uom_uuid"
    )
    # Either directions or suggested dosage is enough — many products
    # only carry one of the two on the label.
    has_directions = _has_str("directions_of_use") or _has_str(
        "suggested_dosage"
    )
    has_warnings = _has_str("warnings_text")
    has_shelf_life = _has_num("shelf_life_months")
    has_storage = _has_str("storage_conditions")
    has_markets = _has_list("target_markets")
    setup_spec_ok = (
        has_regulatory
        and has_serving
        and has_servings_per_pack
        and has_net_qty
        and has_directions
        and has_warnings
        and has_shelf_life
        and has_storage
        and has_markets
    )

    builder_complete = (
        has_stages
        and has_lines
        and all_lines_assigned
        and all_stages_have_lines
        and has_packaging
        and stage_types_ok
        and stage_semis_ok
        and setup_spec_ok
    )

    # RTG projects skip the customer-signature gates — they can move
    # into proposals + trial batches as soon as Builder has an
    # explicit version. Custom projects follow the full approval
    # + customer-sign chain.
    is_rtg = formulation.project_type == "ready_to_go"

    # Spec sheets require BOTH: builder must be complete AND an
    # explicit version must exist. The version rule is a scientist's
    # intent signal ("I'm ready"); builder-complete is the structural
    # check that the intent is actually meaningful.
    spec_sheets_unlocked = builder_complete and has_explicit_version

    return StageGates(
        builder_complete=builder_complete,
        spec_sheets=spec_sheets_unlocked,
        proposals=spec_sheets_unlocked
        if is_rtg
        else has_approved_spec,
        # RTG trial batches don't require a customer signature (there
        # isn't one — customers order later through the portal), but
        # they DO require the spec sheet to be approved so the trial
        # runs against a signed-off recipe. Matches the intended flow
        # build → draft spec → spec approved → trial batches.
        trial_batches=has_approved_spec
        if is_rtg
        else has_customer_signed_proposal,
        qc=has_completed_trial_batch,
    )


def _linked_cffs_snapshot(
    formulation: Formulation,
) -> list[LinkedCFFSnapshot]:
    """Materialise every CFF submission attached to this project.

    Reads the payload's ``submissions`` map for the customer's
    display name (Wix hides it behind opaque slugs like
    ``first_name_a1b2`` / ``last_name_c3d4``); falls back to the
    ``submitter_email`` column when the payload lookup misses so
    portal rows that skip the Wix slug scheme still render a
    usable chip.
    """

    # Walk the through model so we can order by ``assigned_at`` (the
    # timestamp is on the join row, not on either side). Prefetch
    # into the assignment's submission FK so the loop is O(1) reads
    # even on projects with a stack of CFFs attached.
    assignments = (
        formulation.cff_assignments.select_related("submission")
        .order_by("-assigned_at")
    )
    out: list[LinkedCFFSnapshot] = []
    seen: set[str] = set()
    for assignment in assignments:
        cff = assignment.submission
        cff_id = str(cff.id)
        if cff_id in seen:
            continue
        seen.add(cff_id)
        payload_submissions = (cff.raw_payload or {}).get("submissions") or {}
        first_name = ""
        last_name = ""
        for key, value in payload_submissions.items():
            if not isinstance(value, str) or not value.strip():
                continue
            slug = key.lower()
            if slug.startswith("first_name") and not first_name:
                first_name = value.strip()
            elif slug.startswith("last_name") and not last_name:
                last_name = value.strip()
        submitter_name = " ".join(part for part in (first_name, last_name) if part)
        if not submitter_name:
            submitter_name = cff.submitter_email or ""
        out.append(
            LinkedCFFSnapshot(
                id=cff_id,
                submitter_name=submitter_name,
                submitter_email=cff.submitter_email or "",
                submission_kind=cff.submission_kind,
                provenance=cff.provenance,
            )
        )
    return out


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
        project_type=formulation.project_type,
        dosage_form=formulation.dosage_form,
        size_label=_size_label(formulation),
        updated_at=formulation.updated_at.isoformat(),
        created_at=formulation.created_at.isoformat(),
        owner_name=_owner_name(formulation),
        sales_person=_sales_person_snapshot(formulation),
        lead_scientist=_lead_scientist_snapshot(formulation),
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
        risk=_risk_snapshot(formulation),
        totals=_totals_snapshot(latest),
        activity=_activity_feed(formulation),
        stage_gates=_compute_stage_gates(formulation),
        psp_finished_product_uuid=(
            str(formulation.psp_finished_product_uuid)
            if formulation.psp_finished_product_uuid
            else None
        ),
        linked_cffs=_linked_cffs_snapshot(formulation),
        linked_customer=_linked_customer_snapshot(formulation),
        deposit_gate=_deposit_gate_snapshot(formulation),
        is_rtg_published=bool(formulation.is_rtg_published),
        has_approved_final_spec=_has_approved_final_spec(formulation),
        rtg_display_name=(formulation.rtg_display_name or "").strip(),
    )


def _has_approved_final_spec(formulation: Formulation) -> bool:
    """True when this project has a FINAL spec sheet in
    approved / sent / accepted status. Drives the RTG publish gate
    surfaced on the project header — same rule the serializer applies,
    kept in one place so a future change lands consistently."""

    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )

    return (
        SpecificationSheet.objects
        .filter(
            formulation_version__formulation=formulation,
            document_kind=SpecificationDocumentKind.FINAL,
            status__in=(
                SpecificationStatus.APPROVED,
                SpecificationStatus.SENT,
                SpecificationStatus.ACCEPTED,
            ),
        )
        .exists()
    )


def _deposit_gate_snapshot(formulation: Formulation) -> dict:
    """Lazy-imported wrapper around the payments-side helper. Keeps
    the payments ↔ formulations ↔ proposals import graph clean at
    module boot."""

    from apps.payments.services import trial_batch_gate_status

    return trial_batch_gate_status(formulation)


def _linked_customer_snapshot(
    formulation: Formulation,
) -> LinkedCustomerSnapshot | None:
    """Slim customer projection for the workspace card. Returns
    ``None`` when the project has no linked customer."""

    c = getattr(formulation, "customer", None)
    if c is None:
        return None
    return LinkedCustomerSnapshot(
        id=str(c.id),
        name=(c.name or "").strip(),
        company=(c.company or "").strip(),
        email=(c.email or "").strip(),
    )
