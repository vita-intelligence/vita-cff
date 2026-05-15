"""DRF throttles for the password-reset flow.

Two-layer rate limit:

* **Email-keyed** (3/hour) stops an attacker from email-bombing one
  customer's inbox even if they cycle through residential IPs.
* **IP-keyed** (10/hour) stops one host from enumerating a list of
  emails or brute-forcing reset URLs without first triggering the
  cookie / session machinery.

Both subclasses extend :class:`SimpleRateThrottle` so they share
DRF's standard cache-based sliding window. The cache backend
defaults to Django's in-memory store when ``CACHES`` is
unconfigured, which is fine for a single-worker Daphne deployment;
swapping to Redis later requires only a settings change.
"""

from __future__ import annotations

from typing import Any

from rest_framework.throttling import SimpleRateThrottle


def _client_ip(request: Any) -> str:
    """Resolve the originating client IP, preferring the first hop
    in ``X-Forwarded-For`` when the request came through a trusted
    proxy. Falls back to ``REMOTE_ADDR`` when no XFF header is set.

    The Azure App Service ingress always sets ``X-Forwarded-For``, so
    in production the ``REMOTE_ADDR`` we see is the front-end IP, not
    the customer's. Reading XFF first keeps the throttle keyed on the
    real client.
    """

    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "") or "unknown"


class ForgotPasswordEmailThrottle(SimpleRateThrottle):
    """Cap per-email reset requests at 3/hour.

    The cache key is built from the *posted* email field, which
    means even an unknown email contributes to a bucket — that is
    intentional. An attacker probing a list of addresses must not
    be able to skip the limit by virtue of submitting addresses
    that are not registered.
    """

    scope = "forgot_password_email"
    rate = "3/hour"

    def get_cache_key(self, request: Any, view: Any) -> str | None:
        raw = ""
        if isinstance(request.data, dict):
            raw = request.data.get("email", "") or ""
        normalised = str(raw).strip().lower()
        if not normalised:
            # No email supplied — skip the throttle and let the
            # serializer return its own 400. Counting empty
            # submissions would let an attacker exhaust the bucket
            # without ever attempting a real reset.
            return None
        return self.cache_format % {
            "scope": self.scope,
            "ident": normalised,
        }


class ForgotPasswordIPThrottle(SimpleRateThrottle):
    """Cap per-IP reset requests at 10/hour."""

    scope = "forgot_password_ip"
    rate = "10/hour"

    def get_cache_key(self, request: Any, view: Any) -> str | None:
        ident = _client_ip(request)
        if not ident:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}


class ResetPasswordConfirmIPThrottle(SimpleRateThrottle):
    """Cap per-IP confirm attempts at 20/hour.

    Even though the token has ~256 bits of entropy and the hashed
    storage means an exposed DB can't be replayed, a throttle on
    confirm requests protects against credential-stuffing-style
    behaviour where an attacker probes a stolen list of plaintext
    URLs (e.g. mailbox compromise harvested over time).
    """

    scope = "reset_password_confirm_ip"
    rate = "20/hour"

    def get_cache_key(self, request: Any, view: Any) -> str | None:
        ident = _client_ip(request)
        if not ident:
            return None
        return self.cache_format % {"scope": self.scope, "ident": ident}
