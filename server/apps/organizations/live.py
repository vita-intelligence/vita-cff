"""Org-scoped live-feed broadcasts.

Every high-value staff-facing list is now a real-time queue: CFF
inbox, projects, proposals, samples, trial batches, label designs,
specifications, payments. When any of those entities changes on the
server — regardless of which tab / app / user triggered it — every
open staff tab for that organisation should reflect it instantly,
without a page reload.

The FE :file:`client/src/lib/query/client.ts` config keeps a short
``staleTime`` (5s) + ``refetchOnWindowFocus: true`` as a fallback,
but the primary freshness driver is this channel: one Channels group
per organisation, one entity-typed event on the wire, one FE
invalidator per entity kind. Payment was the first tenant (see
:mod:`apps.payments.broadcast` — since collapsed into this module);
CFF / projects / proposals / etc. follow the same shape.

Design principles:

* **One group per org** (``org.feed.<uuid>``) — every staff member
  viewing anything for that org shares one broadcast bus. Simpler
  auth than per-entity groups (one capability gate at connect time
  instead of one per event) and matches how operators actually work
  (they bounce between screens on the same org).
* **Typed entity events.** Every broadcast carries
  ``{entity, entity_id, action}``. The FE routes to the right
  TanStack Query invalidation from the entity name. Adding a new
  entity is: add a mutation-site call to
  :func:`schedule_org_broadcast` on the backend + one mapping row in
  the FE ``useOrgFeed`` router — no new consumer, no new URL.
* **On-commit only** for mutation-driven broadcasts. A rolled-back
  write must not leave the FE chasing a phantom row that the API
  can't find. Callers that are running outside a transaction (tests,
  admin scripts, signals mid-request) can use
  :func:`broadcast_org_event_now` directly.
* **Best effort.** A broadcast failure is logged, not raised —
  breaking the mutation because the WS layer glitched would be
  worse than the FE polling within the 5s stale window.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction


logger = logging.getLogger(__name__)


# The union is documentary — the runtime just passes the string
# through. Keeping the list here in one place makes the "what
# entities are wired up" question a two-second grep. Update this AND
# the FE ``ENTITY_KEY_ROOTS`` map in :file:`services/live/hooks.ts`
# when adding a new entity kind.
EntityKind = Literal[
    "payment",
    "cff_submission",
    "formulation",
    "proposal",
    "trial_batch",
    "label_design",
    "specification",
]


EntityAction = Literal[
    "created",
    "updated",
    "deleted",
    "approved",
    "voided",
    "assigned",
    "status_changed",
    "invoice_attached",
]


def org_feed_group_name(organization_id: str) -> str:
    """Channels group name every :class:`OrgFeedConsumer` for the org
    joins. ``.`` separator is Channels-safe (regex-approved) and stays
    readable in logs.
    """

    return f"org.feed.{organization_id}"


def schedule_org_broadcast(
    *,
    organization_id: str,
    entity: str,
    entity_id: str,
    action: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """Enqueue an ``entity.changed`` broadcast for the org feed.

    Deferred to ``transaction.on_commit`` — mandatory for anything
    running inside ``@transaction.atomic`` (i.e. every service +
    view mutation). See module docstring for why.

    ``extra`` is a small optional bag the FE can key off for cheap
    routing decisions without a full detail-fetch (e.g. ``status`` +
    ``kind`` on Payment so the invalidator can pick the right
    column). Keep it small — the payload is not a serialised entity.
    """

    org_id = str(organization_id)
    ent = str(entity)
    ent_id = str(entity_id)
    act = str(action)
    payload_extra = dict(extra or {})

    def _emit() -> None:
        broadcast_org_event_now(
            organization_id=org_id,
            entity=ent,
            entity_id=ent_id,
            action=act,
            extra=payload_extra,
        )

    transaction.on_commit(_emit)


def broadcast_org_event_now(
    *,
    organization_id: str,
    entity: str,
    entity_id: str,
    action: str,
    extra: dict[str, Any] | None = None,
) -> None:
    """Direct (non-deferred) send. Use this from contexts that are
    outside a transaction; use :func:`schedule_org_broadcast` from
    services / views.
    """

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.debug(
            "No channel layer configured; skipping org broadcast (%s.%s).",
            entity,
            action,
        )
        return

    group = org_feed_group_name(organization_id)
    payload = {
        "entity": entity,
        "entity_id": entity_id,
        "action": action,
    }
    if extra:
        payload.update(extra)
    message = {
        # Channels converts the ``.`` separator into ``_`` when
        # picking the handler method on the consumer, so
        # ``entity.changed`` fires ``entity_changed``.
        "type": "entity.changed",
        "payload": payload,
    }
    try:
        async_to_sync(channel_layer.group_send)(group, message)
    except Exception:  # noqa: BLE001 — broadcasts are best-effort
        logger.exception(
            "Failed to broadcast entity.changed(%s.%s) for %s to %s",
            entity,
            action,
            entity_id,
            group,
        )
