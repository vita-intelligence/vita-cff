"""Public (token-gated) kiosk comment endpoints.

Shape:

* ``POST /api/public/specifications/<token>/identify/`` — captures
  guest name / email / optional company, writes a
  :class:`KioskSession`, returns a signed cookie + the identity echo.
* ``GET /api/public/specifications/<token>/comments/`` — list the
  comment thread attached to the shared sheet.
* ``POST /api/public/specifications/<token>/comments/`` — post a
  guest comment. Requires the signed session cookie from
  ``identify/``. Rate-limited per-session (see
  :mod:`apps.comments.kiosk`).

Every error path short-circuits to the same ``404`` / ``403`` error
codes the React client already knows how to translate, so a rotated
share link or a rate-limited visitor sees a stable message.
"""

from __future__ import annotations

from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.comments.api.pagination import CommentCursorPagination
from apps.comments.api.serializers import CommentReadSerializer
from apps.comments.kiosk import (
    KioskRateLimited,
    KioskSessionInvalid,
    KioskSessionRevoked,
    KioskTokenInvalid,
    attach_cookie,
    clear_cookie,
    enforce_rate_limit,
    identify_visitor,
    resolve_from_request,
)
from apps.comments.services import (
    CommentBodyBlank,
    CommentNotFound,
    CommentReplyDepthExceeded,
    CommentTargetInvalid,
    create_guest_comment,
    get_comment,
    list_thread,
)
from apps.specifications.services import (
    PublicLinkNotEnabled,
    get_by_public_token,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_sheet_or_404(token: str):
    try:
        return get_by_public_token(token)
    except PublicLinkNotEnabled as exc:
        raise NotFound() from exc


def _kiosk_error(exc: Exception) -> Response:
    """Map every kiosk exception onto a stable ``api_code`` response.

    The router guards in the service / kiosk modules raise one of a
    handful of known exceptions; the view translates each one into
    the same 403 shape the React client already renders.
    """

    api_code = getattr(exc, "api_code", "kiosk_error")
    if isinstance(exc, KioskTokenInvalid):
        return Response({"detail": [api_code]}, status=status.HTTP_404_NOT_FOUND)
    return Response({"detail": [api_code]}, status=status.HTTP_403_FORBIDDEN)


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


class PublicSpecificationIdentifyView(APIView):
    """``POST`` ``/api/public/specifications/<token>/identify/``.

    Body::

        {
          "name": "Jane Doe",
          "email": "jane@acme.example",
          "company": "ACME Corp"   // optional
        }

    Returns the guest's echo payload and stamps a signed session
    cookie. The response body intentionally **does not** carry the
    raw session id — the cookie is the only way to prove identity
    on subsequent calls.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        data = request.data if isinstance(request.data, dict) else {}
        name = str(data.get("name", "") or "").strip()
        email = str(data.get("email", "") or "").strip()
        company = str(data.get("company", "") or "").strip()

        if not name or not email:
            return Response(
                {
                    "name": [] if name else ["required"],
                    "email": [] if email else ["required"],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            session, token_uuid = identify_visitor(
                public_token=token,
                guest_name=name,
                guest_email=email,
                guest_org_label=company,
            )
        except KioskTokenInvalid as exc:
            return _kiosk_error(exc)

        response = Response(
            {
                "name": session.guest_name,
                "email": session.guest_email,
                "company": session.guest_org_label,
            },
            status=status.HTTP_200_OK,
        )
        attach_cookie(response, session)
        return response

    def delete(self, request: Request, token: str) -> Response:
        """Client-side sign-out — clears the signed cookie and marks
        the matching session revoked so it cannot be replayed."""

        sheet = _load_sheet_or_404(token)
        try:
            identity = resolve_from_request(request, token)
        except (KioskSessionInvalid, KioskSessionRevoked):
            # Already logged out / invalid — still clear the cookie
            # so the browser state is clean.
            response = Response(status=status.HTTP_204_NO_CONTENT)
            clear_cookie(response, sheet.public_token)
            return response
        session = identity.session
        session.revoked_at = timezone.now()
        session.save(update_fields=["revoked_at"])
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_cookie(response, sheet.public_token)
        return response


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


class PublicSpecificationCommentsView(APIView):
    """``GET`` / ``POST`` ``/api/public/specifications/<token>/comments/``.

    ``GET`` is open to anyone with a valid share link — the comment
    thread is part of the shared preview. ``POST`` requires a signed
    kiosk session cookie (via :func:`resolve_from_request`).
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        sheet = _load_sheet_or_404(token)
        include_resolved = _parse_bool(
            request.query_params.get("include_resolved"), default=True
        )

        queryset = list_thread(
            organization=sheet.organization,
            target=sheet,
            include_resolved=include_resolved,
        )
        paginator = CommentCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = CommentReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, token: str) -> Response:
        sheet = _load_sheet_or_404(token)

        try:
            identity = resolve_from_request(request, token)
        except (
            KioskTokenInvalid,
            KioskSessionInvalid,
            KioskSessionRevoked,
        ) as exc:
            return _kiosk_error(exc)

        data = request.data if isinstance(request.data, dict) else {}
        body = str(data.get("body", "") or "")
        parent_id = data.get("parent_id") or None

        parent = None
        if parent_id:
            try:
                parent = get_comment(
                    organization=sheet.organization,
                    comment_id=str(parent_id),
                )
            except CommentNotFound:
                return Response(
                    {"parent_id": ["comment_not_found"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            enforce_rate_limit(identity.session)
        except KioskRateLimited as exc:
            return _kiosk_error(exc)

        try:
            comment = create_guest_comment(
                session=identity.session,
                target=sheet,
                body=body,
                parent=parent,
            )
        except CommentBodyBlank:
            return Response(
                {"body": ["comment_body_blank"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CommentReplyDepthExceeded:
            return Response(
                {"parent_id": ["comment_reply_depth_exceeded"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CommentTargetInvalid:
            return Response(
                {"target": ["comment_target_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            CommentReadSerializer(comment).data,
            status=status.HTTP_201_CREATED,
        )


def _parse_bool(value, *, default: bool) -> bool:
    if value is None:
        return default
    lowered = str(value).strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    return default
