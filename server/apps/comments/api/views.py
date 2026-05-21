"""Views for the comments API.

Every endpoint authorises through :class:`HasCommentsPermission`,
which requires the caller to be a member of the URL-scoped
organization and to hold the capability the view declares. The
capability matrix:

* ``GET`` list / detail → ``COMMENTS_VIEW``
* ``POST`` create / reply → ``COMMENTS_WRITE``
* ``PATCH`` edit → ``COMMENTS_WRITE`` (+ author-of-comment guard in
  the service layer)
* ``DELETE`` → ``COMMENTS_WRITE`` for own comments, ``COMMENTS_MODERATE``
  for other people's comments
* ``POST`` resolve / unresolve → ``COMMENTS_WRITE`` for own threads,
  ``COMMENTS_MODERATE`` otherwise
* ``GET`` mentionable members → ``COMMENTS_VIEW``

Two concrete endpoint surfaces:

* ``/formulations/<id>/comments/`` — thread on a formulation project
* ``/specifications/<id>/comments/`` — thread on a spec sheet

The entity-specific list / create endpoints forward to
:func:`~apps.comments.services.create_comment`, which validates
target and parent alike. The flat ``/comments/<id>/`` endpoints
handle edit / delete / resolve without needing the parent entity's
id in the URL.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.comments.api.pagination import CommentCursorPagination
from apps.cff_submissions.api.permissions import HasCFFPermission
from apps.comments.api.permissions import HasCommentsPermission
from apps.comments.api.serializers import (
    CommentCreateSerializer,
    CommentEditSerializer,
    CommentReadSerializer,
    MentionableMemberSerializer,
)
from apps.comments.services import (
    CommentBodyBlank,
    CommentNotFound,
    CommentPermissionDenied,
    CommentReplyDepthExceeded,
    CommentResolveNonRoot,
    CommentTargetInvalid,
    create_comment,
    delete_comment,
    edit_comment,
    flag_thread,
    get_comment,
    list_thread,
    resolve_thread,
    unflag_thread,
    unresolve_thread,
)
from apps.formulations.models import Formulation
from apps.organizations.modules import (
    FORMULATIONS_MODULE,
    FormulationsCapability,
)
from apps.organizations.services import has_capability, get_membership
from apps.specifications.models import SpecificationSheet


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_formulation(organization, formulation_id) -> Formulation:
    formulation = (
        Formulation.objects.filter(
            organization=organization, id=formulation_id
        ).first()
    )
    if formulation is None:
        raise NotFound()
    return formulation


def _load_proposal(organization, proposal_id):
    """Match the loader pattern used for formulation / spec — 404 if
    the proposal isn't in the actor's organisation. Keeps the
    leak-proof contract consistent across target types."""

    from apps.proposals.models import Proposal
    try:
        return Proposal.objects.get(
            organization=organization, id=proposal_id,
        )
    except Proposal.DoesNotExist:  # pragma: no cover — exercised by tests
        from django.http import Http404
        raise Http404("Proposal not found.")


def _load_specification(organization, sheet_id) -> SpecificationSheet:
    sheet = (
        SpecificationSheet.objects.filter(
            organization=organization, id=sheet_id
        ).first()
    )
    if sheet is None:
        raise NotFound()
    return sheet


def _load_cff_submission(organization, submission_id):
    """Resolve a CFFSubmission in the caller's org or 404. Same
    leak-proof contract as the other loaders — a stranger guessing
    at UUIDs sees the same response as a member hitting a deleted
    row."""

    from apps.cff_submissions.models import CFFSubmission
    submission = (
        CFFSubmission.objects.filter(
            organization=organization, id=submission_id,
        ).first()
    )
    if submission is None:
        raise NotFound()
    return submission


def _read_response(comment) -> Response:
    return Response(
        CommentReadSerializer(comment).data, status=status.HTTP_200_OK
    )


def _translate_target_invalid(exc: CommentTargetInvalid) -> Response:
    return Response(
        {"target": [exc.api_code]}, status=status.HTTP_400_BAD_REQUEST
    )


def _translate_reply_depth(exc: CommentReplyDepthExceeded) -> Response:
    return Response(
        {"parent_id": [exc.api_code]},
        status=status.HTTP_400_BAD_REQUEST,
    )


def _translate_resolve_non_root(exc: CommentResolveNonRoot) -> Response:
    return Response(
        {"is_resolved": [exc.api_code]},
        status=status.HTTP_400_BAD_REQUEST,
    )


def _translate_body_blank(exc: CommentBodyBlank) -> Response:
    return Response(
        {"body": [exc.api_code]},
        status=status.HTTP_400_BAD_REQUEST,
    )


# ---------------------------------------------------------------------------
# Per-entity list / create endpoints
# ---------------------------------------------------------------------------


class _EntityCommentListBase(APIView):
    """Shared list + create path for a single target entity."""

    permission_classes = (HasCommentsPermission,)

    target_kind: str = ""  # subclass sets "formulation" or "specification"

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.COMMENTS_WRITE
            if request.method == "POST"
            else FormulationsCapability.COMMENTS_VIEW
        )
        super().initial(request, *args, **kwargs)

    def _target(self, request: Request, **url_kwargs) -> Any:
        raise NotImplementedError

    def get(self, request: Request, *args, **url_kwargs) -> Response:
        target = self._target(request, **url_kwargs)
        include_resolved = _parse_bool(
            request.query_params.get("include_resolved"), default=True
        )
        include_deleted = _parse_bool(
            request.query_params.get("include_deleted"), default=True
        )
        queryset = list_thread(
            organization=self.organization,
            target=target,
            include_resolved=include_resolved,
            include_deleted=include_deleted,
        )
        paginator = CommentCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = CommentReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, *args, **url_kwargs) -> Response:
        target = self._target(request, **url_kwargs)
        serializer = CommentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        parent = None
        if data.get("parent_id"):
            try:
                parent = get_comment(
                    organization=self.organization,
                    comment_id=data["parent_id"],
                )
            except CommentNotFound:
                return Response(
                    {"parent_id": ["comment_not_found"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            comment = create_comment(
                organization=self.organization,
                actor=request.user,
                target=target,
                body=data["body"],
                parent=parent,
            )
        except CommentBodyBlank as exc:
            return _translate_body_blank(exc)
        except CommentReplyDepthExceeded as exc:
            return _translate_reply_depth(exc)
        except CommentTargetInvalid as exc:
            return _translate_target_invalid(exc)

        return Response(
            CommentReadSerializer(comment).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationCommentsView(_EntityCommentListBase):
    """``GET``/``POST`` ``/formulations/<id>/comments/``."""

    target_kind = "formulation"

    def _target(self, request: Request, **url_kwargs) -> Any:
        return _load_formulation(
            self.organization, url_kwargs["formulation_id"]
        )


class SpecificationCommentsView(_EntityCommentListBase):
    """``GET``/``POST`` ``/specifications/<id>/comments/``."""

    target_kind = "specification"

    def _target(self, request: Request, **url_kwargs) -> Any:
        return _load_specification(
            self.organization, url_kwargs["sheet_id"]
        )


class ProposalCommentsView(_EntityCommentListBase):
    """``GET``/``POST`` ``/proposals/<id>/comments/``.

    Staff-side surface for the proposal-level customer chat the
    portal posts to via ``/api/portal/proposals/<id>/proposal-messages/``.
    Same view contract as the formulation / specification variants
    so it slots into the existing comments bubble without any new
    UI affordances on the staff side.
    """

    target_kind = "proposal"

    def _target(self, request: Request, **url_kwargs) -> Any:
        return _load_proposal(self.organization, url_kwargs["proposal_id"])


class CFFSubmissionCommentsView(_EntityCommentListBase):
    """``GET``/``POST`` ``/cff-submissions/<id>/comments/``.

    Internal triage chat scoped to one CFF (Custom Formulation
    Request) submission — staff discusses how to route the inbound
    request before it becomes a project. The customer who submitted
    the CFF never sees this thread; default visibility on
    :func:`apps.comments.services.create_comment` is ``internal``
    for ``cff_submission`` targets (the only client-visible
    defaults are ``specification_sheet`` + ``proposal``).

    Gates on the ``cff_submissions`` module rather than the
    formulations comments capability — same access axis as the
    rest of the CFF surface, so commercial roles that triage the
    intake can also comment without holding the projects module.
    """

    target_kind = "cff_submission"
    # Swap the formulations gate the base class assumes for the CFF
    # one — :class:`HasCFFPermission` checks
    # ``cff_submissions.view`` against ``view.required_capability``.
    permission_classes = (HasCFFPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # CFF threads don't (yet) split read vs write at the
        # capability layer — any member with ``cff_submissions.view``
        # can both read and post. If a future role needs to be
        # read-only here, add a ``COMMENT_WRITE`` capability to
        # :class:`CFFSubmissionsCapability` and split this branch
        # by ``request.method``.
        from apps.organizations.modules import CFFSubmissionsCapability
        self.required_capability = CFFSubmissionsCapability.VIEW
        # Skip the parent's ``initial`` (which would otherwise
        # overwrite ``required_capability`` with a formulations
        # value) and go straight to ``APIView.initial`` so the
        # permission check fires against our CFF gate.
        APIView.initial(self, request, *args, **kwargs)

    def _target(self, request: Request, **url_kwargs) -> Any:
        return _load_cff_submission(
            self.organization, url_kwargs["submission_id"]
        )


# ---------------------------------------------------------------------------
# Per-comment detail endpoints (PATCH / DELETE)
# ---------------------------------------------------------------------------


class CommentDetailView(APIView):
    """``PATCH`` edit body; ``DELETE`` soft-delete."""

    permission_classes = (HasCommentsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # DRF will have already authenticated and scoped to
        # the org — we pick the capability per-method. The stricter
        # "moderate" check happens inside the service layer based on
        # whether the caller is the comment's author.
        self.required_capability = FormulationsCapability.COMMENTS_WRITE
        super().initial(request, *args, **kwargs)

    def _load(self, comment_id) -> Any:
        try:
            return get_comment(
                organization=self.organization, comment_id=comment_id
            )
        except CommentNotFound as exc:
            raise NotFound() from exc

    def patch(
        self, request: Request, org_id: str, comment_id: str
    ) -> Response:
        comment = self._load(comment_id)
        serializer = CommentEditSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            updated = edit_comment(
                comment=comment,
                actor=request.user,
                body=serializer.validated_data["body"],
            )
        except CommentBodyBlank as exc:
            return _translate_body_blank(exc)
        except CommentPermissionDenied:
            return Response(
                {"detail": ["comment_permission_denied"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        return _read_response(updated)

    def delete(
        self, request: Request, org_id: str, comment_id: str
    ) -> Response:
        comment = self._load(comment_id)
        membership = get_membership(request.user, self.organization)
        is_moderator = has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_MODERATE,
        )
        try:
            delete_comment(
                comment=comment,
                actor=request.user,
                is_moderator=is_moderator,
            )
        except CommentPermissionDenied:
            return Response(
                {"detail": ["comment_permission_denied"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class CommentResolveView(APIView):
    """``POST`` ``/comments/<id>/resolve/`` or ``/unresolve/``."""

    permission_classes = (HasCommentsPermission,)
    required_capability = FormulationsCapability.COMMENTS_WRITE

    action: str = "resolve"  # overridden in urls.py per route

    def _load(self, comment_id) -> Any:
        try:
            return get_comment(
                organization=self.organization, comment_id=comment_id
            )
        except CommentNotFound as exc:
            raise NotFound() from exc

    def post(
        self, request: Request, org_id: str, comment_id: str
    ) -> Response:
        comment = self._load(comment_id)
        membership = get_membership(request.user, self.organization)
        is_moderator = has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_MODERATE,
        )
        try:
            if self.action == "resolve":
                comment = resolve_thread(
                    comment=comment,
                    actor=request.user,
                    is_moderator=is_moderator,
                )
            else:
                comment = unresolve_thread(
                    comment=comment,
                    actor=request.user,
                    is_moderator=is_moderator,
                )
        except CommentResolveNonRoot as exc:
            return _translate_resolve_non_root(exc)
        except CommentPermissionDenied:
            return Response(
                {"detail": ["comment_permission_denied"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        return _read_response(comment)


class CommentFlagView(APIView):
    """``POST`` ``/comments/<id>/flag/`` or ``/unflag/``.

    Flagging a root comment as "needs resolution" pins it to the
    top of the thread list and unlocks the Resolve action. Unflagging
    clears it without marking the thread resolved — useful when the
    flag was an accident.
    """

    permission_classes = (HasCommentsPermission,)
    required_capability = FormulationsCapability.COMMENTS_WRITE

    action: str = "flag"  # overridden in urls.py per route

    def _load(self, comment_id) -> Any:
        try:
            return get_comment(
                organization=self.organization, comment_id=comment_id
            )
        except CommentNotFound as exc:
            raise NotFound() from exc

    def post(
        self, request: Request, org_id: str, comment_id: str
    ) -> Response:
        comment = self._load(comment_id)
        membership = get_membership(request.user, self.organization)
        is_moderator = has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_MODERATE,
        )
        try:
            if self.action == "flag":
                comment = flag_thread(
                    comment=comment,
                    actor=request.user,
                    is_moderator=is_moderator,
                )
            else:
                comment = unflag_thread(
                    comment=comment,
                    actor=request.user,
                    is_moderator=is_moderator,
                )
        except CommentResolveNonRoot as exc:
            return _translate_resolve_non_root(exc)
        except CommentPermissionDenied:
            return Response(
                {"detail": ["comment_permission_denied"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        return _read_response(comment)


# ---------------------------------------------------------------------------
# Mentionable members lookup (autocomplete feed)
# ---------------------------------------------------------------------------


class MentionableMembersView(APIView):
    """``GET`` ``/members/mentionable/?q=...``.

    Returns a capped list of active org members matching the query.
    Used by the @-mention autocomplete. Query optional — empty query
    returns the top of the list so the picker can open instantly.
    """

    permission_classes = (HasCommentsPermission,)
    required_capability = FormulationsCapability.COMMENTS_VIEW

    _DEFAULT_LIMIT = 20
    _MAX_LIMIT = 100

    def get(self, request: Request, org_id: str) -> Response:
        from apps.organizations.models import Membership

        q = (request.query_params.get("q") or "").strip()
        try:
            limit = int(request.query_params.get("limit") or self._DEFAULT_LIMIT)
        except (TypeError, ValueError):
            limit = self._DEFAULT_LIMIT
        limit = max(1, min(limit, self._MAX_LIMIT))

        memberships = (
            Membership.objects.filter(
                organization=self.organization, user__is_active=True
            )
            .select_related("user")
        )
        if q:
            from django.db.models import Q

            memberships = memberships.filter(
                Q(user__email__icontains=q)
                | Q(user__first_name__icontains=q)
                | Q(user__last_name__icontains=q)
            )
        memberships = memberships.order_by("user__first_name", "user__last_name")[
            :limit
        ]
        payload = [
            {
                "id": str(m.user_id),
                "name": (m.user.get_full_name() or m.user.email).strip(),
                "email": m.user.email,
                "avatar_url": m.user.avatar_image or "",
            }
            for m in memberships
        ]
        serializer = MentionableMemberSerializer(payload, many=True)
        return Response({"results": serializer.data})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_bool(value, *, default: bool) -> bool:
    if value is None:
        return default
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return default
