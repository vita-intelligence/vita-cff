"""HTTP surface for the client portal.

Three groups of endpoints:

1. **Activation + auth** — ``/portal/activate/...``, ``/portal/auth/...``.
   Public (no portal cookie required) because they ISSUE the cookie.
2. **Identity** — ``/portal/auth/me/``. Authenticated; returns the
   minimal shape the dashboard needs to render the "Hi <Company>"
   banner without round-tripping to the customer detail endpoint.
3. **Proposals** — ``/portal/proposals/...``. Authenticated +
   ownership-gated. The list is filtered to the client's customer;
   detail / sign / reject endpoints assert
   ``proposal.customer_id == request.user.customer_id`` before any
   write happens.

Every authenticated endpoint inherits
:class:`apps.client_portal.permissions.IsClientAccount` via the
:class:`PortalAPIView` base class so a staff JWT in the portal
cookie can never accidentally pass — even if the cookie names ever
collided, the user-type check would catch it.
"""

from __future__ import annotations

import logging
import uuid

from django.core.exceptions import ValidationError
from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.client_portal.auth import PortalCookieJWTAuthentication
from apps.client_portal.cookies import (
    clear_portal_auth_cookies,
    set_portal_auth_cookies,
    tokens_for_client,
)
from apps.client_portal.email import send_portal_password_reset_email
from apps.client_portal.permissions import (
    ClientOwnsProposal,
    IsClientAccount,
)
from apps.client_portal.services import (
    AccountAlreadyActivated,
    ActivationError,
    CustomerEmailMissing,
    InvalidActivationToken,
    InvalidCredentials,
    activate_via_token,
    authenticate_client,
    confirm_password_reset,
    preview_activation,
    request_password_reset,
)
from apps.client_portal.api.serializers import (
    ActivationPreviewSerializer,
    ActivationRequestSerializer,
    LoginRequestSerializer,
    MeSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    ProposalListItemSerializer,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _request_ip(request: Request) -> str:
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or ""


def _err(code: str, http_status: int, **extra) -> Response:
    body = {"code": code, "detail": [code]}
    body.update(extra)
    return Response(body, status=http_status)


class PortalAuthMixin:
    """Authenticate every portal endpoint via the portal cookie."""

    authentication_classes = (PortalCookieJWTAuthentication,)


class PortalAPIView(PortalAuthMixin, APIView):
    """Base for authenticated portal endpoints."""

    permission_classes = (IsClientAccount,)


class PortalPublicAPIView(PortalAuthMixin, APIView):
    """Base for cookie-issuing endpoints (activate, login, etc.)."""

    permission_classes = (AllowAny,)


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------


def _parse_token(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError) as exc:
        raise InvalidActivationToken("Malformed activation token.") from exc


class ActivationPreviewView(PortalPublicAPIView):
    """``GET /api/portal/activate/<token>/``.

    Read-only peek so the activation page can pick the right copy
    (set password vs. sign in) before the client submits anything.
    """

    def get(self, request: Request, token: str) -> Response:
        try:
            payload = preview_activation(token=_parse_token(token))
        except CustomerEmailMissing:
            return _err("customer_email_missing", status.HTTP_409_CONFLICT)
        except InvalidActivationToken:
            return _err("invalid_activation_token", status.HTTP_404_NOT_FOUND)
        return Response(ActivationPreviewSerializer(payload).data)


class ActivationView(PortalPublicAPIView):
    """``POST /api/portal/activate/<token>/``.

    On success: sets portal cookies + returns ``MeSerializer``.
    """

    def post(self, request: Request, token: str) -> Response:
        serializer = ActivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        password = serializer.validated_data["password"]

        try:
            result = activate_via_token(
                token=_parse_token(token),
                password=password,
            )
        except CustomerEmailMissing:
            return _err("customer_email_missing", status.HTTP_409_CONFLICT)
        except AccountAlreadyActivated:
            return _err(
                "account_already_activated",
                status.HTTP_409_CONFLICT,
            )
        except InvalidActivationToken:
            return _err("invalid_activation_token", status.HTTP_404_NOT_FOUND)
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        except ActivationError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)

        account = result.account
        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response


# ---------------------------------------------------------------------------
# Login / logout / me
# ---------------------------------------------------------------------------


class LoginView(PortalPublicAPIView):
    """``POST /api/portal/auth/login/``."""

    def post(self, request: Request) -> Response:
        serializer = LoginRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            account = authenticate_client(
                email=serializer.validated_data["email"],
                password=serializer.validated_data["password"],
                request_ip=_request_ip(request),
            )
        except InvalidCredentials:
            return _err("invalid_credentials", status.HTTP_401_UNAUTHORIZED)

        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response


class LogoutView(PortalPublicAPIView):
    """``POST /api/portal/auth/logout/``.

    AllowAny because the cookie may already be expired; deleting it
    on the client is a no-op-safe operation. We don't bother to
    revoke the refresh token server-side — the cookie clear is the
    operational answer for "I want to sign out", and the access TTL
    is short (60 min) so any stolen token expires soon anyway.
    """

    def post(self, request: Request) -> Response:
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_portal_auth_cookies(response)
        return response


class MeView(PortalAPIView):
    """``GET /api/portal/auth/me/``."""

    def get(self, request: Request) -> Response:
        return Response(_me_payload(request.user))


def _me_payload(account) -> dict:
    customer = account.customer
    return MeSerializer(
        {
            "id": account.id,
            "email": account.email,
            "customer_id": customer.id,
            "customer_company": customer.company or "",
            "customer_name": customer.name or "",
            "activated_at": account.activated_at,
        }
    ).data


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------


class PasswordResetRequestView(PortalPublicAPIView):
    """``POST /api/portal/auth/password-reset/request/``.

    Enumeration-safe: always returns 200 with the same body shape,
    whether or not the email matched a real account.
    """

    def post(self, request: Request) -> Response:
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        issued = request_password_reset(
            email=serializer.validated_data["email"],
            requested_ip=_request_ip(request),
        )
        if issued is not None:
            try:
                send_portal_password_reset_email(
                    to_email=issued.account.email,
                    plaintext_token=issued.plaintext_token,
                )
            except Exception:  # noqa: BLE001 — log + degrade
                logger.exception(
                    "portal.reset: failed to send reset email to %s",
                    issued.account.email,
                )
        return Response({"detail": "ok"})


class PasswordResetConfirmView(PortalPublicAPIView):
    """``POST /api/portal/auth/password-reset/confirm/``."""

    def post(self, request: Request) -> Response:
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            account = confirm_password_reset(
                token=serializer.validated_data["token"],
                new_password=serializer.validated_data["new_password"],
            )
        except ValueError:
            return _err(
                "invalid_or_expired_token",
                status.HTTP_400_BAD_REQUEST,
            )
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )

        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response


# ---------------------------------------------------------------------------
# Proposals (dashboard + detail)
# ---------------------------------------------------------------------------


class ProposalListView(PortalAPIView):
    """``GET /api/portal/proposals/``.

    Lists every proposal whose ``customer_id`` matches the logged-in
    client's customer. Newest first. No pagination yet — typical
    customer has handful of proposals; revisit when a real
    enterprise client lands.
    """

    def get(self, request: Request) -> Response:
        from apps.proposals.models import Proposal

        proposals = (
            Proposal.objects
            .filter(customer_id=request.user.customer_id)
            .order_by("-updated_at")
        )
        rows = [
            {
                "id": p.id,
                "code": p.code or "",
                "title": getattr(p, "title", "") or p.code or "",
                "status": p.status,
                "updated_at": p.updated_at,
                "created_at": p.created_at,
                "public_token": p.public_token,
            }
            for p in proposals
        ]
        return Response(
            {"results": ProposalListItemSerializer(rows, many=True).data},
        )


class ProposalDetailView(PortalAPIView):
    """``GET /api/portal/proposals/<id>/``.

    Reuses the proposal-detail serializer from the staff side so
    the portal renders the same shape. Ownership is checked
    explicitly inside the view (the
    :class:`ClientOwnsProposal` permission could also do it; doing
    it here keeps the 404 path consistent with other not-found
    surfaces).
    """

    def get(self, request: Request, proposal_id: str) -> Response:
        from apps.proposals.models import Proposal
        from apps.proposals.api.serializers import ProposalSerializer

        proposal = (
            Proposal.objects
            .select_related("customer", "organization")
            .filter(pk=proposal_id)
            .first()
        )
        if proposal is None:
            raise NotFound("Proposal not found.")
        if proposal.customer_id != request.user.customer_id:
            # Same 404 — don't leak existence of proposals belonging
            # to a different customer.
            raise NotFound("Proposal not found.")
        return Response(ProposalSerializer(proposal).data)
