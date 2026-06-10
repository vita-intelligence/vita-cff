"""HTTP surface for the client-portal self-registration flow.

Two endpoints, both public (cookie-issuing):

* ``POST /api/portal/register/`` — step 1. Validates the form, mints a
  pending registration + emails the 6-digit code.
* ``POST /api/portal/register/confirm/`` — step 2. Verifies the code,
  creates the Customer + ClientAccount, sets the portal cookies, and
  returns the ``MeSerializer`` payload so the FE can route to the
  portal home without a follow-up ``/auth/me/`` round trip.

Error mapping mirrors :class:`apps.client_portal.api.views.ActivationView`:
every codified service-layer exception becomes a 400/409/etc with a
``{"code": "...", "detail": ["..."]}`` body the FE error mapper
already understands.
"""

from __future__ import annotations

import logging

from django.core.exceptions import ValidationError
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.cookies import (
    set_portal_auth_cookies,
    tokens_for_client,
)
from apps.client_portal.models import PortalEvent
from apps.client_portal.registration_services import (
    InvalidRegistrationCode,
    InvalidRegistrationToken,
    MultipleActiveOrganizations,
    NoActiveOrganization,
    PrivacyPolicyNotAccepted,
    RegistrationAlreadyUsed,
    RegistrationEmailMissing,
    RegistrationError,
    RegistrationExpired,
    finalize_self_registration,
    start_self_registration,
)
from apps.client_portal.services import record_portal_event

from .serializers import (
    MeSerializer,
    RegistrationConfirmRequestSerializer,
    RegistrationStartRequestSerializer,
    RegistrationStartResponseSerializer,
)
from .views import PortalPublicAPIView, _err, _request_ip


logger = logging.getLogger(__name__)


def _me_payload(account) -> dict:
    """Same shape as :func:`apps.client_portal.api.views._me_payload`
    — kept inline to avoid importing through ``views`` which would
    re-export the whole module's surface.
    """

    customer = account.customer
    return MeSerializer(
        {
            "id": account.id,
            "email": account.email,
            "customer_id": customer.id,
            "customer_company": customer.company or "",
            "customer_name": customer.name or "",
            "activated_at": account.activated_at,
            "avatar_image": account.avatar_image or "",
        }
    ).data


class RegistrationStartView(PortalPublicAPIView):
    """``POST /api/portal/register/`` — step 1 of self-registration.

    Validates the form, kicks off the pending registration, and
    returns the opaque token the FE keeps until the customer types
    their code on step 2. Enumeration-safe: every success path
    (real code sent or suppressed-because-activated) returns the
    same body shape.
    """

    def post(self, request: Request) -> Response:
        serializer = RegistrationStartRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            result = start_self_registration(
                email=serializer.validated_data["email"],
                name=serializer.validated_data.get("name", ""),
                company=serializer.validated_data.get("company", ""),
                password=serializer.validated_data["password"],
                privacy_accepted=serializer.validated_data["privacy_accepted"],
                request_ip=_request_ip(request),
            )
        except PrivacyPolicyNotAccepted as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)
        except RegistrationEmailMissing as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)
        except (NoActiveOrganization, MultipleActiveOrganizations) as exc:
            # Deployment misconfiguration — the customer has no path
            # forward without ops touching the orgs table. Surface as
            # 503 so the FE can render a "we're temporarily unable to
            # accept new signups" message rather than a generic 500.
            logger.error(
                "portal.register.org_misconfigured code=%s", exc.code,
            )
            return _err(exc.code, status.HTTP_503_SERVICE_UNAVAILABLE)
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        except RegistrationError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)

        return Response(
            RegistrationStartResponseSerializer(
                {
                    "token": result.token,
                    "email_masked": result.email_masked,
                }
            ).data,
            status=status.HTTP_200_OK,
        )


class RegistrationConfirmView(PortalPublicAPIView):
    """``POST /api/portal/register/confirm/`` — step 2 of self-registration.

    Verifies the code, promotes the registration into a Customer +
    ClientAccount, stamps the privacy-policy consent fields, and
    returns the standard ``MeSerializer`` payload with portal cookies
    set. Same response shape as the activation + invite endpoints so
    the FE can route post-auth uniformly.
    """

    def post(self, request: Request) -> Response:
        serializer = RegistrationConfirmRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            result = finalize_self_registration(
                token=serializer.validated_data["token"],
                code=serializer.validated_data["code"],
                password=serializer.validated_data["password"],
            )
        except InvalidRegistrationToken as exc:
            return _err(exc.code, status.HTTP_404_NOT_FOUND)
        except RegistrationExpired as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)
        except RegistrationAlreadyUsed as exc:
            return _err(exc.code, status.HTTP_409_CONFLICT)
        except InvalidRegistrationCode as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        except RegistrationError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)

        account = result.account
        access, refresh = tokens_for_client(account)
        response = Response(_me_payload(account))
        set_portal_auth_cookies(response, access, refresh)

        # Append a SIGNED_IN event too — finalize is effectively a
        # login (cookies are set, the customer lands on /portal next).
        # The staff activity panel groups SIGNED_IN by client_account,
        # so emitting it here keeps the "first sign-in" hint accurate
        # for self-registered customers as well as kiosk arrivals.
        record_portal_event(
            organization=account.customer.organization,
            client_account=account,
            kind=PortalEvent.Kind.SIGNED_IN,
            request=request,
        )

        return response
