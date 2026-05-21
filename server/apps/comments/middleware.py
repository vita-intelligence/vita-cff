"""ASGI middleware for the comments WebSocket layer.

Two responsibilities:

1. **Cookie auth** — the browser may carry up to two JWT cookies:

   * ``AUTH_COOKIE_ACCESS_NAME`` (``vita_access``) → staff identity,
     resolved against ``settings.AUTH_USER_MODEL``. Lands at
     ``scope["user"]``.
   * ``PORTAL_AUTH_COOKIE_ACCESS_NAME`` (``vita_portal_access``) →
     customer identity, resolved against
     :class:`apps.client_portal.models.ClientAccount`. Lands at
     ``scope["client_account"]``.

   Both can be present simultaneously when a user is signed into both
   the staff app and the customer portal in the same browser; the
   consumer is responsible for picking the right slot for its route
   (staff routes gate on ``scope["user"]``, portal routes on
   ``scope["client_account"]``). The two JWTs sign against the same
   simplejwt secret but their ``user_id`` claim resolves to disjoint
   tables, so a staff token cannot be smuggled into a portal route.

2. **Channels-safe user resolution** — Django ORM calls must happen
   inside ``database_sync_to_async`` when the consumer is running in
   the async context. The middleware does the JWT verify synchronously
   (no DB) and defers the actual :class:`User` / :class:`ClientAccount`
   fetch to a sync task.
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


@database_sync_to_async
def _load_client_account_from_token(raw_token: str):
    """Resolve a ``vita_portal_access`` JWT to a
    :class:`ClientAccount` row, or ``None`` if anything fails.

    Mirrors :class:`apps.client_portal.auth.PortalCookieJWTAuthentication`:
    the token's ``user_id`` claim looks up directly against the
    ``client_portal_clientaccount`` table — never the staff users
    table — so a staff JWT smuggled into the portal cookie would
    resolve to "row not found" and short-circuit at ``DoesNotExist``.
    Verification is silent (``None`` on every failure mode) because
    the WS layer cannot surface DRF-style 401 codes from a
    middleware — the consumer is the layer that closes with the
    explicit ``4401`` instead.
    """

    from rest_framework_simplejwt.authentication import JWTAuthentication
    from rest_framework_simplejwt.exceptions import (
        InvalidToken,
        TokenError,
    )
    from rest_framework_simplejwt.settings import api_settings as jwt_settings

    from apps.client_portal.models import ClientAccount

    backend = JWTAuthentication()
    try:
        validated = backend.get_validated_token(raw_token)
    except (TokenError, InvalidToken):
        return None

    account_id = validated.get(jwt_settings.USER_ID_CLAIM)
    if not account_id:
        return None
    try:
        account = ClientAccount.objects.get(pk=account_id)
    except ClientAccount.DoesNotExist:
        return None
    if not getattr(account, "is_active", True):
        return None
    return account


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

        # Portal identity: a separate JWT cookie set by the customer
        # portal's auth flow. Resolves to a :class:`ClientAccount`
        # (not a staff user). Routes consuming the portal cookie gate
        # on ``scope["client_account"]``; staff routes stay on
        # ``scope["user"]``. The two slots are independent — a stale
        # / missing portal cookie does not affect the staff side and
        # vice versa.
        portal_cookie_name = getattr(
            settings, "PORTAL_AUTH_COOKIE_ACCESS_NAME", None
        )
        portal_raw_token = (
            cookies.get(portal_cookie_name) if portal_cookie_name else None
        )
        client_account = None
        if portal_raw_token:
            client_account = await _load_client_account_from_token(
                portal_raw_token
            )

        scope = dict(scope)
        scope["user"] = user or AnonymousUser()
        scope["client_account"] = client_account
        scope["cookies"] = cookies
        return await self.inner(scope, receive, send)
