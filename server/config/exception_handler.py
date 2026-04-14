"""DRF exception handler that emits machine-readable error codes.

Every validation error in the API is normalised so the response body uses
short ``snake_case`` codes instead of localised English strings. The
frontend owns translation — a single mapping per locale resolves codes to
user-facing sentences.

The handler walks the structure DRF builds (nested dicts, lists) and
replaces each :class:`rest_framework.exceptions.ErrorDetail` with its
``.code`` attribute, falling back to the original string only when no
code was set.
"""

from __future__ import annotations

from typing import Any

from rest_framework.exceptions import ErrorDetail
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


def _codify(value: Any) -> Any:
    if isinstance(value, ErrorDetail):
        return str(value.code) if value.code else str(value)
    if isinstance(value, list):
        return [_codify(item) for item in value]
    if isinstance(value, dict):
        return {key: _codify(inner) for key, inner in value.items()}
    return value


def codified_exception_handler(exc: Exception, context: dict[str, Any]) -> Response | None:
    response = drf_exception_handler(exc, context)
    if response is None:
        return None
    response.data = _codify(response.data)
    return response
