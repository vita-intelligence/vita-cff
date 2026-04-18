"""Capture helpers the product services call to record audit rows.

Wiring into a write path is two steps:

1. Snapshot the target (if relevant) BEFORE the mutation. Use
   :func:`snapshot` — it mirrors ``model_to_dict`` but handles
   UUIDs, Decimals, and datetimes without callers having to remember.
2. Call :func:`record` once the mutation is committed, passing the
   actor, the organization, an ``action`` slug, the target, and
   whichever of ``before`` / ``after`` apply.

The recorder never raises on audit-log failure. Audit is
observability, not correctness — a broken log entry must not
break the write it was trying to describe. We surface it via
Django's logging instead.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable

from django.db import models

from apps.audit.models import AuditLog


logger = logging.getLogger(__name__)


#: Fields we always strip from snapshots. Timestamps would pollute
#: every update with a no-op diff on ``updated_at``; write-tracking
#: FKs already appear as ``actor`` on the audit row itself.
_SNAPSHOT_SKIP_FIELDS: frozenset[str] = frozenset(
    {
        "updated_at",
        "updated_by",
        "updated_by_id",
    }
)


def snapshot(
    instance: models.Model | None,
    *,
    extra: dict[str, Any] | None = None,
    skip: Iterable[str] = (),
) -> dict[str, Any] | None:
    """Capture a model instance's field values as a JSON-safe dict.

    ``extra`` lets the caller stitch in custom snapshot fragments
    (e.g. a count of related rows, or a preview of an inline JSON
    blob) that aren't direct model fields. Use sparingly — most
    audit rows want the plain model dump.

    Returns ``None`` when ``instance`` is ``None`` so callers can
    pipe ``snapshot(maybe_deleted_thing)`` straight into
    :func:`record` without a branch.
    """

    if instance is None:
        return None

    skip_set = _SNAPSHOT_SKIP_FIELDS | set(skip)
    data: dict[str, Any] = {}
    for field in instance._meta.get_fields():
        if not getattr(field, "concrete", False):
            continue
        if getattr(field, "many_to_many", False):
            continue
        name: str = field.name
        if name in skip_set:
            continue
        attname = getattr(field, "attname", name)
        # FKs land under ``<name>_id`` after Django munges them —
        # use ``attname`` so we capture the id, not a full Model
        # instance the JSON encoder can't handle.
        value = getattr(instance, attname, None)
        data[attname] = _coerce(value)

    if extra:
        for key, raw in extra.items():
            data[key] = _coerce(raw)
    return data


def record(
    *,
    organization: Any,
    actor: Any,
    action: str,
    target: models.Model | None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
) -> AuditLog | None:
    """Write one :class:`AuditLog` row.

    When ``target`` is supplied we derive ``target_type`` from the
    model's ``_meta.label_lower`` (e.g. ``formulations.formulation``)
    trimmed to the model name, and ``target_id`` from ``.pk``.
    Callers mutating a soon-to-be-deleted row can still record a
    meaningful target by passing ``target_id`` explicitly after
    delete — the row is gone but the id we just captured still
    identifies the history.

    Returns the persisted row for convenience in tests; logs and
    swallows any exception so audit writes never bubble up to
    break the surrounding business transaction.
    """

    try:
        resolved_type = target_type or (
            target._meta.model_name if target is not None else "unknown"
        )
        resolved_id = target_id or (
            str(target.pk) if target is not None and target.pk is not None
            else ""
        )
        actor_obj = actor if _looks_like_user(actor) else None
        return AuditLog.objects.create(
            organization=organization,
            actor=actor_obj,
            action=action,
            target_type=resolved_type,
            target_id=resolved_id,
            before=before,
            after=after,
        )
    except Exception:  # noqa: BLE001 — audit must never fail the caller
        logger.exception(
            "Audit record failed (action=%s target_type=%s target_id=%s)",
            action,
            target_type,
            target_id,
        )
        return None


def _looks_like_user(value: Any) -> bool:
    """Treat an instance as a user if it has a ``pk`` and is a
    Django model. Guards against factories passing ``None`` or
    stubs without crashing :func:`AuditLog.objects.create`."""

    if value is None:
        return False
    if not isinstance(value, models.Model):
        return False
    return value.pk is not None


def _coerce(value: Any) -> Any:
    """JSON-friendly coercion for common non-JSON Django types.

    Decimals → strings (lossless), UUIDs → strings, datetimes →
    ISO-8601. Nested containers are walked recursively so a JSON
    field on the model stays structured but free of non-JSON atoms.
    """

    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _coerce(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_coerce(v) for v in value]
    # Fallback: stringify. Keeps audit resilient to attribute types
    # we haven't thought about (e.g. Postgres arrays, custom fields).
    return str(value)
