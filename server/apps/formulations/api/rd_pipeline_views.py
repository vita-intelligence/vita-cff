"""REST endpoints for the R&D kanban board.

Two endpoints power the staff ``/rd-pipeline`` surface:

* ``GET /api/organizations/<org_id>/formulations/rd-pipeline/`` —
  bundled board. Returns every column in stage order, each with its
  first page of cards + total + next-cursor. One round-trip for the
  initial paint.
* ``GET /api/organizations/<org_id>/formulations/rd-pipeline/<stage>/``
  — per-column "Load more". Accepts a ``cursor`` query param the FE
  echoes back from the bundled response.

Both endpoints accept ``?scope=mine|all``:

* ``mine`` (default) — quietly filters to ``lead_scientist=request.user``.
* ``all`` — requires
  :attr:`FormulationsCapability.VIEW_ALL_RD_PIPELINE`. Without it the
  service raises :class:`RDPipelinePermissionDenied` and the endpoint
  returns 403; the FE should be hiding the toggle on callers that
  lack the cap, so this is defence-in-depth.

Mirrors :mod:`apps.proposals.api.pipeline_views`. The two boards
are read-only — there is no "drag to advance stage" affordance in
v1. Stage transitions are derived from child-document state, not a
single flippable column, so a drag gesture would need to manufacture
side-effects across multiple tables and remain explicit instead.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status as http_status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.rd_pipeline import (
    RDPipelineCard,
    RDPipelineColumn,
    RDPipelinePermissionDenied,
    RDPipelineScope,
    STAGE_ORDER,
    list_rd_pipeline,
    list_rd_pipeline_column,
)
from apps.organizations.modules import FORMULATIONS_MODULE, FormulationsCapability
from apps.organizations.services import get_membership, has_capability


_VALID_SCOPES: frozenset[str] = frozenset({"mine", "all"})


def _card_payload(card: RDPipelineCard) -> dict[str, Any]:
    return {
        "id": str(card.id),
        "code": card.code,
        "name": card.name,
        "dosage_form": card.dosage_form,
        "project_status": card.project_status,
        "lead_scientist_id": (
            str(card.lead_scientist_id) if card.lead_scientist_id else None
        ),
        "lead_scientist_name": card.lead_scientist_name,
        "updated_at": card.updated_at.isoformat(),
    }


def _column_payload(column: RDPipelineColumn) -> dict[str, Any]:
    return {
        "stage": column.stage,
        "total": column.total,
        "cards": [_card_payload(c) for c in column.cards],
        "next_cursor": column.next_cursor,
    }


def _resolve_scope(request: Request) -> RDPipelineScope:
    """Validate + coerce the ``?scope=`` query param. Default
    ``"mine"`` — the safer narrow view. Unknown values get a 400
    rather than silently downgrading so a bug in the FE surfaces
    immediately instead of hiding a broader view."""

    raw = (request.query_params.get("scope") or "mine").strip().lower()
    if raw not in _VALID_SCOPES:
        raise ValidationError({"scope": ["invalid_scope"]})
    return raw  # type: ignore[return-value]


class RDPipelineBoardView(APIView):
    """``GET /…/formulations/rd-pipeline/`` — bundled board read."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        scope = _resolve_scope(request)
        membership = get_membership(request.user, self.organization)
        can_view_all = has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.VIEW_ALL_RD_PIPELINE,
        )
        try:
            columns = list_rd_pipeline(
                organization=self.organization,
                membership=membership,
                user=request.user,
                scope=scope,
            )
        except RDPipelinePermissionDenied as exc:
            raise PermissionDenied(
                {"scope": ["view_all_required"]},
            ) from exc

        return Response(
            {
                "scope": scope,
                "scope_capabilities": {"can_view_all": can_view_all},
                "columns": [_column_payload(c) for c in columns],
            },
        )


class RDPipelineColumnView(APIView):
    """``GET /…/formulations/rd-pipeline/<stage>/`` — per-column paging."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, stage: str,
    ) -> Response:
        if stage not in STAGE_ORDER:
            return Response(
                {"stage": ["invalid_stage"]},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        scope = _resolve_scope(request)
        cursor = request.query_params.get("cursor") or None
        membership = get_membership(request.user, self.organization)
        try:
            cards, next_cursor, total = list_rd_pipeline_column(
                organization=self.organization,
                membership=membership,
                user=request.user,
                scope=scope,
                stage=stage,
                cursor=cursor,
            )
        except RDPipelinePermissionDenied as exc:
            raise PermissionDenied(
                {"scope": ["view_all_required"]},
            ) from exc

        return Response(
            {
                "stage": stage,
                "total": total,
                "cards": [_card_payload(c) for c in cards],
                "next_cursor": next_cursor,
            },
        )
