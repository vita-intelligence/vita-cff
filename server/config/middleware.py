"""Cross-cutting Django middleware for the NPD server.

Currently hosts :class:`MisclickGuardMiddleware` — the short-window
request-idempotency guard that catches accidental double-clicks +
network re-fires without touching individual views.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Callable, Iterable

from django.core.cache import cache
from django.http import HttpRequest, HttpResponse

logger = logging.getLogger(__name__)


# 10 seconds. Same reasoning as ``Backend.MisclickGuard`` on the PSP
# side: long enough for network re-fires (browser retry, mobile radio
# wake, aggressive fetch abort/retry) and human double-click cadence
# (100-500 ms between clicks), short enough to never catch a legit
# "yeah I meant to run it a second time" (users wait for feedback
# before re-clicking on purpose).
DEFAULT_TTL_SECONDS = 10

# Methods that mutate state. Everything else passes through untouched.
GUARDED_METHODS = frozenset({"POST", "PUT", "PATCH"})

# Response headers we replay verbatim from the cached response.
# Deliberately narrow — ``Content-Type`` + ``Location`` are the only
# ones that describe the response body itself. We DON'T replay
# ``Set-Cookie`` (would rotate the user's session twice), CSRF
# tokens (bound to the current request), or rate-limit headers.
REPLAYABLE_HEADERS = frozenset({"content-type", "location"})

# Cache-key prefix so entries can be inspected + purged as a group.
CACHE_KEY_PREFIX = "misclick"


class MisclickGuardMiddleware:
    """Catches double-clicks / accidental re-fires on write endpoints.

    Mirrors :module:`Backend.Plugs.MisclickGuard` on PSP so behaviour
    is uniform across both services — a request that would be a
    duplicate on PSP is also a duplicate on NPD, and vice versa.

    ### Fingerprint

    ``sha256(actor_id | method | path | raw_body)``, hex-encoded.
    Two requests hash identically iff every one of those matches.
    That IS the definition of a misclick: the same user hitting the
    same button with the same payload twice in a row.

    ### Cached responses

    Only 2xx and 4xx are cached. 5xx passes through so an operator
    retrying after a server hiccup gets a real second attempt
    instead of being stuck with a cached error for 10 s.

    ### What's skipped

    * Non-mutating methods (GET / HEAD / OPTIONS / DELETE — DELETE is
      idempotent at the HTTP layer).
    * Multipart uploads — hashing megabytes of body per request is
      wasteful and file uploads have their own natural dedup.
    * Health / bootstrap endpoints (``/api/health/`` + WhiteNoise
      static asset serving) — not worth the cache round-trip.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        if not self._should_guard(request):
            return self.get_response(request)

        fingerprint = self._fingerprint(request)
        cache_key = f"{CACHE_KEY_PREFIX}:{fingerprint}"

        cached = cache.get(cache_key)
        if cached is not None:
            return self._replay(cached)

        response = self.get_response(request)
        self._maybe_cache(cache_key, response)
        return response

    # ── skip rules ───────────────────────────────────────────────

    def _should_guard(self, request: HttpRequest) -> bool:
        if request.method not in GUARDED_METHODS:
            return False

        content_type = (request.META.get("CONTENT_TYPE") or "").lower()
        if content_type.startswith("multipart/"):
            return False

        # Bail early on paths that aren't worth the cache round-trip.
        # Static + health checks are the two obvious noise sources.
        path = request.path
        if path.startswith("/static/") or path.startswith("/media/"):
            return False
        if path in {"/api/health/", "/health/", "/healthz"}:
            return False

        return True

    # ── fingerprint ──────────────────────────────────────────────

    def _fingerprint(self, request: HttpRequest) -> str:
        actor = self._actor_identifier(request)
        body = self._raw_body(request)

        hasher = hashlib.sha256()
        hasher.update(actor.encode("utf-8"))
        hasher.update(b"|")
        hasher.update(request.method.encode("ascii"))
        hasher.update(b"|")
        hasher.update(request.get_full_path().encode("utf-8"))
        hasher.update(b"|")
        hasher.update(body)
        return hasher.hexdigest()

    def _actor_identifier(self, request: HttpRequest) -> str:
        # Prefer the authenticated user id, then any portal client
        # account id set by the portal auth backend, else the client IP.
        # All namespaced so a user id can never collide with a portal
        # account id or an IP.
        user = getattr(request, "user", None)
        if user is not None and getattr(user, "is_authenticated", False):
            return f"u:{user.pk}"

        portal_account = getattr(request, "portal_client_account", None)
        if portal_account is not None:
            return f"p:{portal_account.pk}"

        return f"ip:{self._client_ip(request)}"

    def _client_ip(self, request: HttpRequest) -> str:
        # Prefer the leftmost X-Forwarded-For entry (deploys sit behind
        # Azure Front Door / a reverse proxy), fall back to REMOTE_ADDR.
        xff = request.META.get("HTTP_X_FORWARDED_FOR")
        if xff:
            return xff.split(",", 1)[0].strip()
        return request.META.get("REMOTE_ADDR", "0.0.0.0")

    def _raw_body(self, request: HttpRequest) -> bytes:
        # ``request.body`` reads + caches the raw bytes. Safe to touch
        # here — Django's request-body access rules only forbid a
        # subsequent ``request.POST`` for multipart, which we've
        # already ruled out via the content-type check.
        try:
            return request.body or b""
        except Exception:  # pragma: no cover — defensive
            return b""

    # ── replay ───────────────────────────────────────────────────

    def _replay(self, cached: dict) -> HttpResponse:
        response = HttpResponse(
            content=cached["body"],
            status=cached["status"],
        )
        for name, value in cached.get("headers", {}).items():
            response[name] = value
        response["X-Misclick-Guard"] = "replay"
        return response

    # ── caching ──────────────────────────────────────────────────

    def _maybe_cache(self, cache_key: str, response: HttpResponse) -> None:
        status = response.status_code
        # 2xx = successful writes, 4xx = expected validation errors.
        # Both deserve dedup so a misclicked "submit" doesn't get
        # toasted twice. 5xx passes through so retries after a
        # transient failure can succeed on the second try.
        if not (200 <= status < 300 or 400 <= status < 500):
            response["X-Misclick-Guard"] = "skip"
            return

        # Streaming responses can't be safely snapshotted — reading
        # ``content`` on a StreamingHttpResponse would consume the
        # iterator. Skip those (they're rare on write endpoints:
        # file downloads are always GET).
        if getattr(response, "streaming", False):
            response["X-Misclick-Guard"] = "skip-streaming"
            return

        try:
            body = response.content
        except Exception:
            body = b""

        snapshot_headers = {
            name: value
            for name, value in response.items()
            if name.lower() in REPLAYABLE_HEADERS
        }

        cache.set(
            cache_key,
            {"status": status, "body": body, "headers": snapshot_headers},
            timeout=DEFAULT_TTL_SECONDS,
        )
        response["X-Misclick-Guard"] = "miss"
