"""DRF exception handler that emits machine-readable error codes.

Every validation error in the API is normalised so the response body uses
short ``snake_case`` codes instead of localised English strings. The
frontend owns translation — a single mapping per locale resolves codes to
user-facing sentences.

The handler walks the structure DRF builds (nested dicts, lists) and
replaces each :class:`rest_framework.exceptions.ErrorDetail` with its
``.code`` attribute, falling back to the original string only when no
code was set.

Beyond DRF's own exception types, the handler also rescues *uncaught
domain exceptions* — Python exceptions raised inside a service that
the view forgot to map. Today's afternoon outage was exactly that
shape: ``FinalSpecAlreadyExists`` was raised inside an
``@transaction.atomic`` service function but no ``except`` in the view
caught it, so it bubbled as a 500. The user retried eight times,
each retry holding a pool connection through rollback, and the
cascade started. We do NOT want the next missed catch to repeat
that pattern, so any exception whose class carries a ``code`` (or
``api_code``) attribute is treated as a codified domain error and
surfaced as a structured 4xx instead of a 500. Each rescue is
logged at ``WARNING`` with the exception type so the gap is still
visible in observability — we never silently swallow.
"""

from __future__ import annotations

import logging
from typing import Any

from rest_framework import status as drf_status
from rest_framework.exceptions import ErrorDetail
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


logger = logging.getLogger(__name__)


def _codify(value: Any) -> Any:
    if isinstance(value, ErrorDetail):
        return str(value.code) if value.code else str(value)
    if isinstance(value, list):
        return [_codify(item) for item in value]
    if isinstance(value, dict):
        return {key: _codify(inner) for key, inner in value.items()}
    return value


def _resolve_domain_code(exc: Exception) -> str | None:
    """Extract a machine-readable code from an exception, if any.

    Looks at instance attributes first (so a callsite can override
    via ``raise X(code="…")``), then class attributes. ``api_code``
    is the canonical name used in the frontend ``ApiError.code``
    path; ``code`` is the historical name on many ``services.py``
    exception classes. Both are accepted so we don't have to
    rename 100+ existing classes to wire this rescue.
    """
    for attr in ("api_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, str) and value:
            return value
    return None


def _resolve_domain_status(exc: Exception) -> int:
    """Pick the HTTP status for a rescued domain exception.

    Honours ``api_status_code`` / ``status_code`` on the exception
    when present; defaults to ``409 Conflict`` because the
    overwhelming majority of our domain exceptions describe a
    rule-level conflict ("already exists", "not mutable in this
    state", "locked", "slot taken"). A view that wants a different
    status (400 for invalid input, 404 for not-found) should still
    catch the exception explicitly — the rescue is only a safety
    net for cases the view forgot.
    """
    for attr in ("api_status_code", "status_code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int) and 400 <= value < 600:
            return value
    return drf_status.HTTP_409_CONFLICT


def codified_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    response = drf_exception_handler(exc, context)
    if response is not None:
        response.data = _codify(response.data)

        # Exceptions can advertise a dedicated machine-readable code via
        # ``api_code``. Surfacing it at the top level lets the frontend
        # ``ApiError.code`` path branch cleanly without having to parse
        # the ``detail`` string or inspect nested ``fieldErrors``.
        api_code = getattr(exc, "api_code", None)
        if api_code and isinstance(response.data, dict):
            response.data.setdefault("code", api_code)
        return response

    # DRF did not recognise the exception. Before letting it fall
    # through to Django's 500 handler, check whether it advertises a
    # machine-readable ``code`` — that's our convention for "this is
    # a domain rule violation, not a server bug". If so, return a
    # structured 4xx so the frontend can render proper copy and the
    # user doesn't hammer a failing endpoint into a cascade.
    domain_code = _resolve_domain_code(exc)
    if domain_code is None:
        return None

    domain_status = _resolve_domain_status(exc)

    # WARNING (not ERROR) because we are RECOVERING from the
    # situation by returning 4xx — but it's still a code smell that
    # the view didn't catch it explicitly. The log entry tells us
    # where the gap is so we can add the per-view ``except`` later.
    view = context.get("view")
    request = context.get("request")
    logger.warning(
        "domain exception rescued by global handler: %s code=%s status=%d view=%s path=%s",
        type(exc).__name__,
        domain_code,
        domain_status,
        type(view).__name__ if view is not None else "unknown",
        getattr(request, "path", "unknown") if request is not None else "unknown",
        exc_info=exc,
    )
    return Response({"code": domain_code}, status=domain_status)
