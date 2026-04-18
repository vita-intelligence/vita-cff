"""Domain model for the org-scoped audit trail.

An :class:`AuditLog` row captures a single state-changing operation
— who did it, when, what target it touched, and the before/after
payload. Every write path inside the product services records one
row; UIs on top of the table land in later phases.

Design notes:

- ``actor`` is ``SET_NULL`` rather than ``CASCADE`` so deleting a
  user doesn't retroactively remove their audit history. Actor
  attribution degrades gracefully to "system / unknown user".
- ``target_id`` is a ``CharField`` so we can point at ids of any
  shape (UUID, integer, composite). The reader code does the
  parse when rendering.
- ``before`` / ``after`` are untyped JSON on purpose — each
  service layer decides the snapshot shape (usually Django's
  ``model_to_dict``-style field map). Schema-on-read.
- No index on ``action`` — ``(organization, -created_at)`` is the
  primary query path. We'll revisit when Phase C adds filters.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone


class AuditLog(models.Model):
    """A single audited write event inside an organisation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="audit_logs",
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="audit_logs",
        help_text="User who triggered the action; null for system events.",
    )

    #: Dot-separated ``{module}.{verb}`` slug —
    #: e.g. ``formulation.create``, ``catalogue_item.archive``,
    #: ``spec_sheet.status_transition``. Free-form on purpose so
    #: new event types don't require a migration.
    action = models.CharField(max_length=64)
    #: Machine-readable target type (``formulation``,
    #: ``formulation_line``, ``catalogue_item``, ...). Kept narrow
    #: so future filter UIs can render a sensible dropdown without
    #: scanning distinct values.
    target_type = models.CharField(max_length=64)
    #: Stringified primary key. UUIDs, integers, and composite keys
    #: all serialise to text here — readers cast back when needed.
    target_id = models.CharField(max_length=64)

    #: Snapshot captured BEFORE the mutation ran; ``None`` for
    #: pure creates. Schema is defined by each caller so we don't
    #: tie the audit format to a specific model.
    before = models.JSONField(null=True, blank=True)
    #: Snapshot captured AFTER the mutation settled; ``None`` for
    #: deletes. See ``before`` on the schema note.
    after = models.JSONField(null=True, blank=True)

    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = "audit log"
        verbose_name_plural = "audit logs"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("organization", "-created_at")),
            models.Index(fields=("target_type", "target_id")),
        ]

    def __str__(self) -> str:
        return f"{self.action} by {self.actor_id or 'system'} at {self.created_at.isoformat()}"
