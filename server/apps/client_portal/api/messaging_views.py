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
from apps.comments.broadcast import schedule_comment_broadcast
from apps.comments.notifications import enqueue_notifications_for_comment
from django.db import transaction as _db_tx
from apps.comments.models import Comment, CommentReadState


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class PortalMessageSerializer(serializers.Serializer):
    """Wire shape for one shared comment, neutral about author side.

    ``author`` is a small bag of strings so the portal can render
    "Vita team" for staff and the customer's display name for the
    client without leaking the staff user's email back to the
    portal. ``author_avatar`` is the same opaque base64 data URL
    both sides of the chat use to render the bubble's profile
    picture; empty string means "render initials".

    ``parent`` carries the minimal preview the portal needs to
    render a quoted-reply block — the parent's id (for the "click
    to scroll" jump), a short body preview, and the author label.
    ``null`` when the message is a root, not a reply.
    """

    id = serializers.UUIDField()
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    is_deleted = serializers.BooleanField()
    author_kind = serializers.CharField()  # "staff" | "client"
    author_name = serializers.CharField()
    author_avatar = serializers.CharField(allow_blank=True)
    thread_target_type = serializers.CharField()  # "proposal" | "spec"
    thread_target_id = serializers.UUIDField()
    parent = serializers.DictField(allow_null=True, required=False)


class PostMessageSerializer(serializers.Serializer):
    body = serializers.CharField(min_length=1, max_length=20_000)
    # Reply target. Optional — root messages omit it. The view
    # validates the parent belongs to the same spec thread so a
    # crafted ``parent_id`` cannot reply onto a different
    # customer's conversation.
    parent_id = serializers.UUIDField(required=False, allow_null=True)


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
    customer company on file. Both sides may carry an
    ``avatar_image`` (base64 data URL); empty string means the
    UI falls back to initials.
    """

    if comment.client_account_id is not None:
        company = (
            comment.client_account.customer.company
            or comment.client_account.customer.name
            or "Customer"
        )
        return {
            "kind": "client",
            "name": company,
            "avatar": comment.client_account.avatar_image or "",
        }
    if comment.author_id is not None:
        return {
            "kind": "staff",
            "name": "Vita team",
            "avatar": comment.author.avatar_image or "",
        }
    # Legacy kiosk-guest comments — shouldn't surface in portal
    # because their ``visibility`` defaults to internal, but degrade
    # gracefully if a row ever slips through.
    return {
        "kind": "staff",
        "name": comment.guest_name or "Vita team",
        "avatar": "",
    }


def _parent_payload(comment: Comment) -> dict[str, Any] | None:
    """Compose the short preview block surfaced above a quoted-reply
    bubble. Returns ``None`` for root messages so the wire shape
    stays compact.

    Body preview is truncated to ~120 chars — enough to recognise
    the quoted message, short enough not to balloon the payload
    when 50 messages all reply to one long thread root.
    """

    parent = comment.parent
    if parent is None:
        return None
    author = _author_payload(parent)
    body = "" if parent.is_deleted else (parent.body or "")
    return {
        "id": str(parent.id),
        "body_preview": (body[:117] + "…") if len(body) > 120 else body,
        "author_name": author["name"],
        "author_kind": author["kind"],
        "is_deleted": parent.is_deleted,
    }


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
        "author_avatar": author["avatar"],
        "thread_target_type": kind,
        "thread_target_id": target_id,
        "parent": _parent_payload(comment),
    }


def _load_owned_spec(request: Request, sheet_id: str):
    """Resolve a spec sheet by id, requiring it to be attached to a
    proposal owned by the logged-in client. 404 for both "no such
    sheet" and "belongs to someone else" — same leak-proof shape as
    :func:`_load_owned_proposal`.

    Specs attach to proposals through ``ProposalLine.specification_sheet``
    (the canonical path) or the legacy ``Proposal.specification_sheet``
    OneToOne. We look up the line first because the per-line attachment
    is the modern shape — virtually every active proposal uses it.
    """

    from apps.proposals.models import Proposal, ProposalLine

    # Per-line attachment: spec belongs to a proposal whose customer
    # is the logged-in client's.
    line = (
        ProposalLine.objects
        .select_related("proposal", "specification_sheet")
        .filter(
            specification_sheet_id=sheet_id,
            proposal__customer_id=request.user.customer_id,
        )
        .first()
    )
    if line is not None:
        return line.specification_sheet

    # Legacy OneToOne — keep working until those proposals migrate.
    legacy = (
        Proposal.objects
        .select_related("specification_sheet")
        .filter(
            specification_sheet_id=sheet_id,
            customer_id=request.user.customer_id,
        )
        .first()
    )
    if legacy is not None and legacy.specification_sheet is not None:
        return legacy.specification_sheet

    raise NotFound("Spec sheet not found.")


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
        from apps.proposals.services import _attached_spec_sheets

        proposal = _load_owned_proposal(request, proposal_id)
        attachments = [
            sheet.id for sheet in _attached_spec_sheets(proposal)
        ]

        # Two-leg query: spec comments + proposal-level comments.
        # ``visibility="shared"`` is enforced on both so internal
        # team chatter never surfaces to the portal.
        spec_ct = ContentType.objects.get(
            app_label="specifications", model="specificationsheet",
        )
        spec_comments = (
            Comment.objects
            .filter(
                content_type=spec_ct,
                object_id__in=attachments,
                visibility=Comment.Visibility.SHARED,
                organization_id=proposal.organization_id,
            )
            .select_related(
                "client_account__customer",
                "author",
                "parent__client_account__customer",
                "parent__author",
            )
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
        from apps.specifications.models import SpecificationSheet

        sheet = _load_owned_spec(request, sheet_id)
        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err("invalid_message", status.HTTP_400_BAD_REQUEST,
                        detail=exc.detail)

        spec_ct = ContentType.objects.get_for_model(SpecificationSheet)

        # Resolve the reply target if one was supplied. Validate it
        # lives on the SAME spec thread — a crafted ``parent_id``
        # pointing at another customer's comment must not link
        # across threads.
        parent_id = data.validated_data.get("parent_id")
        parent: Comment | None = None
        if parent_id:
            parent = (
                Comment.objects
                .filter(
                    pk=parent_id,
                    content_type=spec_ct,
                    object_id=sheet.id,
                    visibility=Comment.Visibility.SHARED,
                    organization_id=sheet.organization_id,
                )
                .first()
            )
            if parent is None:
                return _err(
                    "invalid_reply_target",
                    status.HTTP_400_BAD_REQUEST,
                )
            # Two-level nesting cap (matches staff side rule). A
            # reply on a reply collapses to a reply on the root so
            # the UI never needs to render a deeper tree.
            if parent.parent_id is not None:
                parent = parent.parent

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=sheet.organization_id,
                content_type=spec_ct,
                object_id=sheet.id,
                specification_sheet_id=sheet.id,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
                parent=parent,
            )
            # Real-time fan-out to every open watcher of this spec —
            # staff inline comments panel, customer's other tabs,
            # kiosk session. The helper registers its own
            # ``on_commit`` hook so a rollback suppresses the
            # broadcast. Without this, customer-posted messages
            # would never push live; the staff side would only catch
            # them on the next 30s poll.
            schedule_comment_broadcast(comment, "created")
            # Fire the comment-notification pipeline so staff
            # @-mentions land in their inbox and a "customer
            # posted" email goes to staff watching the thread.
            # ``on_commit`` so a rollback suppresses both.
            _db_tx.on_commit(
                lambda c=comment: enqueue_notifications_for_comment(c.id)
            )

        return Response(_serialise(comment), status=status.HTTP_201_CREATED)


class ProposalChatListView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/proposal-messages/``.

    Returns the shared comments that target the proposal itself —
    distinct from the per-spec chat surfaces. The portal page
    splits these so a busy proposal with N specs doesn't pile a
    thousand messages into one thread.
    """

    def get(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.models import Proposal

        proposal = _load_owned_proposal(request, proposal_id)
        proposal_ct = ContentType.objects.get_for_model(Proposal)

        comments = (
            Comment.objects
            .filter(
                content_type=proposal_ct,
                object_id=proposal.id,
                visibility=Comment.Visibility.SHARED,
                organization_id=proposal.organization_id,
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
                content_type=proposal_ct,
                object_id=proposal.id,
            )
            .values("last_read_at")
            .first()
        )
        return Response(
            {
                "results": [_serialise(c) for c in comments],
                "read_state": (
                    read_row["last_read_at"].isoformat()
                    if read_row else None
                ),
                "proposal_id": str(proposal.id),
            },
        )


class ProposalChatPostView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/proposal-messages/``."""

    def post(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.models import Proposal

        proposal = _load_owned_proposal(request, proposal_id)
        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err(
                "invalid_message",
                status.HTTP_400_BAD_REQUEST,
                detail=exc.detail,
            )

        proposal_ct = ContentType.objects.get_for_model(Proposal)
        parent_id = data.validated_data.get("parent_id")
        parent: Comment | None = None
        if parent_id:
            parent = (
                Comment.objects
                .filter(
                    pk=parent_id,
                    content_type=proposal_ct,
                    object_id=proposal.id,
                    visibility=Comment.Visibility.SHARED,
                    organization_id=proposal.organization_id,
                )
                .first()
            )
            if parent is None:
                return _err(
                    "invalid_reply_target",
                    status.HTTP_400_BAD_REQUEST,
                )
            # Two-level cap, same as the spec messaging path.
            if parent.parent_id is not None:
                parent = parent.parent

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=proposal.organization_id,
                content_type=proposal_ct,
                object_id=proposal.id,
                proposal=proposal,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
                parent=parent,
            )
            # Same broadcast hop the staff comment write path takes
            # via :func:`apps.comments.services.create_comment`. Lands
            # on ``comments.proposal.<id>`` so any open staff /
            # customer WS attached to this proposal sees the message
            # instantly instead of waiting for the next 30s poll.
            schedule_comment_broadcast(comment, "created")
            # Fire the comment-notification pipeline so staff
            # @-mentions land in their inbox and a "customer
            # posted" email goes to staff watching the thread.
            # ``on_commit`` so a rollback suppresses both.
            _db_tx.on_commit(
                lambda c=comment: enqueue_notifications_for_comment(c.id)
            )

        return Response(_serialise(comment), status=status.HTTP_201_CREATED)


class ProposalChatReadView(PortalAPIView):
    """``POST /api/portal/proposals/<id>/proposal-messages/read/``."""

    def post(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.models import Proposal

        proposal = _load_owned_proposal(request, proposal_id)
        proposal_ct = ContentType.objects.get_for_model(Proposal)
        CommentReadState.objects.update_or_create(
            viewer_client=request.user,
            content_type=proposal_ct,
            object_id=proposal.id,
            defaults={
                "organization_id": proposal.organization_id,
                "last_read_at": timezone.now(),
            },
        )
        return Response({"detail": "ok"})


def _load_owned_label_design(request: Request, label_design_id: str):
    """Resolve a LabelDesign that belongs to the logged-in client.

    Same leak-proof contract as the proposal / spec loaders. Walks
    ``LabelDesign → Formulation → Proposal → customer`` (the modern
    per-line link OR the legacy 1:1) and matches against the
    caller's ``customer_id``.
    """

    from apps.label_design.models import LabelDesign
    from apps.proposals.models import Proposal

    label_design = (
        LabelDesign.objects.select_related("formulation", "organization")
        .filter(id=label_design_id)
        .first()
    )
    if label_design is None:
        raise NotFound("Label design not found.")

    customer_id = request.user.customer_id
    formulation_id = label_design.formulation_id
    owns = (
        Proposal.objects.filter(
            customer_id=customer_id,
            formulation_version__formulation_id=formulation_id,
        ).exists()
    )
    if not owns:
        raise NotFound("Label design not found.")
    return label_design


class LabelDesignChatListView(PortalAPIView):
    """``GET /api/portal/label-designs/<id>/messages/`` — list shared
    comments the customer can see on their label-design thread.
    """

    def get(self, request: Request, label_design_id: str) -> Response:
        from apps.label_design.models import LabelDesign

        ld = _load_owned_label_design(request, label_design_id)
        ld_ct = ContentType.objects.get_for_model(LabelDesign)

        comments = (
            Comment.objects.filter(
                content_type=ld_ct,
                object_id=ld.id,
                visibility=Comment.Visibility.SHARED,
                organization_id=ld.organization_id,
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
            CommentReadState.objects.filter(
                viewer_client=request.user,
                content_type=ld_ct,
                object_id=ld.id,
            )
            .values("last_read_at")
            .first()
        )
        return Response(
            {
                "results": [_serialise(c) for c in comments],
                "read_state": (
                    read_row["last_read_at"].isoformat()
                    if read_row
                    else None
                ),
                "label_design_id": str(ld.id),
            },
        )


class LabelDesignChatPostView(PortalAPIView):
    """``POST /api/portal/label-designs/<id>/messages/post/``."""

    def post(self, request: Request, label_design_id: str) -> Response:
        from apps.label_design.models import LabelDesign

        ld = _load_owned_label_design(request, label_design_id)
        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err(
                "invalid_message",
                status.HTTP_400_BAD_REQUEST,
                detail=exc.detail,
            )

        ld_ct = ContentType.objects.get_for_model(LabelDesign)
        parent_id = data.validated_data.get("parent_id")
        parent: Comment | None = None
        if parent_id:
            parent = (
                Comment.objects.filter(
                    pk=parent_id,
                    content_type=ld_ct,
                    object_id=ld.id,
                    visibility=Comment.Visibility.SHARED,
                    organization_id=ld.organization_id,
                )
                .first()
            )
            if parent is None:
                return _err(
                    "invalid_reply_target",
                    status.HTTP_400_BAD_REQUEST,
                )
            if parent.parent_id is not None:
                parent = parent.parent

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=ld.organization_id,
                content_type=ld_ct,
                object_id=ld.id,
                label_design=ld,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
                parent=parent,
            )
            schedule_comment_broadcast(comment, "created")
            # Fire the comment-notification pipeline so staff
            # @-mentions land in their inbox and a "customer
            # posted" email goes to staff watching the thread.
            # ``on_commit`` so a rollback suppresses both.
            _db_tx.on_commit(
                lambda c=comment: enqueue_notifications_for_comment(c.id)
            )

        return Response(_serialise(comment), status=status.HTTP_201_CREATED)


class LabelDesignChatReadView(PortalAPIView):
    """``POST /api/portal/label-designs/<id>/messages/read/``."""

    def post(self, request: Request, label_design_id: str) -> Response:
        from apps.label_design.models import LabelDesign

        ld = _load_owned_label_design(request, label_design_id)
        ld_ct = ContentType.objects.get_for_model(LabelDesign)
        CommentReadState.objects.update_or_create(
            viewer_client=request.user,
            content_type=ld_ct,
            object_id=ld.id,
            defaults={
                "organization_id": ld.organization_id,
                "last_read_at": timezone.now(),
            },
        )
        return Response({"detail": "ok"})


class SpecMessageThreadView(PortalAPIView):
    """``GET + POST /api/portal/specs/<sheet_id>/messages/``.

    Single resource: ``GET`` lists shared comments scoped to one
    spec (used by the standalone spec-detail page);
    ``POST`` creates a new comment via :class:`SpecMessagePostView`
    so we keep one URL path with two verbs and don't break the
    existing test contract.
    """

    def post(self, request: Request, sheet_id: str) -> Response:
        return SpecMessagePostView().post(request, sheet_id)

    def get(self, request: Request, sheet_id: str) -> Response:
        from apps.specifications.models import SpecificationSheet

        sheet = _load_owned_spec(request, sheet_id)
        spec_ct = ContentType.objects.get_for_model(SpecificationSheet)
        comments = (
            Comment.objects
            .filter(
                content_type=spec_ct,
                object_id=sheet.id,
                visibility=Comment.Visibility.SHARED,
                organization_id=sheet.organization_id,
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
                content_type=spec_ct,
                object_id=sheet.id,
            )
            .values("last_read_at")
            .first()
        )
        return Response(
            {
                "results": [_serialise(c) for c in comments],
                "read_state": (
                    {str(sheet.id): read_row["last_read_at"].isoformat()}
                    if read_row
                    else {}
                ),
            },
        )


class SpecMessageReadView(PortalAPIView):
    """``POST /api/portal/specs/<sheet_id>/messages/read/``.

    Bump the client's per-thread last-read timestamp on this spec.
    Idempotent — the row is upserted via ``update_or_create``.
    """

    def post(self, request: Request, sheet_id: str) -> Response:
        from apps.specifications.models import SpecificationSheet

        sheet = _load_owned_spec(request, sheet_id)
        spec_ct = ContentType.objects.get_for_model(SpecificationSheet)

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
