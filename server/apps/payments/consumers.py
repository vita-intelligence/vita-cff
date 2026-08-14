"""WebSocket consumer for the finance payments live feed.

One socket per (tab, organisation). Joins the
``payments.org.<uuid>`` group and receives ``payment.changed``
broadcasts whenever a payment is recorded, approved, voided, edited,
assigned, or has an invoice attached. The consumer's only job is to
push those events through to the FE so the TanStack Query cache can
invalidate the affected list; no per-payment sub-channels, no
presence, no typing — the finance pipeline is a queue, not a
collaborative form.

Shape mirrors :class:`apps.comments.consumers.CommentConsumer`
(auth via ``scope["user"]`` populated by
:class:`apps.comments.middleware.CookieJWTAuthMiddleware`, capability
gate resolved in a ``database_sync_to_async`` hop, terminal close
codes for auth / bad target so the FE reconnect backoff can
distinguish "wrong token" from "network blip").
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.contrib.auth.models import AnonymousUser

from apps.payments.broadcast import payments_org_group_name


# Terminal close codes — same set as :mod:`apps.comments.consumers`
# so the FE ``TERMINAL_CODES`` guard doesn't need a payments-specific
# fork.
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_BAD_TARGET = 4404
CLOSE_ORG_INACTIVE = 4423


class PaymentsFeedConsumer(AsyncJsonWebsocketConsumer):
    """One socket per finance viewer per organisation.

    URL pattern (see :mod:`apps.payments.routing`)::

        ws/org/<uuid:org_id>/payments/

    Auth requirement: caller is authenticated, is an active member of
    the org, and holds the ``finance.view`` capability. Any other
    verdict closes with the matching terminal code so the FE doesn't
    reconnect in a loop against a permanent deny.
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

        verdict = await _authorise_finance(scope_user, str(org_id))
        if verdict == "unauthenticated":
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return
        if verdict == "inactive":
            await self.close(code=CLOSE_ORG_INACTIVE)
            return
        if verdict == "forbidden":
            await self.close(code=CLOSE_FORBIDDEN)
            return
        if verdict == "missing":
            await self.close(code=CLOSE_BAD_TARGET)
            return

        self.organization_id = str(org_id)
        self.group_name = payments_org_group_name(self.organization_id)

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code: int) -> None:  # type: ignore[override]
        group = getattr(self, "group_name", None)
        if group:
            await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content: Any, **kwargs: Any) -> None:  # type: ignore[override]
        # Payments feed is server-push only. ``ping`` support keeps
        # the FE's keep-alive layer able to detect dead sockets
        # through proxies that swallow idle TCP.
        if not isinstance(content, dict):
            return
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def payment_changed(self, event: dict) -> None:
        """Forward a ``payment.changed`` broadcast to this socket.

        Channels converts the ``type: "payment.changed"`` envelope
        into the ``payment_changed`` handler name. The payload shape
        is fixed in :mod:`apps.payments.broadcast` — the FE relies on
        ``payment_id`` + ``action`` + ``status`` + ``kind``.
        """

        await self.send_json(
            {"type": "payment.changed", "payload": event.get("payload", {})}
        )


# ---------------------------------------------------------------------------
# Sync helpers
# ---------------------------------------------------------------------------


@database_sync_to_async
def _authorise_finance(user, org_id: str) -> str:
    """Reproduce the REST ``HasFinancePermission`` gate synchronously.

    Returns one of:

    * ``"ok"`` — connect
    * ``"unauthenticated"`` — token missing or user inactive
    * ``"inactive"`` — org exists but ``is_active=False``
    * ``"forbidden"`` — member lacks ``finance.view``
    * ``"missing"`` — org / membership not found
    """

    from apps.organizations.models import Organization
    from apps.organizations.modules import FinanceCapability
    from apps.organizations.services import (
        get_membership,
        has_capability,
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

    if not has_capability(membership, "finance", FinanceCapability.VIEW):
        return "forbidden"

    return "ok"


def _looks_like_uuid(value: Any) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True
