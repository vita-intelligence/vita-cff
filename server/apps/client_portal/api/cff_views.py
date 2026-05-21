"""Customer-portal endpoints for the CFF surface.

The customer-side counterpart to :mod:`apps.cff_submissions.api`.
Where the staff endpoints expose every CFF in the org for triage,
these endpoints scope to the logged-in :class:`ClientAccount` and
surface only the CFFs the customer "owns" — defined by the
ownership union in
:func:`apps.cff_submissions.services.list_customer_cffs`:

    * the CFF's denormalised ``submitter_email`` matches the
      customer's email, OR
    * the CFF is assigned to a project that has at least one
      proposal owned by the customer.

Endpoints:

    * ``GET /api/portal/cffs/`` — list the customer's CFFs,
      newest first.
    * ``GET /api/portal/cffs/<id>/`` — single CFF, 404 on any
      ownership-rule miss.
    * ``GET /api/portal/cffs/<id>/messages/`` — list the SHARED
      comments + the customer's last-read pointer.
    * ``POST /api/portal/cffs/<id>/messages/`` — post a customer
      reply. Goes through :func:`create_comment` so the WS
      broadcast + inbox fan-out fire automatically.
    * ``POST /api/portal/cffs/<id>/messages/read/`` — bump the
      customer's per-thread last-read timestamp.

The comments thread defaults to ``shared`` visibility on the
``cff_submission`` polymorphic target (see
:func:`apps.comments.services.create_comment`) so every staff
comment created on a CFF after the rule change becomes visible to
the customer automatically — no per-comment toggle required.
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

from apps.cff_submissions.services import (
    get_customer_cff,
    list_customer_cffs,
)
from apps.client_portal.api.messaging_views import (
    PostMessageSerializer,
    _author_payload,
    _parent_payload,
)
from apps.client_portal.api.views import (
    PortalAPIView,
    _err,
)
from apps.comments.models import Comment, CommentReadState


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class PortalCFFListItemSerializer(serializers.Serializer):
    """Wire shape for one CFF row in the portal list.

    Trims the staff payload heavily: the customer doesn't need
    Wix-side import metadata, the assigned-by user, or any
    sales-person hint — they need their own intake state + an
    activity summary so they can pick which thread to read.
    """

    id = serializers.UUIDField()
    submitted_at = serializers.DateTimeField(source="wix_created_date")
    status = serializers.CharField(source="wix_status")
    has_project = serializers.SerializerMethodField()
    project_code = serializers.SerializerMethodField()
    #: Short preview line so the list row reads as more than a
    #: row of identical "CFF · 2026-05-21" stamps. Pulled from the
    #: customer's own form responses (market segment, brief, etc).
    summary = serializers.SerializerMethodField()

    def get_has_project(self, obj) -> bool:
        return obj.project_id is not None

    def get_project_code(self, obj) -> str | None:
        if obj.project_id is None:
            return None
        return obj.project.code or obj.project.name or None

    def get_summary(self, obj) -> str:
        return _summary_line(obj)


class PortalCFFDetailSerializer(PortalCFFListItemSerializer):
    """Detail shape — list fields plus the full raw_payload so the
    customer can re-read everything they submitted."""

    raw_payload = serializers.JSONField()
    wix_form_id = serializers.UUIDField()


class PortalCFFMessageSerializer(serializers.Serializer):
    """One comment on a CFF thread, neutral about author side —
    mirrors :class:`PortalMessageSerializer` so the FE can render
    both proposal/spec and CFF threads with one component."""

    id = serializers.UUIDField()
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    is_deleted = serializers.BooleanField()
    author_kind = serializers.CharField()
    author_name = serializers.CharField()
    author_avatar = serializers.CharField(allow_blank=True)
    thread_target_type = serializers.CharField()
    thread_target_id = serializers.UUIDField()
    parent = serializers.DictField(allow_null=True, required=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _summary_line(submission) -> str:
    """Compose a one-line preview for the CFF list row. Walks
    common slugs (market segment, product type, brief) to find
    the first useful customer-typed answer. Falls back to the
    Wix-status pill when nothing readable is on the row."""

    submissions = (
        submission.raw_payload.get("submissions")
        if isinstance(submission.raw_payload, dict)
        else None
    )
    if not isinstance(submissions, dict):
        return ""
    preferred_prefixes = (
        "market_segment",
        "product_type",
        "product_category",
        "brief",
        "summary",
        "company",
    )
    for prefix in preferred_prefixes:
        for slug, value in submissions.items():
            if not slug.startswith(prefix):
                continue
            if isinstance(value, str) and value.strip():
                cleaned = value.strip().replace("\n", " ")
                return cleaned[:160]
    return ""


def _serialise_comment(comment: Comment) -> dict[str, Any]:
    """Reuse the proposal/spec author + parent payload composers so
    the wire shape of a CFF message matches what the FE already
    renders for proposal + spec threads."""

    author = _author_payload(comment)
    body = "" if comment.is_deleted else (comment.body or "")
    return {
        "id": comment.id,
        "body": body,
        "created_at": comment.created_at,
        "is_deleted": comment.is_deleted,
        "author_kind": author["kind"],
        "author_name": author["name"],
        "author_avatar": author["avatar"],
        "thread_target_type": "cff_submission",
        "thread_target_id": comment.cff_submission_id,
        "parent": _parent_payload(comment),
    }


def _load_owned_cff(request: Request, submission_id: str):
    """Resolve the submission by id, gated by the portal-side
    ownership union. 404 either when the row doesn't exist OR
    fails the ownership rule — same leak-proof shape the proposal
    and spec loaders use."""

    submission = get_customer_cff(
        client_account=request.user,
        submission_id=submission_id,
    )
    if submission is None:
        raise NotFound("CFF not found.")
    return submission


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class PortalCFFListView(PortalAPIView):
    """``GET /api/portal/cffs/`` — every CFF this customer owns,
    newest first."""

    def get(self, request: Request) -> Response:
        rows = list(
            list_customer_cffs(client_account=request.user)
            .select_related("project")
        )
        return Response(
            {"results": PortalCFFListItemSerializer(rows, many=True).data},
        )


class PortalCFFDetailView(PortalAPIView):
    """``GET /api/portal/cffs/<id>/`` — single CFF with the full
    raw_payload so the customer can re-read their own submission."""

    def get(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)
        return Response(PortalCFFDetailSerializer(submission).data)


class PortalCFFMessagesView(PortalAPIView):
    """``GET + POST /api/portal/cffs/<id>/messages/``.

    GET returns the shared comments thread + the read pointer.
    POST creates a customer-side comment via the comments service
    so the broadcast + inbox fan-out + read-state housekeeping all
    happen the same way they do for proposal / spec replies.
    """

    def get(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)
        cff_ct = ContentType.objects.get_for_model(submission.__class__)
        comments = (
            Comment.objects
            .filter(
                content_type=cff_ct,
                object_id=submission.id,
                visibility=Comment.Visibility.SHARED,
                organization_id=submission.organization_id,
            )
            .select_related(
                "client_account__customer",
                "author",
                "parent__client_account__customer",
                "parent__author",
            )
            .order_by("created_at")
        )
        read_row = (
            CommentReadState.objects
            .filter(
                viewer_client=request.user,
                content_type=cff_ct,
                object_id=submission.id,
            )
            .values("last_read_at")
            .first()
        )
        return Response(
            {
                "results": [_serialise_comment(c) for c in comments],
                "read_state": (
                    read_row["last_read_at"].isoformat()
                    if read_row else None
                ),
                "cff_id": str(submission.id),
            },
        )

    def post(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)

        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err(
                "invalid_message",
                status.HTTP_400_BAD_REQUEST,
                detail=exc.detail,
            )

        from apps.cff_submissions.models import CFFSubmission

        cff_ct = ContentType.objects.get_for_model(CFFSubmission)
        parent_id = data.validated_data.get("parent_id")
        parent: Comment | None = None
        if parent_id:
            parent = (
                Comment.objects
                .filter(
                    pk=parent_id,
                    content_type=cff_ct,
                    object_id=submission.id,
                    visibility=Comment.Visibility.SHARED,
                    organization_id=submission.organization_id,
                )
                .first()
            )
            if parent is None:
                return _err(
                    "invalid_reply_target",
                    status.HTTP_400_BAD_REQUEST,
                )
            # Two-level reply cap, same as the proposal + spec
            # messaging paths.
            if parent.parent_id is not None:
                parent = parent.parent

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=submission.organization_id,
                content_type=cff_ct,
                object_id=submission.id,
                cff_submission=submission,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
                parent=parent,
            )
            # Same broadcast hop the proposal-chat post path takes
            # — lands on ``comments.cff_submission.<id>`` so any
            # staff / customer WS attached to this CFF sees the
            # message instantly instead of waiting for the next
            # poll cycle.
            from apps.comments.broadcast import schedule_comment_broadcast

            schedule_comment_broadcast(comment, "created")

        return Response(
            _serialise_comment(comment),
            status=status.HTTP_201_CREATED,
        )


class PortalCFFMessagesReadView(PortalAPIView):
    """``POST /api/portal/cffs/<id>/messages/read/`` — bump the
    customer's last-read pointer for this thread."""

    def post(self, request: Request, submission_id: str) -> Response:
        from apps.cff_submissions.models import CFFSubmission

        submission = _load_owned_cff(request, submission_id)
        cff_ct = ContentType.objects.get_for_model(CFFSubmission)
        CommentReadState.objects.update_or_create(
            viewer_client=request.user,
            content_type=cff_ct,
            object_id=submission.id,
            defaults={
                "organization_id": submission.organization_id,
                "last_read_at": timezone.now(),
            },
        )
        return Response({"detail": "ok"})
