"""Views backing the global messenger surface.

These three endpoints are the FE reconciliation path that sits next
to the per-user inbox WebSocket. The WS pushes real-time
``inbox.message`` events for new comments; the FE pings these
endpoints on bell mount, on reconnect, and on every "I just marked
this thread read" gesture so the badge stays correct even if the
socket missed an event.

Endpoint surface:

* ``GET  /api/comments/inbox/`` — list every chat the caller can see,
  newest activity first, with a single-line preview and an unread
  count per thread.
* ``GET  /api/comments/inbox/unread_count/`` — total unread across all
  threads, for the bell badge.
* ``POST /api/comments/threads/<kind>/<id>/read/`` — bump the caller's
  read pointer for one thread to ``timezone.now()`` (or to a
  caller-supplied timestamp).

Authorisation is split between the view (caller must be authenticated)
and the service (per-org membership + ``comments_view`` capability).
The mark-read view additionally validates that the caller has access
to the specific entity before upserting a read-state row — otherwise
a hostile client could seed orphan rows for arbitrary UUIDs.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound, ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.comments.models import ThreadEntityKind
from apps.comments.services import (
    InboxThread,
    compute_total_unread,
    list_inbox_threads,
    mark_thread_read,
)
from apps.formulations.models import Formulation
from apps.organizations.models import Organization
from apps.organizations.modules import (
    FORMULATIONS_MODULE,
    FormulationsCapability,
)
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)
from apps.specifications.models import SpecificationSheet


# ---------------------------------------------------------------------------
# Serialisation helpers — kept inline rather than in serializers.py so
# the inbox surface is a single grep-friendly module.
# ---------------------------------------------------------------------------


def _serialise_inbox_thread(thread: InboxThread) -> dict[str, Any]:
    return {
        "organization": {
            "id": thread.organization_id,
            "name": thread.organization_name,
        },
        "entity_kind": thread.entity_kind,
        "entity_id": thread.entity_id,
        "entity_title": thread.entity_title,
        "entity_code": thread.entity_code,
        "unread_count": thread.unread_count,
        "last_message_at": thread.last_message_at.isoformat(),
        "last_message_preview": thread.last_message_preview,
        "last_message_author": {
            "name": thread.last_message_author.name,
            "kind": thread.last_message_author.kind,
        },
    }


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class InboxListView(APIView):
    """``GET /api/comments/inbox/`` — full inbox listing.

    The response is intentionally unpaginated for v1: at Vita scale
    we expect tens of active threads per user, not thousands. The
    dropdown renders the full list and applies its own client-side
    virtualisation if the count ever grows.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        threads = list_inbox_threads(user=request.user)
        return Response(
            {
                "threads": [_serialise_inbox_thread(t) for t in threads],
                "total_unread": sum(t.unread_count for t in threads),
            },
            status=status.HTTP_200_OK,
        )


class InboxUnreadCountView(APIView):
    """``GET /api/comments/inbox/unread_count/`` — bell-badge endpoint.

    Returns a single number so the FE can issue a tiny GET on every
    mount + every WS event without paying for the preview payload.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        return Response(
            {"unread_count": compute_total_unread(user=request.user)},
            status=status.HTTP_200_OK,
        )


class ThreadMarkReadView(APIView):
    """``POST /api/comments/threads/<kind>/<id>/read/`` — bump pointer.

    Body (optional)::

        {"at": "2026-05-18T10:00:00Z"}

    Omit the body and the pointer moves to ``timezone.now()`` — the
    common "I just opened the thread" gesture. Pass ``at`` when the
    FE knows the exact timestamp of the latest message the user has
    seen (e.g. a scroll-to-bottom handler in the floating panel).

    Authorisation enforces the same rules as the WS consumer:

    1. Caller must be authenticated (handled by ``permission_classes``).
    2. Caller must be a member of the entity's organisation.
    3. The organisation must be active (or caller is a superuser).
    4. Caller must hold ``formulations.comments_view`` on the org.
    5. The entity must actually exist within that org.

    Failing any of (2)–(5) returns 404 so we never leak the existence
    of an entity to a caller who can't see it.
    """

    permission_classes = (IsAuthenticated,)

    def post(
        self,
        request: Request,
        entity_kind: str,
        entity_id: Any,
    ) -> Response:
        if entity_kind not in ThreadEntityKind.values:
            raise NotFound()

        organization = self._authorise_entity(
            user=request.user,
            entity_kind=entity_kind,
            entity_id=entity_id,
        )

        timestamp = _parse_at(request.data) if request.data else None

        state = mark_thread_read(
            user=request.user,
            entity_kind=entity_kind,
            entity_id=entity_id,
            at=timestamp,
        )
        return Response(
            {
                "entity_kind": state.entity_kind,
                "entity_id": str(state.entity_id),
                "organization_id": str(organization.id),
                "last_read_at": state.last_read_at.isoformat(),
            },
            status=status.HTTP_200_OK,
        )

    # ------------------------------------------------------------------

    @staticmethod
    def _authorise_entity(
        *,
        user,
        entity_kind: str,
        entity_id: Any,
    ) -> Organization:
        """Walk the membership → capability → entity-in-org chain.

        Raises :class:`NotFound` for every failure to avoid leaking
        which step failed — a stranger guessing at UUIDs sees the
        same response as a member with the right capability hitting
        a deleted entity.
        """

        # Look up the entity first so we know which org to check
        # membership against. Two queries (entity then membership)
        # is fine — the path fires only on user-driven gestures.
        if entity_kind == ThreadEntityKind.FORMULATION.value:
            entity = Formulation.objects.filter(id=entity_id).first()
        elif entity_kind == ThreadEntityKind.SPECIFICATION.value:
            entity = SpecificationSheet.objects.filter(id=entity_id).first()
        elif entity_kind == ThreadEntityKind.CFF_SUBMISSION.value:
            from apps.cff_submissions.models import CFFSubmission
            entity = CFFSubmission.objects.filter(id=entity_id).first()
        else:  # PROPOSAL
            from apps.proposals.models import Proposal
            entity = Proposal.objects.filter(id=entity_id).first()
        if entity is None:
            raise NotFound()

        organization = entity.organization

        if not is_organization_accessible(organization, user):
            raise NotFound()

        membership = get_membership(user, organization)
        if membership is None:
            raise NotFound()
        # CFF threads gate on the CFF module's ``view`` capability.
        # The formulations-module read-state gate (``view`` +
        # ``comments_view``) is for entity kinds that live inside the
        # projects workspace; CFFs are upstream of that and a
        # commercial role may legitimately have CFF access without
        # being on the projects module.
        if entity_kind == ThreadEntityKind.CFF_SUBMISSION.value:
            from apps.organizations.modules import (
                CFF_SUBMISSIONS_MODULE,
                CFFSubmissionsCapability,
            )
            if not has_capability(
                membership,
                CFF_SUBMISSIONS_MODULE,
                CFFSubmissionsCapability.VIEW,
            ):
                raise NotFound()
            return organization

        # Mirror the inbox listing gate: require BOTH ``view`` and
        # ``comments_view`` so a caller with only ``comments_view``
        # can't seed a read-state row for a thread they would
        # otherwise be unable to reach.
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.VIEW,
        ):
            raise NotFound()
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_VIEW,
        ):
            raise NotFound()

        return organization


def _parse_at(data: Any) -> Any:
    """Pull an optional ISO-8601 ``at`` field out of the request body.

    Returns ``None`` for missing / blank values. Surfaces a 400 with
    a structured error code for malformed input so the FE can render
    a sensible message — DRF's stock ParseError gives us this shape
    out of the box.
    """

    if not isinstance(data, dict):
        raise ParseError("invalid_body")
    raw = data.get("at")
    if raw in (None, ""):
        return None
    from django.utils.dateparse import parse_datetime

    parsed = parse_datetime(str(raw))
    if parsed is None:
        raise ParseError("invalid_at_timestamp")
    return parsed
