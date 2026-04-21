"""ASGI middleware for the comments WebSocket layer.

Two responsibilities:

1. **Cookie auth** — the browser stores the access-token JWT in an
   ``httpOnly`` cookie (``AUTH_COOKIE_ACCESS_NAME``). The REST layer
   reads that same cookie through
   :class:`apps.accounts.auth.authentication.CookieJWTAuthentication`;
   the WebSocket scope has to read it a little differently because
   the cookie header lives under ``scope["headers"]`` as a raw
   bytestring.

2. **Channels-safe user resolution** — Django ORM calls must happen
   inside ``database_sync_to_async`` when the consumer is running in
   the async context. The middleware does the JWT verify synchronously
   (no DB) and defers the actual :class:`User` fetch to a sync task.
"""

from __future__ import annotations

from http import cookies as _cookies
from typing import Any

from channels.db import database_sync_to_async
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser


UserModel = get_user_model()


def _parse_cookie_header(raw_header: bytes | str | None) -> dict[str, str]:
    """Decode the ``cookie:`` header pulled from ``scope["headers"]``.

    ``http.cookies.SimpleCookie`` does the RFC-6265 tokenisation for
    us and tolerates the space-separated ``name=value; name=value``
    shape the browser emits.
    """

    if not raw_header:
        return {}
    if isinstance(raw_header, (bytes, bytearray)):
        raw_header = raw_header.decode("latin-1")
    jar = _cookies.SimpleCookie()
    try:
        jar.load(raw_header)
    except _cookies.CookieError:
        return {}
    return {key: morsel.value for key, morsel in jar.items()}


def _extract_cookie(scope: dict[str, Any], name: str) -> str | None:
    for header_name, header_value in scope.get("headers", []) or []:
        if header_name == b"cookie":
            return _parse_cookie_header(header_value).get(name)
    return None


@database_sync_to_async
def _load_user_from_token(raw_token: str):
    # Import inside the sync wrapper so Django apps are fully loaded
    # before simplejwt pulls ``AUTH_USER_MODEL`` off the registry.
    from rest_framework_simplejwt.authentication import JWTAuthentication
    from rest_framework_simplejwt.exceptions import TokenError, InvalidToken

    backend = JWTAuthentication()
    try:
        validated = backend.get_validated_token(raw_token)
    except (TokenError, InvalidToken):
        return None
    try:
        return backend.get_user(validated)
    except Exception:  # noqa: BLE001
        return None


class CookieJWTAuthMiddleware:
    """ASGI middleware that populates ``scope["user"]`` from a JWT cookie.

    Designed to wrap a :class:`channels.routing.URLRouter` inside
    ``config.asgi.application``. On missing / invalid token we still
    forward the connection with ``scope["user"] = AnonymousUser()`` —
    the consumer is responsible for closing unauthenticated
    connections with an explicit 4401 so the client sees a stable
    reason code.

    Also surfaces the full raw cookie jar at ``scope["cookies"]`` so
    downstream consumers (notably the kiosk consumer) can decode
    their own signed cookies without re-walking
    ``scope["headers"]``.
    """

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"websocket", "http"}:
            return await self.inner(scope, receive, send)

        cookies: dict[str, str] = {}
        for header_name, header_value in scope.get("headers", []) or []:
            if header_name == b"cookie":
                cookies = _parse_cookie_header(header_value)
                break

        cookie_name = getattr(settings, "AUTH_COOKIE_ACCESS_NAME", None)
        raw_token = cookies.get(cookie_name) if cookie_name else None

        user = None
        if raw_token:
            user = await _load_user_from_token(raw_token)

        scope = dict(scope)
        scope["user"] = user or AnonymousUser()
        scope["cookies"] = cookies
        return await self.inner(scope, receive, send)
