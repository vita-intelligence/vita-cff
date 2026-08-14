"""Cookie helpers for the client portal.

Two functions, ``set_portal_auth_cookies`` and
``clear_portal_auth_cookies``, mirror the staff helpers in
:mod:`apps.accounts.auth.cookies` but write to the portal cookie
names. Token issuance builds a ``RefreshToken`` directly with the
account's UUID under the ``user_id`` claim — we deliberately DO
NOT call ``RefreshToken.for_user(account)`` because when the
``token_blacklist`` app is installed, ``for_user`` invokes
``OutstandingToken.objects.create(user=account, ...)``. That table's
``user`` column is a FK to ``AUTH_USER_MODEL`` (the staff
:class:`~apps.accounts.models.User` table); a :class:`ClientAccount`
instance whose PK doesn't exist in the staff user table trips the
FK constraint and the login 500s (see the "Sign-in failed. Check
your details" incident post-``token_blacklist`` rollout). The
manual construction keeps portal tokens completely outside the
blacklist infrastructure — they're a separate identity space.
"""

from __future__ import annotations

from django.conf import settings
from rest_framework.response import Response
from rest_framework_simplejwt.settings import api_settings as jwt_settings
from rest_framework_simplejwt.tokens import RefreshToken


def _access_max_age() -> int:
    return int(settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds())


def _refresh_max_age() -> int:
    return int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds())


def set_portal_auth_cookies(
    response: Response,
    access_token: str,
    refresh_token: str | None = None,
) -> Response:
    response.set_cookie(
        key=settings.PORTAL_AUTH_COOKIE_ACCESS_NAME,
        value=access_token,
        max_age=_access_max_age(),
        domain=settings.AUTH_COOKIE_DOMAIN,
        path=settings.AUTH_COOKIE_PATH,
        secure=settings.AUTH_COOKIE_SECURE,
        httponly=settings.AUTH_COOKIE_HTTPONLY,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    if refresh_token is not None:
        response.set_cookie(
            key=settings.PORTAL_AUTH_COOKIE_REFRESH_NAME,
            value=refresh_token,
            max_age=_refresh_max_age(),
            domain=settings.AUTH_COOKIE_DOMAIN,
            path=settings.AUTH_COOKIE_PATH,
            secure=settings.AUTH_COOKIE_SECURE,
            httponly=settings.AUTH_COOKIE_HTTPONLY,
            samesite=settings.AUTH_COOKIE_SAMESITE,
        )
    return response


def clear_portal_auth_cookies(response: Response) -> Response:
    response.delete_cookie(
        key=settings.PORTAL_AUTH_COOKIE_ACCESS_NAME,
        path=settings.AUTH_COOKIE_PATH,
        domain=settings.AUTH_COOKIE_DOMAIN,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    response.delete_cookie(
        key=settings.PORTAL_AUTH_COOKIE_REFRESH_NAME,
        path=settings.AUTH_COOKIE_PATH,
        domain=settings.AUTH_COOKIE_DOMAIN,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    return response


def issue_portal_refresh_token(account) -> RefreshToken:
    """Build a fresh :class:`RefreshToken` carrying ``account.pk``
    in the ``user_id`` claim, WITHOUT triggering the
    ``token_blacklist`` app's ``OutstandingToken.objects.create``
    hook that ``RefreshToken.for_user`` would otherwise fire.

    See the module docstring for the FK-mismatch reasoning. Callers
    that need the string form use :func:`tokens_for_client`; callers
    that need the token instance (e.g. the portal ``RefreshView``
    that also reads ``.access_token``) use this one directly.
    """

    refresh = RefreshToken()
    refresh[jwt_settings.USER_ID_CLAIM] = getattr(
        account, jwt_settings.USER_ID_FIELD
    )
    return refresh


def tokens_for_client(account) -> tuple[str, str]:
    """Issue a fresh access / refresh pair string for ``account``.

    Delegates to :func:`issue_portal_refresh_token` so the OutstandingToken
    FK trap stays bypassed.
    """

    refresh = issue_portal_refresh_token(account)
    return str(refresh.access_token), str(refresh)
