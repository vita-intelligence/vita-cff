"""REST endpoints for the CRM-style proposals pipeline board.

Two endpoints power the staff ``/pipeline`` surface:

* ``GET /api/organizations/<org_id>/proposals/pipeline/`` — bundled
  board. Returns every column in funnel order, each with its first
  page of cards + total + next-cursor. One round-trip for the
  initial paint.
* ``GET /api/organizations/<org_id>/proposals/pipeline/<status>/`` —
  per-column "Load more". Accepts a ``cursor`` query param the FE
  echoes back verbatim from the bundled response (or the previous
  load-more call).

Both endpoints accept ``?scope=mine|all``:

* ``mine`` (default) — quietly filters to ``sales_person=request.user``.
* ``all`` — requires :attr:`ProposalsCapability.VIEW_ALL`. Without it
  the service raises :class:`PipelinePermissionDenied` and the
  endpoint returns 403; the FE should be hiding the "All" toggle on
  callers that lack the cap, so this is defence-in-depth.

The bundled board is intentionally read-only — there is no "drag to
advance status" affordance in v1. Status transitions carry side-
effects (audit rows, customer-facing emails, kiosk URL invalidation)
and need to remain explicit, not a drag gesture.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import status as http_status
from rest_framework.exceptions import PermissionDenied
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.modules import (
    PROPOSALS_MODULE,
    ProposalsCapability,
)
from apps.organizations.services import get_membership, has_capability
from apps.proposals.api.permissions import HasProposalsPermission
from apps.proposals.models import ProposalStatus
from apps.proposals.pipeline import (
    PipelineCard,
    PipelineColumn,
    PipelinePermissionDenied,
    PipelineScope,
    list_pipeline,
    list_pipeline_column,
)


_VALID_SCOPES: frozenset[str] = frozenset({"mine", "all"})


# ---------------------------------------------------------------------------
# Wire shape (manual dict builders, not DRF serializers)
# ---------------------------------------------------------------------------


def _decimal(value: Decimal | None) -> str | None:
    """Render decimal money as a string (JSON has no native
    decimal type — using ``float`` here would silently lose
    precision on edge cases like 0.1 + 0.2 = 0.30000000000000004).
    ``None`` stays ``None`` so the FE can distinguish "unset" from
    "zero"."""

    if value is None:
        return None
    return str(value)


def _card_payload(card: PipelineCard) -> dict[str, Any]:
    return {
        "id": str(card.id),
        "code": card.code,
        "title": card.title,
        "status": card.status,
        "customer_name": card.customer_name,
        "customer_company": card.customer_company,
        "sales_person_id": (
            str(card.sales_person_id) if card.sales_person_id else None
        ),
        "sales_person_name": card.sales_person_name,
        "valid_until": (
            card.valid_until.isoformat() if card.valid_until else None
        ),
        "updated_at": card.updated_at.isoformat(),
        "currency": card.currency,
        "quantity": card.quantity,
        "unit_price": _decimal(card.unit_price),
        "freight_amount": _decimal(card.freight_amount),
        "deal_total": _decimal(card.deal_total),
    }


def _column_payload(column: PipelineColumn) -> dict[str, Any]:
    return {
        "status": column.status,
        "label": str(column.label),
        "total": column.total,
        "total_value": _decimal(column.total_value),
        "currency": column.currency,
        "mixed_currency": column.mixed_currency,
        "cards": [_card_payload(c) for c in column.cards],
        "next_cursor": column.next_cursor,
    }


# ---------------------------------------------------------------------------
# Scope resolution
# ---------------------------------------------------------------------------


def _resolve_scope(request: Request) -> PipelineScope:
    """Validate + coerce the ``?scope=`` query param. Default
    ``"mine"`` — the safer narrow view. Unknown values get a 400
    rather than silently downgrading to ``"mine"`` so a bug in the
    FE surfaces immediately instead of hiding a broader view."""

    raw = (request.query_params.get("scope") or "mine").strip().lower()
    if raw not in _VALID_SCOPES:
        # APIView's exception handler will return a 400 JSON body.
        from rest_framework.exceptions import ValidationError
        raise ValidationError({"scope": ["invalid_scope"]})
    return raw  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class PipelineBoardView(APIView):
    """``GET /api/organizations/<org_id>/proposals/pipeline/``.

    Returns every column with its first page in one round-trip:

    .. code-block:: json

        {
          "scope": "mine",
          "scope_capabilities": {"can_view_all": true},
          "columns": [
            {"status": "draft", "label": "Draft",
             "total": 12, "cards": [...], "next_cursor": "..."},
            ...
          ]
        }

    ``scope_capabilities.can_view_all`` tells the FE whether to
    render the "All" toggle. Sending it on the same payload avoids
    a second round-trip to fetch the caller's permissions.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        scope = _resolve_scope(request)
        membership = get_membership(request.user, self.organization)
        can_view_all = has_capability(
            membership, PROPOSALS_MODULE, ProposalsCapability.VIEW_ALL,
        )
        try:
            columns = list_pipeline(
                organization=self.organization,
                membership=membership,
                user=request.user,
                scope=scope,
            )
        except PipelinePermissionDenied as exc:
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


class PipelineColumnView(APIView):
    """``GET /api/organizations/<org_id>/proposals/pipeline/<status>/``.

    Powers the per-column "Load more" affordance. Accepts:

    * ``scope=mine|all`` — same rules as the bundled board.
    * ``cursor=<opaque>`` — echoed back verbatim from the previous
      response's ``next_cursor``. Omit on the first call (the
      bundled board already returned the first page).

    Response:

    .. code-block:: json

        {
          "status": "sent",
          "total": 42,
          "cards": [...],
          "next_cursor": null
        }
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

    def get(
        self, request: Request, org_id: str, column_status: str,
    ) -> Response:
        if column_status not in ProposalStatus.values:
            return Response(
                {"status": ["invalid_status"]},
                status=http_status.HTTP_400_BAD_REQUEST,
            )
        scope = _resolve_scope(request)
        cursor = request.query_params.get("cursor") or None
        membership = get_membership(request.user, self.organization)
        try:
            (
                cards,
                next_cursor,
                total,
                total_value,
                currency,
                mixed_currency,
            ) = list_pipeline_column(
                organization=self.organization,
                membership=membership,
                user=request.user,
                scope=scope,
                status=column_status,
                cursor=cursor,
            )
        except PipelinePermissionDenied as exc:
            raise PermissionDenied(
                {"scope": ["view_all_required"]},
            ) from exc

        return Response(
            {
                "status": column_status,
                "total": total,
                "total_value": _decimal(total_value),
                "currency": currency,
                "mixed_currency": mixed_currency,
                "cards": [_card_payload(c) for c in cards],
                "next_cursor": next_cursor,
            },
        )
