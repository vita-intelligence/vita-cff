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

from typing import Any

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
    }


def _version_label(version: FormulationVersion | None) -> str:
    if version is None:
        return ""
    revision = getattr(version, "revision", None)
    if revision is None:
        # ``version`` schemas across orgs vary; fall back to a
        # short uuid for the picker.
        return f"v{str(version.id)[:8]}"
    return f"v{revision}"


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
    formulation = cycle.formulation
    return {
        "id": str(cycle.id),
        "status": cycle.status,
        "total_slots": cycle.total_slots,
        "slots_used": len(slots),
        "closed_at": (
            cycle.closed_at.isoformat() if cycle.closed_at is not None else None
        ),
        "formulation": {
            "id": str(formulation.id),
            "code": (getattr(formulation, "code", "") or "").strip(),
            "name": (getattr(formulation, "name", "") or "").strip(),
        },
        "active_slot_id": str(active.id) if active is not None else None,
        "latest_iterated_slot_id": (
            str(latest_closed_iterated.id)
            if latest_closed_iterated is not None
            else None
        ),
        "can_open_next_slot": can_open_next,
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
            .select_related("formulation")
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

        try:
            batch = create_batch(
                organization=cycle.organization,
                actor=request.user,
                formulation_version_id=slot.formulation_version_id,
                batch_size_units=batch_size,
                label=label,
                kind=BatchKind.SAMPLE.value,
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
            .order_by("-created_at")
            .only("id", "created_at")
        )
        items = [
            {
                "id": str(v.id),
                "label": _version_label(v),
                "created_at": v.created_at.isoformat(),
            }
            for v in versions
        ]
        return Response({"items": items}, status=status.HTTP_200_OK)
