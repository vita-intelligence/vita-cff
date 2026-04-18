"""API views for the audit log.

One endpoint today: ``GET /api/organizations/<org>/audit-log/``
returns a paginated list of audit rows for the caller's
organisation. Filters (``action``, ``action_prefix``,
``target_type``, ``actor``, ``since``, ``until``) compose via
query string.

No write endpoints — audit rows are produced only by the service
layer recorders in :mod:`apps.audit.services`. Never expose a
``POST`` / ``PATCH`` / ``DELETE`` on this table.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from django.db.models import QuerySet
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.api.pagination import AuditLogCursorPagination
from apps.audit.api.permissions import HasAuditPermission
from apps.audit.api.serializers import AuditLogReadSerializer
from apps.audit.models import AuditLog
from apps.organizations.modules import AuditCapability


class AuditLogListView(APIView):
    """``GET`` ``/api/organizations/<org_id>/audit-log/``."""

    permission_classes = (HasAuditPermission,)
    required_capability = AuditCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        queryset = _apply_filters(
            AuditLog.objects.filter(organization=self.organization)
            .select_related("actor")
            .order_by("-created_at"),
            request,
        )
        paginator = AuditLogCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serialized = AuditLogReadSerializer(page, many=True).data
        return paginator.get_paginated_response(serialized)


def _apply_filters(
    queryset: QuerySet[AuditLog], request: Request
) -> QuerySet[AuditLog]:
    """Apply query-string filters to the audit list.

    Ignored when absent or blank. Unknown values fall through
    (``action=fake``) to a legitimately empty result set rather
    than a 400 — searching the audit trail shouldn't feel like
    solving a typing puzzle.
    """

    action = (request.query_params.get("action") or "").strip()
    if action:
        queryset = queryset.filter(action=action)

    action_prefix = (request.query_params.get("action_prefix") or "").strip()
    if action_prefix:
        queryset = queryset.filter(action__startswith=action_prefix)

    target_type = (request.query_params.get("target_type") or "").strip()
    if target_type:
        queryset = queryset.filter(target_type=target_type)

    actor = (request.query_params.get("actor") or "").strip()
    if actor:
        queryset = queryset.filter(actor_id=actor)

    since_raw = (request.query_params.get("since") or "").strip()
    since_dt = _parse_iso(since_raw)
    if since_dt is not None:
        queryset = queryset.filter(created_at__gte=since_dt)

    until_raw = (request.query_params.get("until") or "").strip()
    until_dt = _parse_iso(until_raw)
    if until_dt is not None:
        queryset = queryset.filter(created_at__lte=until_dt)

    return queryset


def _parse_iso(raw: str) -> datetime | None:
    """Parse an ISO-8601 date or datetime; swallow parse errors
    to keep the filter lenient."""

    if not raw:
        return None
    try:
        # ``fromisoformat`` accepts both "2026-04-18" and
        # "2026-04-18T12:00:00+00:00".
        return datetime.fromisoformat(raw)
    except ValueError:
        return None
