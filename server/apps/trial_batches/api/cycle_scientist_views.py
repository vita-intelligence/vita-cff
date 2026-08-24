"""Scientist-facing endpoints for the trial-batch cycle.

Powers the "Trial batches in flight" module on the ``/samples``
page. Every endpoint scoped by the caller's active organization
via the standard formulations-capability gate — same auth pattern
as :module:`apps.trial_batches.api.samples_views`.

Endpoints:

* ``GET  /api/organizations/<org>/trial-batch-cycles/`` — list
  active cycles + slot summary + "action needed" flag.
* ``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
  slots/<slot_id>/create-and-link-batch/`` — one-click: creates a
  fresh :class:`TrialBatch` against the slot's snapshot version
  and links it to the slot atomically.
* ``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
  open-next-slot/`` — scientist opens the next slot after a
  ``needs_iteration`` verdict, pointing it at a freshly-saved
  ``FormulationVersion``.
* ``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
  team-override-close/`` — internal user closes the cycle when
  the customer's satisfied via out-of-band contact.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any

from django.db.models import Exists, OuterRef, Q
from django.db.models.functions import Lower
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import Formulation, FormulationVersion
from apps.organizations.modules import FormulationsCapability
from apps.trial_batches.cycle_services import (
    InvalidAdditionalSampleQuantity,
    SlotNotActive,
    SlotOutOfSequence,
    close_cycle_by_team_override,
    link_slot_to_trial_batch,
    open_next_slot_iterated,
)
from apps.trial_batches.models import (
    AdditionalSampleRequest,
    AdditionalSampleRequestStatus,
    BatchKind,
    TrialBatchCycle,
    TrialBatchCycleStatus,
    TrialBatchSlot,
    TrialBatchSlotStatus,
)
from apps.trial_batches.services import (
    FormulationVersionNotInOrg,
    InvalidBatchSize,
    create_batch,
    DepositRequired,
)


DEFAULT_SLOT_BATCH_SIZE = 20


def _serialise_slot_for_scientist(slot: TrialBatchSlot) -> dict[str, Any]:
    """Slot snapshot shape for the scientist dashboard."""

    fv = slot.formulation_version
    return {
        "id": str(slot.id),
        "sequence_no": slot.sequence_no,
        "status": slot.status,
        "verdict": slot.verdict,
        "verdict_at": (
            slot.verdict_at.isoformat() if slot.verdict_at is not None else None
        ),
        "keep_producing_remaining": slot.keep_producing_remaining,
        "feedback_summary": slot.feedback_summary,
        "trial_batch_id": (
            str(slot.trial_batch_id) if slot.trial_batch_id is not None else None
        ),
        "formulation_version_id": str(slot.formulation_version_id),
        "formulation_version_label": _version_label(fv),
        # The batch-detail route lives under the FORMULATION id
        # (/formulations/<formulation_id>/trial-batches/<batch_id>),
        # NOT under the version id. Expose it here so the scientist
        # dashboard can link out without a separate lookup.
        "formulation_id": (
            str(fv.formulation_id) if fv is not None else None
        ),
    }


def _version_label(version: FormulationVersion | None) -> str:
    """Short version tag for embedded contexts (e.g. slot rows on
    the cycle list). The full picker row uses the richer payload
    from :class:`TrialBatchCycleFormulationVersionsView` — this
    helper just returns ``v{n}`` where n is the sequence number.
    """

    if version is None:
        return ""
    number = getattr(version, "version_number", None)
    if number is None:
        # Extreme defensive fallback — every migrated row has a
        # version_number, but keep the branch so a mis-shaped
        # object can't blow up the whole cycle response.
        return f"v{str(version.id)[:8]}"
    return f"v{number}"


def _proposal_line_quantity_for_formulation(formulation) -> int | None:
    """Best-effort lookup of "how many units did the customer order?"
    from the proposal that spawned this project. Walks ProposalLine
    → newest customer-signed proposal → per-line quantity. Returns
    None when the formulation has no signed / accepted proposal.
    """

    from apps.proposals.models import ProposalLine, ProposalStatus
    from django.db.models import Q

    line = (
        ProposalLine.objects.filter(
            Q(proposal__status=ProposalStatus.ACCEPTED.value)
            | Q(
                proposal__status=ProposalStatus.SENT.value,
                proposal__customer_signed_at__isnull=False,
            ),
            formulation_version__formulation=formulation,
        )
        .order_by("-proposal__updated_at")
        .values_list("quantity", flat=True)
        .first()
    )
    return int(line) if line else None


def _serialise_cycle_for_scientist(cycle: TrialBatchCycle) -> dict[str, Any]:
    slots = list(cycle.slots.order_by("sequence_no").select_related("formulation_version"))
    active = next(
        (
            s
            for s in slots
            if s.status
            not in (
                TrialBatchSlotStatus.CLOSED_ITERATED,
                TrialBatchSlotStatus.CLOSED_SATISFIED,
                TrialBatchSlotStatus.CLOSED_CANCELLED,
            )
        ),
        None,
    )
    latest_closed_iterated = next(
        (
            s
            for s in reversed(slots)
            if s.status == TrialBatchSlotStatus.CLOSED_ITERATED
        ),
        None,
    )
    can_open_next = (
        active is None
        and latest_closed_iterated is not None
        and len(slots) < cycle.total_slots
        and cycle.status == TrialBatchCycleStatus.IN_PROGRESS
    )
    action_needed = active is not None and active.status == TrialBatchSlotStatus.AWAITING_SCIENTIST
    # "Worked" = slots that have actually been produced (or are being
    # produced) — anything past the AWAITING_SCIENTIST seed row, and
    # excluding CLOSED_CANCELLED so an auto-cancelled slot from a
    # customer-satisfied close doesn't inflate the counter. A cycle
    # with 3 planned slots that hasn't started anything reads "0/3",
    # not "1/3" (which would confuse the operator into thinking a
    # batch had already been made).
    slots_worked = sum(
        1
        for s in slots
        if s.status
        not in (
            TrialBatchSlotStatus.AWAITING_SCIENTIST,
            TrialBatchSlotStatus.CLOSED_CANCELLED,
        )
    )
    formulation = cycle.formulation
    customer = getattr(formulation, "customer", None)
    return {
        "id": str(cycle.id),
        "status": cycle.status,
        "total_slots": cycle.total_slots,
        "slots_used": slots_worked,
        "closed_at": (
            cycle.closed_at.isoformat() if cycle.closed_at is not None else None
        ),
        "updated_at": cycle.updated_at.isoformat(),
        "formulation": {
            "id": str(formulation.id),
            "code": (getattr(formulation, "code", "") or "").strip(),
            "name": (getattr(formulation, "name", "") or "").strip(),
        },
        "customer": (
            {
                "id": str(customer.id),
                "name": (getattr(customer, "name", "") or "").strip(),
            }
            if customer is not None
            else None
        ),
        "active_slot_id": str(active.id) if active is not None else None,
        "latest_iterated_slot_id": (
            str(latest_closed_iterated.id)
            if latest_closed_iterated is not None
            else None
        ),
        "can_open_next_slot": can_open_next,
        # Set when the customer clicks "No, we're done" on the portal
        # terminal-choice prompt. The spec-sheets tab uses this as the
        # signal to surface a "Final spec is ready to be created"
        # banner + trial-batch history summary.
        "customer_confirmed_done_at": (
            cycle.customer_confirmed_done_at.isoformat()
            if cycle.customer_confirmed_done_at is not None
            else None
        ),
        "terminated_reason": cycle.terminated_reason or "",
        # Proposal-line quantity for this formulation, if any. Powers
        # the "New final spec" modal on the spec-sheets tab: the
        # scientist should be able to seed the spec's ``quantity``
        # from the proposal number so the FINAL invoice math matches
        # what the customer originally quoted. Overridable in the
        # modal (this is the last chance to change the run size
        # before the customer signs and it locks).
        "proposal_line_quantity": _proposal_line_quantity_for_formulation(
            formulation
        ),
        "action_needed": action_needed,
        "slots": [_serialise_slot_for_scientist(s) for s in slots],
    }


class TrialBatchCycleListView(APIView):
    """``GET /api/organizations/<org>/trial-batch-cycles/``.

    Returns every non-terminated cycle in the org plus its slot
    summary. FE renders cycles ordered by "action needed first",
    then in-progress, then satisfied/max-reached at the bottom.

    Optional ``bucket=needs_attention`` query param filters down to
    cycles where the scientist has to click something — either the
    active slot is ``AWAITING_SCIENTIST`` or a
    ``needs_iteration`` verdict is waiting for the next slot to
    open.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str) -> Response:
        cycles = list(
            TrialBatchCycle.objects.filter(organization_id=org_id)
            .select_related("formulation", "formulation__customer")
            .prefetch_related("slots__formulation_version")
            .order_by("-updated_at")
        )
        serialised = [_serialise_cycle_for_scientist(c) for c in cycles]

        bucket = (request.query_params.get("bucket") or "").strip()
        if bucket == "needs_attention":
            serialised = [
                c
                for c in serialised
                if c["action_needed"] or c["can_open_next_slot"]
            ]

        return Response(
            {
                "items": serialised,
                "counts": {
                    "total": len(cycles),
                    "needs_attention": sum(
                        1
                        for c in [_serialise_cycle_for_scientist(c) for c in cycles]
                        if c["action_needed"] or c["can_open_next_slot"]
                    ),
                },
            },
            status=status.HTTP_200_OK,
        )


# ---------------------------------------------------------------------------
# Kanban pipeline endpoint
# ---------------------------------------------------------------------------

# Cycle statuses that count as "closed" for the kanban column.
_CLOSED_STATUSES = (
    TrialBatchCycleStatus.SATISFIED,
    TrialBatchCycleStatus.TERMINATED_BY_TEAM,
    TrialBatchCycleStatus.MAX_REACHED,
)

# Slot statuses that mean "someone is actively working on this slot" —
# used to detect whether a cycle currently has any live activity or
# is idle waiting on the scientist.
_ACTIVE_SLOT_STATUSES = (
    TrialBatchSlotStatus.AWAITING_SCIENTIST,
    TrialBatchSlotStatus.IN_PRODUCTION,
    TrialBatchSlotStatus.SHIPPED,
    TrialBatchSlotStatus.DELIVERED,
    TrialBatchSlotStatus.FEEDBACK_PENDING,
)

# Page size per column — big enough that most orgs fit in one page,
# small enough that the initial /trial-batches load stays snappy at
# millions of rows. FE Load-more fetches subsequent pages by cursor.
_PIPELINE_PAGE_SIZE = 25

_ALLOWED_STAGES = ("needs_click", "in_flight", "closed")


def _stage_predicate(qs, stage: str):
    """Filter a base cycles queryset down to one kanban column.

    "Genuinely closed" means either (a) the cycle's status is one of
    the terminal statuses AND no slot on it is still active AND no
    top-up request is still awaiting finance approval AND the
    customer has explicitly confirmed the cycle is done (or the team
    override closed it). A ``SATISFIED`` cycle where the customer
    opted into ``keep_producing_remaining`` still has
    ``AWAITING_SCIENTIST`` slots (locked to the approved version) —
    the scientist has to stay on top of them until every last one
    ships. Treating that as "closed" hides in-flight work from the
    pipeline and is the exact bug the customer bumped into.

    ``needs_click`` — NOT genuinely closed AND either (a) has an
    ``AWAITING_SCIENTIST`` slot, or (b) has no active slot at all but
    the cycle is ``IN_PROGRESS`` with capacity to open a new one
    after a ``CLOSED_ITERATED`` verdict landed. Mirrors
    ``action_needed | can_open_next_slot`` on the serialiser.

    ``in_flight`` — NOT genuinely closed AND has active work AND no
    scientist action pending. Samples are being produced / shipped /
    awaiting feedback but the scientist has nothing to click yet.
    Also catches cycles waiting on a finance decision for a top-up
    request — the scientist has nothing to click but the cycle
    hasn't landed a terminal outcome either.

    ``closed`` — genuinely closed as defined above.
    """

    has_awaiting = Exists(
        TrialBatchSlot.objects.filter(
            cycle_id=OuterRef("pk"),
            status=TrialBatchSlotStatus.AWAITING_SCIENTIST,
        )
    )
    has_any_active = Exists(
        TrialBatchSlot.objects.filter(
            cycle_id=OuterRef("pk"),
            status__in=_ACTIVE_SLOT_STATUSES,
        )
    )
    has_pending_top_up = Exists(
        AdditionalSampleRequest.objects.filter(
            cycle_id=OuterRef("pk"),
            status=AdditionalSampleRequestStatus.AWAITING_FINANCE,
        )
    )

    if stage == "closed":
        # Terminal status AND no active slot AND no pending top-up.
        # ``TERMINATED_BY_TEAM`` is the team-override path — the cycle
        # closes even without the customer's explicit confirmation.
        # For ``SATISFIED`` / ``MAX_REACHED`` the customer must have
        # answered "we're done" (or the ``keep_producing_remaining``
        # slots must have all finished, which the active-slot guard
        # already covers). Without the customer-confirmed guard a
        # cycle would fall into ``closed`` the instant the last slot
        # wrapped, hiding it from the pipeline before the customer
        # got to choose "more or done".
        annotated = qs.filter(status__in=_CLOSED_STATUSES).annotate(
            _has_active=has_any_active,
            _has_pending_top_up=has_pending_top_up,
        ).filter(_has_active=False, _has_pending_top_up=False)
        customer_confirmed = Q(customer_confirmed_done_at__isnull=False) | Q(
            status=TrialBatchCycleStatus.TERMINATED_BY_TEAM
        )
        return annotated.filter(customer_confirmed)

    if stage == "needs_click":
        # Anything with an awaiting slot gets flagged directly. The
        # ``in_progress + no active`` branch catches the "iterated
        # verdict landed, need to open next slot" case that IN_PROGRESS
        # cycles hit briefly between slots. We deliberately don't
        # surface SATISFIED cycles with no active work — those are
        # actually done, ``closed`` is the right column.
        annotated = qs.annotate(
            _has_awaiting=has_awaiting,
            _has_active=has_any_active,
        )
        awaiting_branch = Q(_has_awaiting=True)
        no_active_in_progress_branch = Q(
            _has_active=False,
            status=TrialBatchCycleStatus.IN_PROGRESS,
        )
        return annotated.filter(awaiting_branch | no_active_in_progress_branch)

    # in_flight: has active work AND no scientist action pending, OR
    # a top-up request is waiting on finance approval. Both
    # IN_PROGRESS and SATISFIED-with-remaining cycles land here — the
    # column shows every cycle that's still shipping samples OR
    # awaiting a finance decision on a customer top-up.
    annotated = qs.annotate(
        _has_awaiting=has_awaiting,
        _has_active=has_any_active,
        _has_pending_top_up=has_pending_top_up,
    )
    active_no_click = Q(_has_awaiting=False, _has_active=True)
    finance_pending = Q(_has_pending_top_up=True)
    return annotated.filter(active_no_click | finance_pending)


def _encode_cursor(row: TrialBatchCycle) -> str:
    """Opaque keyset cursor on ``(updated_at, id)`` — mirrors the
    proposals pattern. Base64 so it survives URL round-trips without
    escaping. Decoders reject malformed input by returning ``None``.
    """

    payload = {
        "updated_at": row.updated_at.isoformat(),
        "id": str(row.id),
    }
    return base64.urlsafe_b64encode(
        json.dumps(payload).encode("utf-8")
    ).decode("ascii")


def _decode_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    if not cursor:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        payload = json.loads(raw)
        return datetime.fromisoformat(payload["updated_at"]), str(payload["id"])
    except Exception:  # noqa: BLE001 — malformed cursor → treat as no cursor
        return None


class TrialBatchCyclePipelineColumnView(APIView):
    """``GET /api/organizations/<org>/trial-batch-cycles/pipeline/<stage>/``.

    Per-column feed for the trial-batches kanban board. Each column
    fires its own paginated query so a big Closed archive can't
    starve the small Needs-click list.

    Params:
      * ``stage`` in path — ``needs_click`` / ``in_flight`` / ``closed``.
      * ``cursor`` (query) — opaque, echoed back from a previous
        response's ``next_cursor``. Omit on the first call.
      * ``search`` (query) — case-insensitive substring match against
        formulation code / name and customer name.

    Response:

    .. code-block:: json

        {
          "stage": "needs_click",
          "total": 42,
          "items": [ ...serialised cycles... ],
          "next_cursor": "…opaque…" | null
        }
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str, stage: str) -> Response:
        if stage not in _ALLOWED_STAGES:
            return Response(
                {"stage": ["invalid_stage"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        base = (
            TrialBatchCycle.objects.filter(organization_id=org_id)
            .select_related("formulation", "formulation__customer")
            .prefetch_related("slots__formulation_version")
        )

        base = _stage_predicate(base, stage)

        search = (request.query_params.get("search") or "").strip().lower()
        if search:
            like = f"%{search}%"
            base = base.annotate(
                _f_code=Lower("formulation__code"),
                _f_name=Lower("formulation__name"),
                _c_name=Lower("formulation__customer__name"),
            ).filter(
                Q(_f_code__contains=search)
                | Q(_f_name__contains=search)
                | Q(_c_name__contains=search)
            )
            # ``like`` is unused — kept for readability of the intent
            # (the ORM annotate + contains handles the LIKE binding).
            del like

        # Total is best-effort — one COUNT per page is fine at this
        # scale (indexes on status + organization_id keep it cheap).
        # Callers use it for the column header pill; if it becomes
        # a hot spot we can cache per (org, stage) with short TTL.
        total = base.count()

        cursor = _decode_cursor(request.query_params.get("cursor"))
        page_qs = base.order_by("-updated_at", "-id")
        if cursor is not None:
            cur_updated_at, cur_id = cursor
            # Keyset step: strictly less than (updated_at, id) so the
            # cursor row itself is skipped without any offset scan.
            page_qs = page_qs.filter(
                Q(updated_at__lt=cur_updated_at)
                | Q(updated_at=cur_updated_at, id__lt=cur_id)
            )

        page = list(page_qs[: _PIPELINE_PAGE_SIZE + 1])
        has_next = len(page) > _PIPELINE_PAGE_SIZE
        rows = page[:_PIPELINE_PAGE_SIZE]

        serialised = [_serialise_cycle_for_scientist(c) for c in rows]

        # Post-filter refinement for the "can open next slot" branch:
        # the SQL predicate approves any in_progress cycle without an
        # active slot, but the strict definition also requires a
        # closed_iterated slot + free capacity. Drop the false
        # positives here so the column count matches what the FE
        # renders.
        if stage == "needs_click":
            serialised = [
                c
                for c in serialised
                if c["action_needed"] or c["can_open_next_slot"]
            ]

        next_cursor = _encode_cursor(rows[-1]) if has_next and rows else None

        return Response(
            {
                "stage": stage,
                "total": total,
                "items": serialised,
                "next_cursor": next_cursor,
            },
            status=status.HTTP_200_OK,
        )


def _load_cycle_slot(
    *, org_id: Any, cycle_id: Any, slot_id: Any
) -> tuple[TrialBatchCycle, TrialBatchSlot]:
    cycle = (
        TrialBatchCycle.objects.filter(
            id=cycle_id, organization_id=org_id
        )
        .select_related("formulation", "organization")
        .first()
    )
    if cycle is None:
        raise NotFound()
    slot = TrialBatchSlot.objects.filter(id=slot_id, cycle=cycle).first()
    if slot is None:
        raise NotFound()
    return cycle, slot


class TrialBatchCycleCreateAndLinkBatchView(APIView):
    """``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
    slots/<slot_id>/create-and-link-batch/``.

    One-click for the scientist. Creates a fresh :class:`TrialBatch`
    against the slot's ``formulation_version`` snapshot AND links
    it to the slot atomically. Slot flips to ``IN_PRODUCTION``; the
    scientist can then jump into the TrialBatch detail page to
    press "Create MO on PSP" the usual way.

    Body (optional):

    * ``batch_size_units`` — defaults to 20 if omitted.
    * ``label`` — defaults to ``Cycle <cycle-id-prefix> slot <n>``.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str, cycle_id: str, slot_id: str) -> Response:
        cycle, slot = _load_cycle_slot(
            org_id=org_id, cycle_id=cycle_id, slot_id=slot_id
        )
        if slot.status != TrialBatchSlotStatus.AWAITING_SCIENTIST:
            return Response(
                {
                    "code": "slot_not_awaiting_scientist",
                    "detail": f"Slot is {slot.status}, expected AWAITING_SCIENTIST",
                },
                status=status.HTTP_409_CONFLICT,
            )

        raw = request.data if isinstance(request.data, dict) else {}
        try:
            batch_size = int(raw.get("batch_size_units") or DEFAULT_SLOT_BATCH_SIZE)
        except (TypeError, ValueError):
            batch_size = DEFAULT_SLOT_BATCH_SIZE
        if batch_size <= 0:
            batch_size = DEFAULT_SLOT_BATCH_SIZE

        label = str(raw.get("label") or "").strip()
        if not label:
            label = f"Cycle {str(cycle.id)[:8]} · slot {slot.sequence_no}"

        # Auto-attach the formulation's default packaging combo (if
        # one is configured) so a cycle-slot MO run in "complete
        # packs" mode books the bottle + label + carton PSP already
        # knows about. "Individual units" mode still forces empty
        # packaging on the PSP side (see ``_build_packaging_overlay``)
        # so loose samples don't accidentally book bottles.
        default_combo_id = None
        default_combo = (
            cycle.formulation.packaging_combos.filter(is_default=True).first()
        )
        if default_combo is not None:
            default_combo_id = default_combo.id

        try:
            batch = create_batch(
                organization=cycle.organization,
                actor=request.user,
                formulation_version_id=slot.formulation_version_id,
                batch_size_units=batch_size,
                label=label,
                kind=BatchKind.SAMPLE.value,
                packaging_combo_id=default_combo_id,
            )
        except (FormulationVersionNotInOrg, InvalidBatchSize) as exc:
            return Response(
                {"code": "invalid_batch", "detail": str(exc) or type(exc).__name__},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except DepositRequired:
            return Response(
                {"code": "deposit_required"},
                status=status.HTTP_409_CONFLICT,
            )

        try:
            link_slot_to_trial_batch(slot=slot, trial_batch=batch)
        except (SlotNotActive, SlotOutOfSequence) as exc:
            return Response(
                {"code": "link_failed", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )

        slot.refresh_from_db()
        return Response(
            {
                "slot": _serialise_slot_for_scientist(slot),
                "trial_batch_id": str(batch.id),
            },
            status=status.HTTP_201_CREATED,
        )


class TrialBatchCycleOpenNextSlotView(APIView):
    """``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
    open-next-slot/``.

    Called after the previous slot's ``NEEDS_ITERATION`` verdict.
    Body: ``{ formulation_version_id }`` — the scientist's freshly-
    tweaked version.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str, cycle_id: str) -> Response:
        cycle = (
            TrialBatchCycle.objects.filter(
                id=cycle_id, organization_id=org_id
            )
            .select_related("formulation", "organization")
            .first()
        )
        if cycle is None:
            raise NotFound()

        raw = request.data if isinstance(request.data, dict) else {}
        version_id = raw.get("formulation_version_id")
        if not version_id:
            return Response(
                {"code": "formulation_version_required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        version = (
            FormulationVersion.objects.select_related("formulation")
            .filter(id=version_id)
            .first()
        )
        if (
            version is None
            or version.formulation_id != cycle.formulation_id
            or version.formulation.organization_id != cycle.organization_id
        ):
            return Response(
                {"code": "formulation_version_not_found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        try:
            slot = open_next_slot_iterated(
                cycle=cycle, formulation_version=version
            )
        except SlotOutOfSequence as exc:
            return Response(
                {"code": "slot_out_of_sequence", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )
        except SlotNotActive as exc:
            return Response(
                {"code": "cycle_not_active", "detail": str(exc)},
                status=status.HTTP_409_CONFLICT,
            )

        return Response(
            {"slot": _serialise_slot_for_scientist(slot)},
            status=status.HTTP_201_CREATED,
        )


class TrialBatchCycleTeamOverrideCloseView(APIView):
    """``POST /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
    team-override-close/``.

    Internal user closes the cycle — customer's happy via out-of-band
    contact. Body: ``{ reason }`` (optional, free-text audit trail).
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str, cycle_id: str) -> Response:
        cycle = (
            TrialBatchCycle.objects.filter(
                id=cycle_id, organization_id=org_id
            )
            .select_related("formulation", "organization")
            .first()
        )
        if cycle is None:
            raise NotFound()

        raw = request.data if isinstance(request.data, dict) else {}
        reason = str(raw.get("reason") or "").strip()

        close_cycle_by_team_override(cycle=cycle, actor=request.user, reason=reason)
        cycle.refresh_from_db()
        return Response(
            {"cycle": _serialise_cycle_for_scientist(cycle)},
            status=status.HTTP_200_OK,
        )


class TrialBatchCycleByFormulationView(APIView):
    """``GET /api/organizations/<org>/formulations/<formulation_id>/trial-batch-cycle/``.

    Returns the single cycle attached to this formulation (they're
    one-to-one) with the full scientist-shape payload. Powers the
    spec-sheets tab's "Final spec is ready to be created" banner and
    the trial-batch history summary that lists every sample +
    verdict + feedback the customer left.

    Returns 404 when no cycle exists yet (deposit hasn't been
    approved). The FE hides the banner in that case rather than
    error-toasting.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        cycle = (
            TrialBatchCycle.objects.filter(
                organization_id=org_id, formulation_id=formulation_id,
            )
            .select_related("formulation", "formulation__customer")
            .prefetch_related("slots__formulation_version")
            .first()
        )
        if cycle is None:
            raise NotFound()
        return Response(
            {"cycle": _serialise_cycle_for_scientist(cycle)},
            status=status.HTTP_200_OK,
        )


class TrialBatchCycleFormulationVersionsView(APIView):
    """``GET /api/organizations/<org>/trial-batch-cycles/<cycle_id>/
    formulation-versions/``.

    Lightweight picker feed for the "Open next slot" dropdown.
    Returns every ``FormulationVersion`` for the cycle's
    formulation, newest first.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(self, request: Request, org_id: str, cycle_id: str) -> Response:
        cycle = TrialBatchCycle.objects.filter(
            id=cycle_id, organization_id=org_id
        ).select_related("formulation").first()
        if cycle is None:
            raise NotFound()

        versions = list(
            FormulationVersion.objects.filter(formulation=cycle.formulation)
            .select_related("created_by")
            .order_by("-version_number", "-created_at")
        )
        items = [
            {
                "id": str(v.id),
                # Short tag (e.g. "v3") — same as slot rows on the
                # cycle list so the picker row's headline matches.
                "label": _version_label(v),
                # Sequential version number for sorting / rendering.
                "version_number": v.version_number,
                # Scientist-written short note (e.g. "caffeine bumped
                # to 200mg"). Empty string when the scientist saved
                # without a note — FE renders it inline when present.
                "note": (v.label or "").strip(),
                # Who saved the version — name + email (email is a
                # useful tiebreaker when two scientists share a
                # display name).
                "created_by_name": _actor_display_name(v.created_by),
                "created_at": v.created_at.isoformat(),
                # Auto-drafts are silent restore points, not
                # scientist-committed milestones. FE dims + tags
                # them so nobody accidentally launches a slot
                # against a mid-edit snapshot.
                "is_auto": bool(v.is_auto),
                # Passed the builder-readiness gate at save time.
                # FE surfaces a subtle warning when False so
                # scientists don't ship an incomplete recipe.
                "is_complete": bool(v.is_complete),
            }
            for v in versions
        ]
        return Response({"items": items}, status=status.HTTP_200_OK)


def _actor_display_name(actor) -> str:
    """Best-effort human-readable name for a Django user row.
    Falls back to email, then a placeholder — never returns None
    so the FE renders a safe string without an extra null check.
    """

    if actor is None:
        return "—"
    name = (getattr(actor, "get_full_name", None) or (lambda: ""))()
    name = (name or "").strip()
    if name:
        return name
    email = (getattr(actor, "email", "") or "").strip()
    return email or "—"
