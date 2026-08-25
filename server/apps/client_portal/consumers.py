"""WebSocket consumer for the customer-portal live feed.

Mirror of :class:`apps.organizations.consumers.OrgFeedConsumer` but
scoped to the customer side. Purpose: when a staff member on the
vita-cff app mutates something owned by a customer — approves a
proposal, records a payment, moves a label design forward, publishes
a spec — the customer viewing the portal sees it live without
refreshing the tab.

Auth uses ``scope["client_account"]`` set by
:class:`apps.comments.middleware.CookieJWTAuthMiddleware`. The
consumer resolves the account's organisation and joins the same
``org.feed.<uuid>`` group the staff consumer joins for that org.
Every ``entity.changed`` event flows through unfiltered — the FE
hook translates them into invalidations of the portal query keys,
and the portal REST endpoints already scope every list by the
customer's own ``customer_id``. Result: an event about an entity
that doesn't belong to this customer causes at most one wasted
refetch that returns unchanged data. Cheap.

Filtering server-side by resolving each entity's owning
``customer_id`` at broadcast time is a future optimisation — worth
it if per-org portal populations grow past ~50 concurrent tabs
where the noise-refetch cost stops being negligible.
"""

from __future__ import annotations

from typing import Any

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from apps.organizations.live import org_feed_group_name


# Same terminal close codes as the staff consumers so the FE
# ``TERMINAL_CODES`` guard applies uniformly.
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_BAD_TARGET = 4404
CLOSE_ORG_INACTIVE = 4423


class PortalFeedConsumer(AsyncJsonWebsocketConsumer):
    """One socket per (browser tab, portal client_account).

    URL pattern::

        ws/portal/feed/

    The client_account's ``customer.organization_id`` decides which
    org group to join. A locked / inactive account closes with
    ``4401`` so the FE reconnect backoff treats it as terminal.
    """

    async def connect(self) -> None:
        client_account = self.scope.get("client_account")
        if client_account is None or not getattr(
            client_account, "is_active", False
        ):
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        organization_id = await _resolve_org_id(client_account)
        if organization_id is None:
            await self.close(code=CLOSE_BAD_TARGET)
            return

        self.organization_id = str(organization_id)
        self.group_name = org_feed_group_name(self.organization_id)
        self.client_account_id = str(getattr(client_account, "id", ""))

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code: int) -> None:  # type: ignore[override]
        group = getattr(self, "group_name", None)
        if group:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content: Any, **kwargs: Any) -> None:  # type: ignore[override]
        if not isinstance(content, dict):
            return
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def entity_changed(self, event: dict) -> None:
        """Forward an ``entity.changed`` broadcast to the portal
        client.

        Same envelope shape the staff consumer emits — the FE hook
        (:file:`lib/live/use-portal-feed.ts`) decides which portal
        query keys to invalidate from ``entity``.
        """

        await self.send_json(
            {"type": "entity.changed", "payload": event.get("payload", {})}
        )


# ---------------------------------------------------------------------------
# Sync helpers
# ---------------------------------------------------------------------------


@database_sync_to_async
def _resolve_org_id(client_account) -> str | None:
    """Return the org UUID that scopes this portal account's feed,
    or ``None`` when it cannot be resolved (missing customer FK,
    orphaned account).
    """

    customer = getattr(client_account, "customer", None)
    if customer is None:
        return None
    org_id = getattr(customer, "organization_id", None)
    if not org_id:
        return None
    return str(org_id)


def broadcast_production_status_changed(formulation) -> None:
    """Fan out a ``production_status.changed`` event on the portal
    feed so the customer's tab invalidates the project-detail query
    without polling.

    Called from :class:`apps.formulations.api.psp_integration.PspProductionStatusUpsertView`
    on every PSP push — one broadcast per upsert, keyed by the
    formulation uuid so the FE hook can match it to the currently-
    open project tab. Silent-degrade wraps this at the callsite;
    a Channels-less deployment simply skips the fanout.
    """

    from apps.organizations.live import broadcast_org_event_now

    organization_id = getattr(formulation, "organization_id", None)
    if not organization_id:
        return

    broadcast_org_event_now(
        organization_id=str(organization_id),
        entity="psp_production_status",
        entity_id=str(getattr(formulation, "id", "")),
        action="updated",
    )
