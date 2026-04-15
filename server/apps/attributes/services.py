"""Service layer for the attributes app.

The :func:`validate_values` function is the single enforcement point
for the dynamic attribute map on any catalogue item. Every write path
— item create, item update, bulk import — runs its incoming
``attributes`` dict through this function before persisting.

Returns a tuple of ``(coerced_values, errors)``:

* ``coerced_values`` is a new dict containing only the keys that
  survived validation, with each value cast to its canonical storage
  form (``float`` for numbers, ISO-string for dates, etc.).
* ``errors`` maps ``key → [error_code, ...]``. Callers raise a
  serializer-level ``ValidationError`` from this mapping so the
  frontend receives the same machine-readable ``snake_case`` codes
  the rest of the API uses.
"""

from __future__ import annotations

import datetime as _dt
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.models import Catalogue


_KEY_REGEX = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class AttributeDefinitionKeyConflict(Exception):
    code = "attribute_key_conflict"


class AttributeDefinitionInvalidKey(Exception):
    code = "attribute_key_invalid"


class AttributeDefinitionInvalidOptions(Exception):
    code = "attribute_options_invalid"


class AttributeDefinitionNotFound(Exception):
    code = "attribute_not_found"


# ---------------------------------------------------------------------------
# Definition CRUD
# ---------------------------------------------------------------------------


def list_definitions(
    *,
    catalogue: Catalogue,
    include_archived: bool = False,
) -> QuerySet[AttributeDefinition]:
    qs = AttributeDefinition.objects.filter(catalogue=catalogue)
    if not include_archived:
        qs = qs.filter(is_archived=False)
    return qs.order_by("display_order", "label")


def get_definition(
    *,
    catalogue: Catalogue,
    definition_id: Any,
) -> AttributeDefinition:
    definition = AttributeDefinition.objects.filter(
        catalogue=catalogue, id=definition_id
    ).first()
    if definition is None:
        raise AttributeDefinitionNotFound()
    return definition


def _validate_options(data_type: str, options: list[Any]) -> list[dict[str, str]]:
    """Normalize and validate ``options`` for a select definition."""

    if data_type not in {DataType.SINGLE_SELECT, DataType.MULTI_SELECT}:
        if options:
            raise AttributeDefinitionInvalidOptions()
        return []

    if not isinstance(options, list) or not options:
        raise AttributeDefinitionInvalidOptions()

    normalized: list[dict[str, str]] = []
    seen_values: set[str] = set()
    for raw in options:
        if not isinstance(raw, dict):
            raise AttributeDefinitionInvalidOptions()
        value = raw.get("value")
        label = raw.get("label") or raw.get("value")
        if not isinstance(value, str) or not value.strip():
            raise AttributeDefinitionInvalidOptions()
        if not isinstance(label, str) or not label.strip():
            raise AttributeDefinitionInvalidOptions()
        value = value.strip()
        if value in seen_values:
            raise AttributeDefinitionInvalidOptions()
        seen_values.add(value)
        normalized.append({"value": value, "label": label.strip()})
    return normalized


@transaction.atomic
def create_definition(
    *,
    catalogue: Catalogue,
    actor: Any,
    key: str,
    label: str,
    data_type: str,
    required: bool = False,
    options: list[Any] | None = None,
    display_order: int = 0,
) -> AttributeDefinition:
    key = key.strip()
    if not _KEY_REGEX.match(key):
        raise AttributeDefinitionInvalidKey()

    duplicate = AttributeDefinition.objects.filter(
        catalogue=catalogue, key=key
    ).exists()
    if duplicate:
        raise AttributeDefinitionKeyConflict()

    normalized_options = _validate_options(data_type, options or [])

    return AttributeDefinition.objects.create(
        catalogue=catalogue,
        key=key,
        label=label.strip(),
        data_type=data_type,
        required=required,
        options=normalized_options,
        display_order=display_order,
        created_by=actor,
        updated_by=actor,
    )


@transaction.atomic
def update_definition(
    *,
    definition: AttributeDefinition,
    actor: Any,
    label: str | None = None,
    required: bool | None = None,
    options: list[Any] | None = None,
    display_order: int | None = None,
    is_archived: bool | None = None,
) -> AttributeDefinition:
    """Update mutable fields on a definition.

    ``key`` and ``data_type`` are deliberately omitted — renaming the
    key would orphan every stored value, and switching the data type
    would require a migration pass across every row in the catalogue.
    Both operations can be modelled as "archive the old one, create a
    new one" when they become necessary.
    """

    if label is not None:
        definition.label = label.strip()
    if required is not None:
        definition.required = required
    if display_order is not None:
        definition.display_order = display_order
    if is_archived is not None:
        definition.is_archived = is_archived
    if options is not None:
        definition.options = _validate_options(definition.data_type, options)
    definition.updated_by = actor
    definition.save()
    return definition


# ---------------------------------------------------------------------------
# Value validation
# ---------------------------------------------------------------------------


def _coerce_text(value: Any) -> tuple[str | None, str | None]:
    if not isinstance(value, str):
        return None, "invalid"
    trimmed = value.strip()
    return trimmed or None, None


def _coerce_number(value: Any) -> tuple[float | None, str | None]:
    if isinstance(value, bool):
        return None, "invalid"
    if isinstance(value, (int, float)):
        return float(value), None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None, None
        try:
            return float(Decimal(trimmed)), None
        except (InvalidOperation, ValueError):
            return None, "invalid"
    return None, "invalid"


def _coerce_boolean(value: Any) -> tuple[bool | None, str | None]:
    if isinstance(value, bool):
        return value, None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes"}:
            return True, None
        if lowered in {"false", "0", "no", ""}:
            return False if lowered else None, None
    return None, "invalid"


def _coerce_date(value: Any) -> tuple[str | None, str | None]:
    if isinstance(value, _dt.date):
        return value.isoformat(), None
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None, None
        try:
            return _dt.date.fromisoformat(trimmed).isoformat(), None
        except ValueError:
            return None, "invalid"
    return None, "invalid"


def _coerce_single_select(
    value: Any, options: list[dict[str, str]]
) -> tuple[str | None, str | None]:
    if value is None or value == "":
        return None, None
    if not isinstance(value, str):
        return None, "invalid"
    allowed = {opt["value"] for opt in options}
    if value not in allowed:
        return None, "invalid"
    return value, None


def _coerce_multi_select(
    value: Any, options: list[dict[str, str]]
) -> tuple[list[str] | None, str | None]:
    if value is None or value == "":
        return None, None
    if not isinstance(value, list):
        return None, "invalid"
    allowed = {opt["value"] for opt in options}
    seen: set[str] = set()
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or item not in allowed or item in seen:
            return None, "invalid"
        seen.add(item)
        result.append(item)
    return result, None


def validate_values(
    *,
    catalogue: Catalogue,
    incoming: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Validate ``incoming`` against the active definitions for ``catalogue``.

    * Keys belonging to archived or nonexistent definitions are dropped
      silently so a stale frontend form submit does not fail writes.
    * Required definitions whose value is missing or empty produce a
      ``required`` error code under their key.
    * Type-invalid values produce an ``invalid`` code under their key.
    """

    if incoming is None:
        incoming = {}
    definitions = list(
        AttributeDefinition.objects.filter(
            catalogue=catalogue,
            is_archived=False,
        )
    )

    coerced: dict[str, Any] = {}
    errors: dict[str, list[str]] = {}

    for definition in definitions:
        raw = incoming.get(definition.key)
        value: Any
        error: str | None

        if definition.data_type == DataType.TEXT:
            value, error = _coerce_text(raw if raw is not None else "")
        elif definition.data_type == DataType.NUMBER:
            value, error = _coerce_number(raw if raw is not None else "")
        elif definition.data_type == DataType.BOOLEAN:
            if raw is None:
                value, error = None, None
            else:
                value, error = _coerce_boolean(raw)
        elif definition.data_type == DataType.DATE:
            value, error = _coerce_date(raw if raw is not None else "")
        elif definition.data_type == DataType.SINGLE_SELECT:
            value, error = _coerce_single_select(raw, definition.options)
        elif definition.data_type == DataType.MULTI_SELECT:
            value, error = _coerce_multi_select(raw, definition.options)
        else:
            value, error = None, "invalid"

        if error is not None:
            errors[definition.key] = [error]
            continue

        if value is None or value == "" or value == []:
            if definition.required:
                errors[definition.key] = ["required"]
            continue

        coerced[definition.key] = value

    return coerced, errors
