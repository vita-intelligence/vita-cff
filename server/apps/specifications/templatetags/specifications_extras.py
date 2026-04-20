"""Template filters used by the PDF spec sheet template.

These live inside the ``specifications`` app so the rendering is
self-contained — the template, filters, and view all ship together
and reuse the same ``render_context`` view-model the browser client
consumes.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Iterable

from django import template

register = template.Library()


def _coerce_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


@register.filter
def format_mg(value: Any) -> str:
    """Two-decimal mg render, emdash on missing / non-numeric."""

    parsed = _coerce_decimal(value)
    if parsed is None:
        return "—"
    return f"{parsed:.2f} mg"


@register.filter
def format_nutrient(value: Any) -> str:
    """Format a nutrition / amino aggregate cell.

    Zero and missing values render as ``0`` so the column collapses
    visually for catalogue gaps; non-zero values keep up to two
    decimals with trailing zeros stripped.
    """

    parsed = _coerce_decimal(value)
    if parsed is None or parsed == 0:
        return "0"
    rounded = parsed.quantize(Decimal("0.01"))
    text = format(rounded, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


@register.filter
def strip_trailing_zeros(value: Any) -> str:
    parsed = _coerce_decimal(value)
    if parsed is None:
        return "—"
    rounded = parsed.quantize(Decimal("0.01"))
    text = format(rounded, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


@register.filter
def compliance_label(status: Any) -> str:
    """Map the tri-state compliance flag to the workbook's ``Yes / No``
    copy. Unknown / missing renders as an em dash."""

    if status is True:
        return "Yes"
    if status is False:
        return "No"
    return "—"


@register.filter
def get_item(mapping: Any, key: Any) -> Any:
    """Dict-style lookup usable from a Django template.

    Django's template language has no literal subscript syntax, so the
    ``visibility|get_item:slug`` idiom bridges that gap for the
    customer-facing sheet renderer that walks an ordered list of
    section slugs and consults a ``{slug: bool}`` visibility dict.
    Falls back to ``None`` on anything that is not a mapping or lacks
    the key. The visibility dict is always backfilled server-side so
    every known slug has a bool, making ``None`` mean "unknown slug"
    — the template's truthy check then correctly skips rendering
    that section.
    """

    if mapping is None:
        return None
    try:
        return mapping.get(key)
    except AttributeError:
        try:
            return mapping[key]
        except (KeyError, TypeError):
            return None


@register.filter
def pad_to_rows(current: Any, total: int) -> range:
    """Emit a ``range`` of the blank rows required to reach ``total``.

    The reference spec sheet reserves a fixed-height actives table
    that always fills the page — when the formulation has fewer rows
    than the target, we pad with dash-filled placeholder rows so the
    page layout stays stable across deliverables. Templates iterate
    the returned range to render the placeholders.
    """

    try:
        length = len(current or [])
    except TypeError:
        length = 0
    try:
        target = int(total)
    except (TypeError, ValueError):
        return range(0)
    gap = target - length
    return range(gap) if gap > 0 else range(0)


@register.filter
def non_active_entries(entries: Iterable[dict]) -> list[dict]:
    """Return only excipient / shell entries from the declaration list.

    Mirrors the React view's filter so the PDF's ``Excipient
    Information`` panel matches the browser render exactly.
    """

    result: list[dict] = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        if entry.get("category") != "active":
            result.append(entry)
    return result
