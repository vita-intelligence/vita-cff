"""WebSocket consumer for the org-scoped live feed.

Single generic consumer for every high-value staff-facing entity:
CFF, projects, proposals, samples, trial batches, label designs,
specifications, payments. One socket per (tab, org); one Channels
group per org (``org.feed.<uuid>`` — see :mod:`.live`); one
``entity.changed`` event on the wire routed on the FE by ``entity``
name into the matching TanStack Query invalidation.

Auth posture: any authenticated org member with an active
organisation may subscribe. There is no per-entity capability gate
at connect time on purpose — the events carry only an id + action,
never row bodies, so a member seeing a "payment X changed" event
without ``finance.view`` still cannot read the row (their REST call
returns 403). Push-only events tell the FE "your cache is stale for
this thing"; the FE's next fetch is what applies the RBAC layer.

The alternative — one consumer per entity type with per-entity
capability gating — would require every FE page to manage N sockets
+ N reconnect loops, and would prevent a single hook from covering
"invalidate anything the user might be looking at" cross-page.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.contrib.auth.models import AnonymousUser

from apps.organizations.live import org_feed_group_name


# Terminal close codes — shared with :mod:`apps.comments.consumers`
# so the FE ``TERMINAL_CODES`` guard doesn't need per-consumer forks.
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_BAD_TARGET = 4404
CLOSE_ORG_INACTIVE = 4423


class OrgFeedConsumer(AsyncJsonWebsocketConsumer):
    """One socket per (tab, organisation).

    URL pattern (see :mod:`.routing`)::

        ws/org/<uuid:org_id>/feed/

    Any active member of the org may subscribe. Events on the wire
    are id-only — no body leakage — so per-entity RBAC belongs on the
    REST layer, not here.
    """

    async def connect(self) -> None:
        scope_user = self.scope.get("user") or AnonymousUser()
        if getattr(scope_user, "is_authenticated", False) is not True:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        kwargs = self.scope["url_route"]["kwargs"]
        org_id = kwargs.get("org_id")
        if not _looks_like_uuid(org_id):
            await self.close(code=CLOSE_BAD_TARGET)
            return

        verdict = await _authorise_org_member(scope_user, str(org_id))
        if verdict == "unauthenticated":
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        if verdict == "inactive":
            await self.close(code=CLOSE_ORG_INACTIVE)
            return
        if verdict == "missing":
            await self.close(code=CLOSE_BAD_TARGET)
            return

        self.organization_id = str(org_id)
        self.group_name = org_feed_group_name(self.organization_id)

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code: int) -> None:  # type: ignore[override]
        group = getattr(self, "group_name", None)
        if group:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content: Any, **kwargs: Any) -> None:  # type: ignore[override]
        # Feed is server-push only. ``ping`` keeps the FE keep-alive
        # layer able to detect dead sockets through proxies that
        # swallow idle TCP.
        if not isinstance(content, dict):
            return
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def entity_changed(self, event: dict) -> None:
        """Forward an ``entity.changed`` broadcast to this socket.

        Channels converts the ``type: "entity.changed"`` envelope
        into the ``entity_changed`` handler name. Payload shape is
        fixed in :mod:`.live` — the FE relies on ``entity`` +
        ``entity_id`` + ``action`` (with optional extras).
        """

        await self.send_json(
            {"type": "entity.changed", "payload": event.get("payload", {})}
        )


# ---------------------------------------------------------------------------
# Sync helpers
# ---------------------------------------------------------------------------


@database_sync_to_async
def _authorise_org_member(user, org_id: str) -> str:
    """Confirm the user is an active member of an active org.

    Returns one of ``"ok"``, ``"unauthenticated"``, ``"inactive"``,
    ``"missing"`` — the FE guard maps these to terminal / non-terminal
    close code semantics.
    """

    from apps.organizations.models import Organization
    from apps.organizations.services import (
        get_membership,
        is_organization_accessible,
    )

    if not getattr(user, "is_authenticated", False):
        return "unauthenticated"

    organization = Organization.objects.filter(id=org_id).first()
    if organization is None:
        return "missing"

    membership = get_membership(user, organization)
    if membership is None:
        return "missing"

    if not is_organization_accessible(organization, user):
        return "inactive"

    return "ok"


def _looks_like_uuid(value: Any) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True
