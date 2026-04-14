"""Helpers for reading and writing httpOnly auth cookies."""

from __future__ import annotations

from django.conf import settings
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken


def _access_max_age() -> int:
    return int(settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"].total_seconds())


def _refresh_max_age() -> int:
    return int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds())


def set_auth_cookies(
    response: Response,
    access_token: str,
    refresh_token: str | None = None,
) -> Response:
    """Stamp ``response`` with the access (and optionally refresh) cookie.

    Both cookies are httpOnly so browser JavaScript cannot read them. The
    secure and samesite flags come from settings so production deploys flip
    automatically.
    """

    response.set_cookie(
        key=settings.AUTH_COOKIE_ACCESS_NAME,
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
            key=settings.AUTH_COOKIE_REFRESH_NAME,
            value=refresh_token,
            max_age=_refresh_max_age(),
            domain=settings.AUTH_COOKIE_DOMAIN,
            path=settings.AUTH_COOKIE_PATH,
            secure=settings.AUTH_COOKIE_SECURE,
            httponly=settings.AUTH_COOKIE_HTTPONLY,
            samesite=settings.AUTH_COOKIE_SAMESITE,
        )
    return response


def clear_auth_cookies(response: Response) -> Response:
    """Delete both auth cookies from the client."""

    response.delete_cookie(
        key=settings.AUTH_COOKIE_ACCESS_NAME,
        path=settings.AUTH_COOKIE_PATH,
        domain=settings.AUTH_COOKIE_DOMAIN,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    response.delete_cookie(
        key=settings.AUTH_COOKIE_REFRESH_NAME,
        path=settings.AUTH_COOKIE_PATH,
        domain=settings.AUTH_COOKIE_DOMAIN,
        samesite=settings.AUTH_COOKIE_SAMESITE,
    )
    return response


def tokens_for_user(user) -> tuple[str, str]:
    """Issue a fresh access/refresh pair for ``user``."""

    refresh = RefreshToken.for_user(user)
    return str(refresh.access_token), str(refresh)
