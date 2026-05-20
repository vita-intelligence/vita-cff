"""Cookie helpers for the client portal.

Two functions, ``set_portal_auth_cookies`` and
``clear_portal_auth_cookies``, mirror the staff helpers in
:mod:`apps.accounts.auth.cookies` but write to the portal cookie
names. Token issuance reuses ``RefreshToken.for_user`` against the
:class:`ClientAccount` model — the JWT payload carries the account's
UUID under the same ``user_id`` claim simplejwt uses everywhere,
which our :class:`PortalCookieJWTAuthentication` then resolves back
against the client table.
"""

from __future__ import annotations

from django.conf import settings
from rest_framework.response import Response
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


def tokens_for_client(account) -> tuple[str, str]:
    """Issue a fresh access / refresh pair for ``account``.

    Calls ``RefreshToken.for_user`` against a non-``AUTH_USER_MODEL``
    instance, which simplejwt supports — it reads ``pk`` for the
    ``user_id`` claim regardless of which table the row lives in.
    """

    refresh = RefreshToken.for_user(account)
    return str(refresh.access_token), str(refresh)
