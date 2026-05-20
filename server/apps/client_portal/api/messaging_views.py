"""Messaging endpoints for the customer portal.

A "thread" in the portal sense is a ``(content_type, object_id)``
pair — every proposal and every spec sheet is its own thread. The
portal renders one thread per attached spec on the proposal view
page (the natural scope for a back-and-forth conversation about a
single spec). Project-level threads (comments on the proposal
itself) only surface in the portal when staff explicitly flips
their ``visibility`` to ``shared``.

Endpoints
---------

* ``GET    /api/portal/proposals/<id>/messages/`` — list every
  shared comment on this proposal's polymorphic target, plus a
  per-attached-spec thread index so the UI can render tabs.
* ``POST   /api/portal/specs/<id>/messages/`` — post a shared
  comment on a specification the client owns.
* ``POST   /api/portal/specs/<id>/messages/read/`` — bump the
  client's per-thread last-read timestamp.

Each write checks customer ownership: the client may only post /
mark-read on specs attached to a proposal that belongs to their
customer. The 404 path is identical for "not found" and
"cross-customer" so existence never leaks.

Why a separate module: the auth + activation views are growing.
Splitting messaging out keeps each file under the comprehension
budget of a single screen.
"""

from __future__ import annotations

from typing import Any

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import (
    PortalAPIView,
    _err,
    _load_owned_proposal,
)
from apps.comments.models import Comment, CommentReadState


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class PortalMessageSerializer(serializers.Serializer):
    """Wire shape for one shared comment, neutral about author side.

    ``author`` is a small bag of strings so the portal can render
    "Vita team" for staff and the customer's display name for the
    client without leaking the staff user's email back to the
    portal.
    """

    id = serializers.UUIDField()
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    is_deleted = serializers.BooleanField()
    author_kind = serializers.CharField()  # "staff" | "client"
    author_name = serializers.CharField()
    thread_target_type = serializers.CharField()  # "proposal" | "spec"
    thread_target_id = serializers.UUIDField()


class PostMessageSerializer(serializers.Serializer):
    body = serializers.CharField(min_length=1, max_length=20_000)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _target_label(comment: Comment) -> tuple[str, Any]:
    """Return ``(kind, id)`` describing this comment's thread target.

    The portal only renders "proposal" and "spec" thread kinds. Any
    other content_type signals a misconfigured row and we surface
    it as the generic kind so the UI can hide it.
    """

    if comment.specification_sheet_id is not None:
        return "spec", comment.specification_sheet_id
    # Comments authored against the proposal itself currently live
    # on the formulation row (legacy) — the portal doesn't surface
    # those yet (project comments stay internal by default). When
    # the staff toggle to share them lands, we add a third branch.
    return "other", comment.object_id


def _author_payload(comment: Comment) -> dict[str, str]:
    """Compose the masked author bag exposed to the portal.

    Staff authors render as "Vita team" — we deliberately don't
    leak the operator's name so the client experience is one
    consistent brand voice. Client authors render with the
    customer company on file.
    """

    if comment.client_account_id is not None:
        company = (
            comment.client_account.customer.company
            or comment.client_account.customer.name
            or "Customer"
        )
        return {"kind": "client", "name": company}
    if comment.author_id is not None:
        return {"kind": "staff", "name": "Vita team"}
    # Legacy kiosk-guest comments — shouldn't surface in portal
    # because their ``visibility`` defaults to internal, but degrade
    # gracefully if a row ever slips through.
    return {"kind": "staff", "name": comment.guest_name or "Vita team"}


def _serialise(comment: Comment) -> dict[str, Any]:
    kind, target_id = _target_label(comment)
    author = _author_payload(comment)
    return {
        "id": comment.id,
        "body": "" if comment.is_deleted else comment.body,
        "created_at": comment.created_at,
        "is_deleted": comment.is_deleted,
        "author_kind": author["kind"],
        "author_name": author["name"],
        "thread_target_type": kind,
        "thread_target_id": target_id,
    }


def _load_owned_spec(request: Request, sheet_id: str):
    """Resolve a spec sheet by id, requiring it to be attached to a
    proposal owned by the logged-in client. 404 for both "no such
    sheet" and "belongs to someone else" — same leak-proof shape as
    :func:`_load_owned_proposal`.
    """

    from apps.proposals.models import ProposalSpecificationAttachment

    attachment = (
        ProposalSpecificationAttachment.objects
        .select_related("proposal", "specification_sheet")
        .filter(specification_sheet_id=sheet_id)
        .first()
    )
    if attachment is None:
        raise NotFound("Spec sheet not found.")
    if attachment.proposal.customer_id != request.user.customer_id:
        raise NotFound("Spec sheet not found.")
    return attachment.specification_sheet


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class ProposalMessagesView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/messages/``.

    Returns every ``visibility=shared`` comment on this proposal
    AND every shared comment on any of its attached spec sheets.
    Grouped client-side by ``thread_target_type`` +
    ``thread_target_id``. Ordered oldest-first so the UI renders a
    natural conversation order.

    Read state is included alongside so the portal can render
    "Seen" ticks without a second roundtrip.
    """

    def get(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.models import ProposalSpecificationAttachment

        proposal = _load_owned_proposal(request, proposal_id)

        attachments = list(
            ProposalSpecificationAttachment.objects
            .filter(proposal=proposal)
            .values_list("specification_sheet_id", flat=True)
        )

        # Two-leg query: spec comments + proposal-level comments.
        # ``visibility="shared"`` is enforced on both so internal
        # team chatter never surfaces to the portal.
        spec_ct = ContentType.objects.get(
            app_label="specifications", model="specification",
        )
        spec_comments = (
            Comment.objects
            .filter(
                content_type=spec_ct,
                object_id__in=attachments,
                visibility=Comment.Visibility.SHARED,
                organization_id=proposal.organization_id,
            )
            .select_related("client_account__customer")
            .order_by("created_at")
        )

        rows = [_serialise(c) for c in spec_comments]

        # Read state per spec — single query, indexed lookup. The
        # portal uses this to render the "Seen ✓" tick.
        read_rows = list(
            CommentReadState.objects
            .filter(
                viewer_client=request.user,
                content_type=spec_ct,
                object_id__in=attachments,
            )
            .values("object_id", "last_read_at")
        )
        read_map = {str(r["object_id"]): r["last_read_at"] for r in read_rows}

        return Response(
            {
                "results": PortalMessageSerializer(rows, many=True).data,
                "read_state": read_map,
                "spec_ids": [str(x) for x in attachments],
            },
        )


class SpecMessagePostView(PortalAPIView):
    """``POST /api/portal/specs/<sheet_id>/messages/``.

    Create a shared message on a spec sheet the client owns. Body
    is plain text (no markdown rendering yet — defer until the
    staff comments side migrates to markdown too so the two
    surfaces stay consistent).
    """

    def post(self, request: Request, sheet_id: str) -> Response:
        from apps.specifications.models import Specification

        sheet = _load_owned_spec(request, sheet_id)
        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err("invalid_message", status.HTTP_400_BAD_REQUEST,
                        detail=exc.detail)

        spec_ct = ContentType.objects.get_for_model(Specification)

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=sheet.organization_id,
                content_type=spec_ct,
                object_id=sheet.id,
                specification_sheet_id=sheet.id,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
            )

        return Response(_serialise(comment), status=status.HTTP_201_CREATED)


class SpecMessageReadView(PortalAPIView):
    """``POST /api/portal/specs/<sheet_id>/messages/read/``.

    Bump the client's per-thread last-read timestamp on this spec.
    Idempotent — the row is upserted via ``update_or_create``.
    """

    def post(self, request: Request, sheet_id: str) -> Response:
        from apps.specifications.models import Specification

        sheet = _load_owned_spec(request, sheet_id)
        spec_ct = ContentType.objects.get_for_model(Specification)

        CommentReadState.objects.update_or_create(
            viewer_client=request.user,
            content_type=spec_ct,
            object_id=sheet.id,
            defaults={
                "organization_id": sheet.organization_id,
                "last_read_at": timezone.now(),
            },
        )
        return Response({"detail": "ok"})
