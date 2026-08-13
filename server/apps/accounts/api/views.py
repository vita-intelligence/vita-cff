"""Views for the accounts API."""

from __future__ import annotations

import logging

from django.conf import settings
from django.core.cache import cache
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

logger = logging.getLogger(__name__)


def _client_ip(request: Request) -> str:
    """Extract the reverse-proxied client IP for observability
    logging. Falls back to REMOTE_ADDR when no proxy header is set."""
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",", 1)[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")

from apps.accounts.api.serializers import (
    LoginSerializer,
    PasswordResetConfirmSerializer,
    PasswordResetRequestSerializer,
    RegisterSerializer,
    UpdateMeSerializer,
    UserReadSerializer,
)
from apps.accounts.api.throttles import (
    ForgotPasswordEmailThrottle,
    ForgotPasswordIPThrottle,
    ResetPasswordConfirmIPThrottle,
)
from apps.accounts.auth.cookies import (
    clear_auth_cookies,
    set_auth_cookies,
    tokens_for_user,
)
from apps.accounts.email import PasswordResetEmailFailed
from apps.accounts.tasks import send_password_reset_email_task
from apps.accounts.services import (
    PasswordResetPasswordInvalid,
    PasswordResetTokenExpired,
    PasswordResetTokenInvalid,
    PasswordResetTokenInvalidated,
    PasswordResetTokenUsed,
    consume_password_reset_token,
    request_password_reset,
    validate_password_reset_token,
)


class RegisterView(APIView):
    """POST ``/api/auth/register/`` — create a new user account.

    Gated by :setting:`STAFF_REGISTRATION_ENABLED`. When the flag is
    off (the default), the endpoint short-circuits with HTTP 403 and
    new staff onboarding must go through the invitation flow
    (``/api/invitations/<token>/accept/``). The portal-side activation
    endpoints under ``apps.client_portal`` are unaffected by this gate.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        if not getattr(settings, "STAFF_REGISTRATION_ENABLED", False):
            return Response(
                {"detail": "registration_disabled"},
                status=status.HTTP_403_FORBIDDEN,
            )
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        output = UserReadSerializer(user).data
        return Response(output, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    """POST ``/api/auth/login/`` — exchange credentials for httpOnly cookies."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        serializer = LoginSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        access, refresh = tokens_for_user(user)
        response = Response(UserReadSerializer(user).data, status=status.HTTP_200_OK)
        set_auth_cookies(response, access_token=access, refresh_token=refresh)
        return response


class LogoutView(APIView):
    """POST ``/api/auth/logout/`` — clear auth cookies AND blacklist
    the current refresh token upstream.

    Historically this endpoint only cleared cookies — a stolen refresh
    token could keep working until natural expiry (7 days). With
    ``BLACKLIST_AFTER_ROTATION=True`` + the ``token_blacklist`` app
    installed, we can call ``token.blacklist()`` to persist the token
    in the blacklist table so any future refresh with it is refused.
    Called by the website proxy on any refresh-401 as well as by the
    normal user-initiated logout flow.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request) -> Response:
        raw_refresh = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH_NAME)
        if raw_refresh:
            try:
                RefreshToken(raw_refresh).blacklist()
            except TokenError:
                # Already blacklisted or malformed — still fine to
                # clear cookies. No point 500'ing the client for a
                # token that's already dead.
                logger.info(
                    "logout.blacklist_skipped user_id=%s ip=%s",
                    getattr(request.user, "id", None),
                    _client_ip(request),
                )
            except Exception:  # pragma: no cover — defensive
                logger.exception(
                    "logout.blacklist_error user_id=%s ip=%s",
                    getattr(request.user, "id", None),
                    _client_ip(request),
                )

        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_auth_cookies(response)
        return response


class RefreshView(APIView):
    """POST ``/api/auth/refresh/`` — rotate the access (and refresh) cookie.

    Emits structured logs on every failure path so the operations team
    can diagnose the "user gets bounced back to login every 15 min"
    report without a live DevTools session. Each log carries enough
    context (user_id when derivable, IP, failure reason, presence of
    the raw refresh cookie) to correlate against upstream traffic.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        raw_refresh = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH_NAME)
        ip = _client_ip(request)

        if not raw_refresh:
            logger.info(
                "refresh.missing_cookie ip=%s ua=%r",
                ip,
                request.META.get("HTTP_USER_AGENT", "")[:120],
            )
            return Response(
                {"detail": ["refresh_token_missing"]},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        try:
            refresh = RefreshToken(raw_refresh)
        except TokenError as exc:
            logger.info(
                "refresh.token_invalid ip=%s reason=%s",
                ip,
                str(exc).replace("\n", " ")[:200],
            )
            return Response(
                {"detail": ["refresh_token_invalid"]},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        data = {"access": str(refresh.access_token)}
        new_refresh: str | None = None
        if settings.SIMPLE_JWT.get("ROTATE_REFRESH_TOKENS"):
            # Issue a brand-new refresh so the client never reuses a stale one.
            # With ``BLACKLIST_AFTER_ROTATION=True``, SimpleJWT
            # automatically blacklists the old refresh at
            # ``refresh.blacklist()`` time — done inside ``str(refresh)``'s
            # rotate path via the OutstandingToken hook. Nothing extra
            # to do here beyond re-signing.
            refresh.set_jti()
            refresh.set_exp()
            refresh.set_iat()
            new_refresh = str(refresh)

        response = Response(data, status=status.HTTP_200_OK)
        set_auth_cookies(
            response,
            access_token=data["access"],
            refresh_token=new_refresh,
        )
        return response


class BootstrapView(APIView):
    """GET ``/api/auth/bootstrap/`` — single round-trip seed for SSR.

    Every authenticated Next.js page renders behind a guard that
    needs *both* the current user and the user's organizations.
    Before this endpoint existed, SSR fired two sequential backend
    requests per navigation — ``/api/auth/me/`` then
    ``/api/organizations/`` — each one queueing behind whatever the
    request worker was already doing. Bootstrapping both in one
    response halves the SSR round-trip cost.

    The response shape is deliberately a *strict superset* of the
    two endpoints it replaces: a consumer that only cares about the
    user can read ``payload["user"]``, and a consumer that only
    cares about orgs can read ``payload["organizations"]``. That
    keeps the frontend free to migrate page-by-page without an
    all-or-nothing rewrite.

    Wholesale replacement of the two underlying endpoints is *not*
    in scope — both stay live for clients (e.g. the TanStack
    refetch of /me/ after a profile edit) that explicitly need a
    fresh slice without paying for the other half.
    """

    permission_classes = (IsAuthenticated,)

    #: Bootstrap is hit on every authed page navigation by the SSR
    #: shell, so a single power user with a few tabs open can fire
    #: 10+ requests/minute against it. The payload (user + orgs +
    #: caller capabilities) is identical between calls for the same
    #: user, and the serialization itself — not the prefetch — is
    #: where the CPU+pool time goes. A short per-user cache absorbs
    #: the storm while still picking up membership/role changes
    #: within one minute. The trade-off is explicit: a permission
    #: change can take up to ``_BOOTSTRAP_CACHE_TTL`` seconds to
    #: take effect on the client.
    _BOOTSTRAP_CACHE_TTL = 60

    def get(self, request: Request) -> Response:
        # Lazy imports to keep this view's load path independent of
        # the organizations app — accounts is the most-imported app
        # in the codebase and we don't want a circular dependency.
        from apps.organizations.api.serializers import (
            OrganizationReadSerializer,
        )
        from apps.organizations.models import Membership
        from apps.organizations.services import list_user_organizations

        # The User model has no ``updated_at`` column, so the cache
        # key folds in a stable hash of every user field the
        # response actually surfaces. Editing name / email /
        # avatar / active flag changes the hash and auto-busts the
        # entry on the very next request — no manual cache.delete
        # call required at the PATCH /me/ site. Membership and
        # role changes don't touch User, so they ride the TTL out
        # (explicit user trade-off: 60s eventual consistency on
        # permission changes).
        import hashlib

        user = request.user
        identity_hash = hashlib.blake2s(
            "|".join(
                (
                    str(user.email or ""),
                    str(user.first_name or ""),
                    str(user.last_name or ""),
                    str(user.avatar_image or ""),
                    "1" if getattr(user, "is_active", True) else "0",
                )
            ).encode("utf-8"),
            digest_size=8,
        ).hexdigest()
        cache_key = f"bootstrap:v1:user:{user.pk}:{identity_hash}"
        cached = cache.get(cache_key)
        if cached is not None:
            response = Response(cached, status=status.HTTP_200_OK)
            response["X-Cache"] = "HIT"
            return response

        organizations = list_user_organizations(user)
        # Same prefetch as ``OrganizationListCreateView.get`` — load
        # every caller membership in one query so the serializer's
        # ``is_owner`` / ``permissions`` SerializerMethodFields don't
        # fan out into 2×N round-trips.
        org_ids = [org.id for org in organizations]
        caller_memberships = {
            str(m.organization_id): m
            for m in Membership.objects.filter(
                user=user, organization_id__in=org_ids
            )
        }
        payload = {
            "user": UserReadSerializer(user).data,
            "organizations": OrganizationReadSerializer(
                organizations,
                many=True,
                context={
                    "request": request,
                    "caller_memberships_by_org_id": caller_memberships,
                },
            ).data,
        }
        cache.set(cache_key, payload, timeout=self._BOOTSTRAP_CACHE_TTL)
        response = Response(payload, status=status.HTTP_200_OK)
        response["X-Cache"] = "MISS"
        return response


class MeView(APIView):
    """GET / PATCH ``/api/auth/me/``.

    * ``GET`` returns the authenticated user's profile.
    * ``PATCH`` updates first/last name. Email is deliberately
      immutable here — changing it needs its own re-verification flow.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        return Response(UserReadSerializer(request.user).data)

    def patch(self, request: Request) -> Response:
        serializer = UpdateMeSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = request.user
        update_fields: list[str] = []
        for field in ("first_name", "last_name"):
            if field in serializer.validated_data:
                setattr(user, field, serializer.validated_data[field])
                update_fields.append(field)
        if update_fields:
            user.save(update_fields=update_fields)
        return Response(UserReadSerializer(user).data)


def _client_ip_for_audit(request: Request) -> str:
    """Best-effort client IP extraction for audit columns.

    Azure App Service appends the source port to the XFF value
    (``92.18.60.6:57508``); we delegate to the portal-side helper
    which strips the port and validates the result so audit fields
    never accumulate malformed ``ip:port`` strings.
    """

    from apps.client_portal.services import _extract_client_ip
    return _extract_client_ip(request) or ""


# Token-state exceptions all map cleanly to a single "what went
# wrong" code. Keeping the mapping in one dict (instead of a chain
# of ``isinstance`` branches in the view) means the frontend i18n
# layer has a stable contract: each value here corresponds to one
# translation key.
_TOKEN_ERROR_CODES = {
    PasswordResetTokenInvalid: "password_reset_token_invalid",
    PasswordResetTokenExpired: "password_reset_token_expired",
    PasswordResetTokenUsed: "password_reset_token_used",
    PasswordResetTokenInvalidated: "password_reset_token_invalidated",
}


class PasswordResetRequestView(APIView):
    """POST ``/api/auth/password-reset/request/``.

    Always returns 200 on a well-formed request, regardless of
    whether the email matched a user. The only thing that varies
    is whether a mail goes out — this is the enumeration-safety
    contract documented on :func:`request_password_reset`.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()
    throttle_classes = (ForgotPasswordEmailThrottle, ForgotPasswordIPThrottle)

    def post(self, request: Request) -> Response:
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        issued = request_password_reset(
            email=email,
            requested_ip=_client_ip_for_audit(request),
        )
        if issued is not None:
            # Dispatched via Celery so a slow / hung SMTP relay does
            # not pin the request worker. No ``transaction.on_commit``
            # wrap is needed here: ``request_password_reset`` is
            # itself ``@transaction.atomic`` and has already
            # returned (and committed) by this point, so a real
            # broker worker is guaranteed to find the token row.
            # In eager mode (no broker configured) the task body
            # runs synchronously in this very call.
            try:
                send_password_reset_email_task.delay(
                    str(issued.record.user.id),
                    issued.plaintext,
                )
            except PasswordResetEmailFailed:
                # Eager-mode SMTP failure: the task body raises and
                # the eager-propagates setting bubbles it back to us
                # as the original domain exception. Swallow so an
                # outage doesn't differentiate registered emails
                # from unknown ones in the API response — the service
                # module already logged with full context.
                pass

        return Response(
            {"status": "ok"},
            status=status.HTTP_200_OK,
        )


class PasswordResetValidateView(APIView):
    """GET ``/api/auth/password-reset/validate/?token=<plaintext>``.

    Lets the frontend show "this link expired" *before* the user
    has typed a new password. Returns the same codified errors as
    confirm so the frontend can render one set of translations.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> Response:
        token = request.query_params.get("token", "")
        try:
            validate_password_reset_token(token=token)
        except tuple(_TOKEN_ERROR_CODES.keys()) as exc:
            return Response(
                {"code": _TOKEN_ERROR_CODES[type(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class PasswordResetConfirmView(APIView):
    """POST ``/api/auth/password-reset/confirm/``.

    Validates the token + password and rotates the user's password
    if everything checks out. Successful reset does *not* mint new
    auth cookies — the user must log in fresh so they confirm they
    know the password they just chose.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()
    throttle_classes = (ResetPasswordConfirmIPThrottle,)

    def post(self, request: Request) -> Response:
        serializer = PasswordResetConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            consume_password_reset_token(
                token=serializer.validated_data["token"],
                new_password=serializer.validated_data["password"],
            )
        except PasswordResetPasswordInvalid as exc:
            return Response(
                {"password": exc.codes},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except tuple(_TOKEN_ERROR_CODES.keys()) as exc:
            return Response(
                {"code": _TOKEN_ERROR_CODES[type(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class MeAvatarView(APIView):
    """``POST`` / ``DELETE`` ``/api/auth/me/avatar/``.

    Dedicated endpoint for profile-photo uploads so the main
    ``PATCH /me/`` handler does not have to grow a ``signature_image``
    style branch. ``POST`` accepts a base64 data URL (PNG or JPEG,
    ≤500 KB); ``DELETE`` clears the stored image so the user falls
    back to the initials avatar.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request) -> Response:
        from config.avatars import AvatarImageInvalid, validate_avatar_image

        raw = request.data.get("avatar_image")
        try:
            normalised = validate_avatar_image(raw)
        except AvatarImageInvalid:
            return Response(
                {"avatar_image": ["invalid_avatar_image"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user = request.user
        user.avatar_image = normalised
        user.save(update_fields=["avatar_image"])
        return Response(UserReadSerializer(user).data)

    def delete(self, request: Request) -> Response:
        user = request.user
        if user.avatar_image:
            user.avatar_image = ""
            user.save(update_fields=["avatar_image"])
        return Response(UserReadSerializer(user).data)
