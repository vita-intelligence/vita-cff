"""Kanban read-model for the R&D side of the project lifecycle.

Powers the staff ``/rd-pipeline`` board: one column per derived
lifecycle stage (Builder → Spec drafting → Spec approved → Proposal
→ Closed), each capped at a small page of the most-recently-updated
projects so the first paint is cheap regardless of org size.

Mirrors :mod:`apps.proposals.pipeline` structurally — same column
shape, same keyset cursor, same scope-gating contract — but the
stage axis is *derived* from the project's child-document state
rather than read off a single ``status`` column.

Design choices:

* **Derived stages, not a `project_status` column.** Scientists
  describe a project as "in the builder", "spec drafting",
  "proposal" — phases keyed off whether the project has spec
  sheets and proposals attached, regardless of the manual
  ``project_status`` toggle. The classifier is the source of
  truth; the manual project status is shown on each card as a
  side-channel badge.

* **Mutually exclusive stages — "max reached" rule.** A project
  with one approved spec AND a draft proposal counts as one card
  in the Proposal column, not two. The column predicate for each
  stage encodes both "have I reached this stage?" AND "have I
  NOT progressed past it?".

* **Rejected proposals fall back.** A rejected proposal is dead;
  the spec is still good. The project drops back to Spec approved
  so the scientist can spawn a fresh attempt. This is consistent
  with the sales pipeline's "rejected proposals return to the
  picker" rule.

* **Discontinued projects hidden.** ``project_status =
  discontinued`` lives off the R&D funnel. Scientists can still
  find them on the Projects list; the pipeline is for live work.

* **Per-column queries.** Each column is a single SQL statement
  with EXISTS subqueries plus the scope filter. Five sequential
  small queries beat a single mega-query with a window function.

* **Keyset cursor on ``(-updated_at, id)``.** Stable across
  shifting workloads — a card moving columns doesn't drop a page.

Card shape is intentionally trim: code, name, dosage form, project
status, lead scientist, last activity. The detail page (the
Project workspace itself) handles the full read.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from django.db.models import Exists, OuterRef, Q, QuerySet

from apps.formulations.models import Formulation, ProjectStatus
from apps.organizations.models import Membership, Organization
from apps.organizations.modules import FORMULATIONS_MODULE, FormulationsCapability
from apps.organizations.services import has_capability
from apps.proposals.models import Proposal, ProposalStatus
from apps.specifications.models import SpecificationSheet, SpecificationStatus


RDPipelineScope = Literal["mine", "all"]


#: Default per-column page size. Mirrors the sales pipeline default
#: — five columns × 25 cards is at most 125 rows on first paint,
#: which is well inside the index-only-scan budget even for the
#: largest tenant.
DEFAULT_COLUMN_LIMIT = 25


# ---------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------


#: Stage identifiers, declared in funnel order so the FE renders the
#: board left-to-right without having to re-sort. Each value is an
#: opaque string the FE matches against translation keys.
STAGE_BUILDER = "builder"
STAGE_SPEC_DRAFTING = "spec_drafting"
STAGE_SPEC_APPROVED = "spec_approved"
STAGE_PROPOSAL = "proposal"
STAGE_CLOSED = "closed"

STAGE_ORDER: tuple[str, ...] = (
    STAGE_BUILDER,
    STAGE_SPEC_DRAFTING,
    STAGE_SPEC_APPROVED,
    STAGE_PROPOSAL,
    STAGE_CLOSED,
)


# Spec sheet statuses that count as "the spec is good enough that
# the team can quote against it". ``rejected`` is excluded — a
# rejected spec is dead. ``draft`` / ``in_review`` are excluded
# from "approved" but still count as "the spec exists" for the
# Spec-drafting stage.
_SPEC_APPROVED_STATUSES: tuple[str, ...] = (
    SpecificationStatus.APPROVED.value,
    SpecificationStatus.SENT.value,
    SpecificationStatus.ACCEPTED.value,
)

# Spec sheets that still count as "the project has a spec attached",
# even if not yet approved. Rejected sheets are not a stage signal.
_SPEC_LIVE_STATUSES: tuple[str, ...] = tuple(
    s for s in SpecificationStatus.values if s != SpecificationStatus.REJECTED.value
)

# Proposal statuses that say "there is a live deal attached to
# this project". ``accepted`` is split out as the terminal Closed
# signal; ``rejected`` is excluded (falls back to Spec approved).
_PROPOSAL_LIVE_STATUSES: tuple[str, ...] = (
    ProposalStatus.DRAFT.value,
    ProposalStatus.IN_REVIEW.value,
    ProposalStatus.APPROVED.value,
    ProposalStatus.SENT.value,
)

_PROPOSAL_CLOSED_STATUSES: tuple[str, ...] = (
    ProposalStatus.ACCEPTED.value,
)


class RDPipelinePermissionDenied(Exception):
    """Raised when the caller asks for ``scope="all"`` without
    holding :attr:`FormulationsCapability.VIEW_ALL_RD_PIPELINE`.
    The REST layer translates this to a 403 — the FE should not
    have shown the toggle in the first place, so this is a
    defence-in-depth check, not a routine error path."""


# ---------------------------------------------------------------------------
# Read shape (dataclasses, serialized by the REST layer)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RDPipelineCard:
    """One card on the R&D kanban board.

    All fields are read straight from the :class:`Formulation` row
    plus its ``lead_scientist`` FK — no aggregates that require
    touching the spec/proposal tables again, so the read stays
    bound by the composite index on ``(organization, lead_scientist,
    -updated_at, id)``.
    """

    id: UUID
    code: str
    name: str
    dosage_form: str
    project_status: str
    lead_scientist_id: UUID | None
    lead_scientist_name: str
    updated_at: datetime


@dataclass(frozen=True)
class RDPipelineColumn:
    """One column on the R&D kanban board — i.e. one lifecycle stage."""

    stage: str
    total: int
    cards: list[RDPipelineCard]
    next_cursor: str | None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_rd_pipeline(
    *,
    organization: Organization,
    membership: Membership | None,
    user: Any,
    scope: RDPipelineScope = "mine",
    column_limit: int = DEFAULT_COLUMN_LIMIT,
) -> list[RDPipelineColumn]:
    """Return every kanban column for the user's R&D pipeline view.

    Columns are emitted in :data:`STAGE_ORDER` so the FE renders
    them left-to-right without re-sorting.
    """

    _check_scope_allowed(membership=membership, scope=scope)

    columns: list[RDPipelineColumn] = []
    for stage in STAGE_ORDER:
        cards, next_cursor, total = _query_column(
            organization=organization,
            user=user,
            scope=scope,
            stage=stage,
            cursor=None,
            limit=column_limit,
        )
        columns.append(
            RDPipelineColumn(
                stage=stage,
                total=total,
                cards=cards,
                next_cursor=next_cursor,
            )
        )
    return columns


def list_rd_pipeline_column(
    *,
    organization: Organization,
    membership: Membership | None,
    user: Any,
    scope: RDPipelineScope,
    stage: str,
    cursor: str | None,
    limit: int = DEFAULT_COLUMN_LIMIT,
) -> tuple[list[RDPipelineCard], str | None, int]:
    """Return one column's next page — used by the "Load more"
    affordance on a column that has already been loaded.
    """

    if stage not in STAGE_ORDER:
        # Unknown stage: defensive. The FE only ever sends values
        # that the bundled endpoint already emitted.
        return ([], None, 0)
    _check_scope_allowed(membership=membership, scope=scope)
    return _query_column(
        organization=organization,
        user=user,
        scope=scope,
        stage=stage,
        cursor=cursor,
        limit=limit,
    )


def classify_stage(formulation: Formulation) -> str:
    """Pure-Python stage classifier — used by tests and by the
    serializer when a single project's stage is needed outside the
    bundled board read.

    Returns one of the ``STAGE_*`` constants. Discontinued projects
    still classify (they just don't appear in the board view).
    """

    spec_qs = SpecificationSheet.objects.filter(
        formulation_version__formulation=formulation,
    )
    proposal_qs = Proposal.objects.filter(
        formulation_version__formulation=formulation,
    )
    if proposal_qs.filter(status__in=_PROPOSAL_CLOSED_STATUSES).exists():
        return STAGE_CLOSED
    if proposal_qs.filter(status__in=_PROPOSAL_LIVE_STATUSES).exists():
        return STAGE_PROPOSAL
    if spec_qs.filter(status__in=_SPEC_APPROVED_STATUSES).exists():
        return STAGE_SPEC_APPROVED
    if spec_qs.filter(status__in=_SPEC_LIVE_STATUSES).exists():
        return STAGE_SPEC_DRAFTING
    return STAGE_BUILDER


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _check_scope_allowed(
    *,
    membership: Membership | None,
    scope: RDPipelineScope,
) -> None:
    if scope == "mine":
        return
    if membership is None:
        # No membership = no access. Anonymous users wouldn't reach
        # this code path (the permission class rejects earlier), but
        # treating it as "scope=mine" instead would silently widen
        # which is the worst outcome.
        raise RDPipelinePermissionDenied()
    if not has_capability(
        membership,
        FORMULATIONS_MODULE,
        FormulationsCapability.VIEW_ALL_RD_PIPELINE,
    ):
        raise RDPipelinePermissionDenied()


def _base_queryset(
    *, organization: Organization, user: Any, scope: RDPipelineScope
) -> QuerySet[Formulation]:
    """Apply org + scope + discontinued filters.

    Discontinued projects are excluded unconditionally — they live
    off the R&D funnel. Scientists can still reach them via the
    Projects list; pulling them onto the board would clutter every
    column with dead work.
    """

    qs = (
        Formulation.objects.filter(organization=organization)
        .exclude(project_status=ProjectStatus.DISCONTINUED.value)
        .select_related("lead_scientist")
    )
    if scope == "mine":
        qs = qs.filter(lead_scientist=user)
    return qs


def _stage_filter(stage: str) -> Q:
    """Translate a stage key into the SQL predicate that selects
    projects sitting in *exactly* that stage.

    Predicates encode both "reached this stage" AND "did not
    progress past it" so the columns are mutually exclusive — the
    "max reached" rule lives entirely in SQL, no post-filter pass.
    """

    spec_exists = lambda statuses: Exists(  # noqa: E731
        SpecificationSheet.objects.filter(
            formulation_version__formulation=OuterRef("pk"),
            status__in=statuses,
        )
    )
    proposal_exists = lambda statuses: Exists(  # noqa: E731
        Proposal.objects.filter(
            formulation_version__formulation=OuterRef("pk"),
            status__in=statuses,
        )
    )

    has_any_spec = spec_exists(_SPEC_LIVE_STATUSES)
    has_approved_spec = spec_exists(_SPEC_APPROVED_STATUSES)
    has_live_proposal = proposal_exists(_PROPOSAL_LIVE_STATUSES)
    has_closed_proposal = proposal_exists(_PROPOSAL_CLOSED_STATUSES)

    if stage == STAGE_BUILDER:
        return ~has_any_spec & ~has_live_proposal & ~has_closed_proposal
    if stage == STAGE_SPEC_DRAFTING:
        return has_any_spec & ~has_approved_spec & ~has_live_proposal & ~has_closed_proposal
    if stage == STAGE_SPEC_APPROVED:
        return has_approved_spec & ~has_live_proposal & ~has_closed_proposal
    if stage == STAGE_PROPOSAL:
        return has_live_proposal & ~has_closed_proposal
    if stage == STAGE_CLOSED:
        return has_closed_proposal
    # Defensive — STAGE_ORDER is the only legal set.
    return Q(pk__in=[])


def _query_column(
    *,
    organization: Organization,
    user: Any,
    scope: RDPipelineScope,
    stage: str,
    cursor: str | None,
    limit: int,
) -> tuple[list[RDPipelineCard], str | None, int]:
    """Run a single column read.

    Returns ``(cards, next_cursor, total)``. ``total`` is the full
    count of cards in this stage (not just the loaded page) so the
    column header can show "12 projects" without paging.
    """

    queryset = _base_queryset(
        organization=organization, user=user, scope=scope
    ).filter(_stage_filter(stage))

    total = queryset.count()

    page_qs = queryset.order_by("-updated_at", "id")
    decoded = _decode_cursor(cursor) if cursor else None
    if decoded is not None:
        cursor_updated_at, cursor_id = decoded
        # Keyset condition: strictly older OR same-timestamp-but-
        # later-id. Mirrors the sales pipeline's pagination invariant.
        page_qs = page_qs.filter(
            Q(updated_at__lt=cursor_updated_at)
            | Q(updated_at=cursor_updated_at, id__gt=cursor_id)
        )

    rows = list(page_qs[: limit + 1])
    has_more = len(rows) > limit
    rows = rows[:limit]

    cards = [_to_card(row) for row in rows]
    next_cursor = (
        _encode_cursor(rows[-1].updated_at, rows[-1].id) if has_more and rows else None
    )
    return cards, next_cursor, total


def _to_card(formulation: Formulation) -> RDPipelineCard:
    user = formulation.lead_scientist
    if user is None:
        lead_id = None
        lead_name = ""
    else:
        full = (user.get_full_name() or "").strip()
        lead_id = user.id
        lead_name = full or user.email
    return RDPipelineCard(
        id=formulation.id,
        code=formulation.code,
        name=formulation.name,
        dosage_form=formulation.dosage_form,
        project_status=formulation.project_status,
        lead_scientist_id=lead_id,
        lead_scientist_name=lead_name,
        updated_at=formulation.updated_at,
    )


def _encode_cursor(updated_at: datetime, last_id: UUID) -> str:
    payload = {"u": updated_at.isoformat(), "i": str(last_id)}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, UUID] | None:
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
        return (
            datetime.fromisoformat(payload["u"]),
            UUID(payload["i"]),
        )
    except (ValueError, KeyError, TypeError):
        return None
