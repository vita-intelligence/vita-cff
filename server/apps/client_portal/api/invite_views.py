"""Public REST endpoints for the customer-portal invite flow.

Mirrors the kiosk activation pair (preview + submit) but driven by
:class:`apps.client_portal.models.CustomerPortalInvite` instead of
``Proposal.public_token``. Lives in its own module so the existing
:mod:`apps.client_portal.api.views` doesn't grow another 200 lines
of activation surface and the import graph stays narrow.
"""

from __future__ import annotations

import logging
import uuid

from django.core.exceptions import ValidationError
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.cookies import (
    set_portal_auth_cookies,
    tokens_for_client,
)
from apps.client_portal.invite_services import (
    InvalidInviteToken,
    InviteAlreadyUsed,
    InviteEmailMissing,
    InviteError,
    InviteExpired,
    activate_via_invite,
    preview_invite,
)
from apps.client_portal.services import (
    AccountAlreadyActivated,
    ActivationError,
    InvalidActivationCode,
)

from .serializers import (
    ActivationPreviewSerializer,
    ActivationRequestSerializer,
    MeSerializer,
)
from .views import (
    PortalPublicAPIView,
    _err,
    _me_payload,
)

logger = logging.getLogger(__name__)


def _parse_token(raw: str) -> uuid.UUID:
    """Convert the URL path component to a UUID or raise the same
    "no such invite" error the resolver would on a missing row, so
    a malformed token leaks no more information than an unknown one.
    """

    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError) as exc:
        raise InvalidInviteToken("Malformed invite token.") from exc


class InvitePreviewView(PortalPublicAPIView):
    """``GET /api/portal/invites/<token>/preview/``.

    Read-only summary the activate page paints on mount. Returns
    the customer company, a masked email, and ``already_activated`` /
    ``expired`` flags so the page can pick the right copy without
    making the customer submit a blank form first.
    """

    def get(self, request: Request, token: str) -> Response:
        try:
            payload = preview_invite(token=_parse_token(token))
        except InvalidInviteToken:
            return _err("invalid_invite_token", status.HTTP_404_NOT_FOUND)
        except InviteEmailMissing:
            return _err("invite_email_missing", status.HTTP_409_CONFLICT)
        return Response(ActivationPreviewSerializer(payload).data)


class InviteActivateView(PortalPublicAPIView):
    """``POST /api/portal/invites/<token>/activate/``.

    On success: sets portal cookies + returns the same ``MeSerializer``
    shape the kiosk activation endpoint emits, so the frontend can
    reuse one post-activate routing path.
    """

    def post(self, request: Request, token: str) -> Response:
        serializer = ActivationRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        password = serializer.validated_data["password"]
        code = serializer.validated_data["code"]

        try:
            result = activate_via_invite(
                token=_parse_token(token),
                password=password,
                code=code,
            )
        except AccountAlreadyActivated:
            return _err(
                "account_already_activated",
                status.HTTP_409_CONFLICT,
            )
        except InvalidActivationCode:
            return _err(
                "invalid_activation_code",
                status.HTTP_400_BAD_REQUEST,
            )
        except InviteExpired:
            return _err("invite_expired", status.HTTP_410_GONE)
        except InviteAlreadyUsed:
            return _err("invite_already_used", status.HTTP_409_CONFLICT)
        except InvalidInviteToken:
            return _err("invalid_invite_token", status.HTTP_404_NOT_FOUND)
        except InviteEmailMissing:
            return _err("invite_email_missing", status.HTTP_409_CONFLICT)
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        except (InviteError, ActivationError) as exc:
            return _err(getattr(exc, "code", "activation_failed"), status.HTTP_400_BAD_REQUEST)

        account = result.account
        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)
        return response
