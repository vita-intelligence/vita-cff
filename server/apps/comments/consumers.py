"""WebSocket consumers for the comments app.

Commit 4 adds **presence + typing** on top of the commit-3 skeleton:

* Presence is peer-driven — there is no server-side roster table.
  When a consumer connects it announces itself via a
  ``presence.joined`` group broadcast and asks existing viewers to
  re-announce themselves (``presence.roster_request``). Every
  existing consumer responds with its own ``presence.joined``.
  When a consumer disconnects it broadcasts ``presence.left``. The
  design works identically for the in-memory channel layer (dev /
  tests) and the Redis layer (production multi-worker) because the
  sole source of truth is the channel layer's broadcast bus.

* Typing is a pass-through broadcast. Clients send
  ``typing.start`` / ``typing.stop``; the consumer rebroadcasts to
  the group. The server never caches typing state — receivers clear
  stale typists on their own via a TTL guard.

Comment writes still originate in the REST layer; commit 5 will
have the write path call ``channel_layer.group_send`` to emit
``comment.created`` / ``comment.updated`` / ``comment.resolved``
broadcasts (the handler stubs landed in commit 3).

Message envelope convention (all messages):

    {
      "type": "<topic.event>",
      "payload": { ... optional body ... }
    }

The ``type`` field is namespaced (``comment.*``, ``presence.*``,
``typing.*``) so one consumer can multiplex every event kind the UI
needs — matches the "one unified group per entity" decision from the
Phase 1 plan.
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.contrib.auth.models import AnonymousUser

from apps.organizations.modules import (
    FORMULATIONS_MODULE,
    FormulationsCapability,
)


# Close codes — client decodes these so the reconnect backoff can
# tell "I typed the wrong token" (don't retry) from "network blip"
# (retry fast).
CLOSE_UNAUTHENTICATED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_BAD_TARGET = 4404
CLOSE_ORG_INACTIVE = 4423


class CommentConsumer(AsyncJsonWebsocketConsumer):
    """One entity watcher — formulation or specification sheet.

    URL pattern (see :mod:`apps.comments.routing`)::

        ws/org/<uuid:org_id>/<entity_kind>/<uuid:entity_id>/

    ``entity_kind`` is ``formulation`` or ``specification``. All
    watchers of the same entity share a Redis group named
    ``comments:{kind}:{id}`` — future broadcasts from REST writes and
    presence/typing events fan out through that group.
    """

    async def connect(self) -> None:
        scope_user = self.scope.get("user") or AnonymousUser()
        if getattr(scope_user, "is_authenticated", False) is not True:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        kwargs = self.scope["url_route"]["kwargs"]
        kind: str = kwargs.get("entity_kind", "")
        if kind not in {"formulation", "specification"}:
            await self.close(code=CLOSE_BAD_TARGET)
            return

        org_id = kwargs.get("org_id")
        entity_id = kwargs.get("entity_id")
        if not _looks_like_uuid(org_id) or not _looks_like_uuid(entity_id):
            await self.close(code=CLOSE_BAD_TARGET)
            return

        verdict = await _authorise(scope_user, str(org_id), kind, str(entity_id))
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
        # ``verdict == "ok"`` — fall through.

        # Channels restricts group names to ASCII alphanumerics, hyphens,
        # underscores, and periods. We use ``.`` as the separator so the
        # string stays readable in logs while complying with the
        # ``channel_layer`` regex.
        self.group_name = f"comments.{kind}.{entity_id}"
        self.entity_kind = kind
        self.entity_id = str(entity_id)
        self.organization_id = str(org_id)
        # Cached identity blob for presence + typing broadcasts so we
        # don't re-shape the user on every outbound message.
        self.viewer = _viewer_snapshot(scope_user)

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # Peer-driven presence. Announce ourselves, then ask every
        # existing viewer to re-announce so the new client assembles
        # a full roster. Existing viewers ignore their own request
        # via the ``requester_channel`` guard inside the handler.
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.joined", "viewer": self.viewer},
        )
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "presence.roster_request",
                "requester_channel": self.channel_name,
            },
        )

    async def disconnect(self, code: int) -> None:  # type: ignore[override]
        group = getattr(self, "group_name", None)
        if group:
            viewer = getattr(self, "viewer", None)
            if viewer is not None:
                await self.channel_layer.group_send(
                    group,
                    {"type": "presence.left", "viewer": viewer},
                )
            await self.channel_layer.group_discard(group, self.channel_name)

    # -------------------------------------------------------------------
    # Client → server messages
    # -------------------------------------------------------------------

    async def receive_json(self, content: Any, **kwargs: Any) -> None:  # type: ignore[override]
        if not isinstance(content, dict):
            return
        message_type = content.get("type")
        if message_type == "ping":
            await self.send_json({"type": "pong"})
            return
        if message_type == "typing.start":
            await self.channel_layer.group_send(
                self.group_name,
                {"type": "typing.started", "viewer": self.viewer},
            )
            return
        if message_type == "typing.stop":
            await self.channel_layer.group_send(
                self.group_name,
                {"type": "typing.stopped", "viewer": self.viewer},
            )
            return
        # Unknown topics: silently drop. A buggy / malicious client
        # would otherwise hammer the consumer with malformed events on
        # every reconnect.

    # -------------------------------------------------------------------
    # Server → client broadcasts. Each handler is a ``<topic>_<event>``
    # coroutine that the channel layer invokes when a ``group_send``
    # with a matching ``type`` arrives. Commit 5 will wire the REST
    # write path to ``comment_*``; presence and typing fire today.
    # -------------------------------------------------------------------

    async def presence_joined(self, event: dict) -> None:
        await self.send_json(
            {"type": "presence.joined", "viewer": event.get("viewer", {})}
        )

    async def presence_left(self, event: dict) -> None:
        await self.send_json(
            {"type": "presence.left", "viewer": event.get("viewer", {})}
        )

    async def presence_roster_request(self, event: dict) -> None:
        # A new viewer is asking for the current roster. Ignore the
        # request from ourselves so we don't double-announce, then
        # re-broadcast our own ``presence.joined``. Every existing
        # viewer does the same, so the new client ends up with one
        # ``presence.joined`` per member of the group.
        if event.get("requester_channel") == self.channel_name:
            return
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.joined", "viewer": self.viewer},
        )

    async def typing_started(self, event: dict) -> None:
        viewer = event.get("viewer", {})
        # Don't echo the typing notification back to the typist —
        # clients only render other people's typing state.
        if viewer.get("id") == self.viewer.get("id"):
            return
        await self.send_json({"type": "typing.start", "viewer": viewer})

    async def typing_stopped(self, event: dict) -> None:
        viewer = event.get("viewer", {})
        if viewer.get("id") == self.viewer.get("id"):
            return
        await self.send_json({"type": "typing.stop", "viewer": viewer})

    async def comment_created(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.created", "payload": event.get("payload", {})}
        )

    async def comment_updated(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.updated", "payload": event.get("payload", {})}
        )

    async def comment_deleted(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.deleted", "payload": event.get("payload", {})}
        )

    async def comment_resolved(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.resolved", "payload": event.get("payload", {})}
        )


# ---------------------------------------------------------------------------
# Sync helpers run inside ``database_sync_to_async`` — ORM touches must
# not block the async event loop.
# ---------------------------------------------------------------------------


@database_sync_to_async
def _authorise(
    user, org_id: str, kind: str, entity_id: str
) -> str:
    """Reproduce the REST permission gate in one synchronous block.

    Returns one of:
        ``"ok"`` — connect
        ``"unauthenticated"`` — token missing or user inactive
        ``"inactive"`` — org exists but ``is_active=False`` (pre-billing)
        ``"forbidden"`` — member lacks ``comments_view``
        ``"missing"`` — org / membership / entity not found in caller's org
    """

    from apps.formulations.models import Formulation
    from apps.organizations.models import Organization
    from apps.organizations.services import (
        get_membership,
        has_capability,
        is_organization_accessible,
    )
    from apps.specifications.models import SpecificationSheet

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

    if not has_capability(
        membership,
        FORMULATIONS_MODULE,
        FormulationsCapability.COMMENTS_VIEW,
    ):
        return "forbidden"

    # Entity-in-org check — matches the REST ``_load_formulation`` /
    # ``_load_specification`` 404 guard.
    if kind == "formulation":
        exists = Formulation.objects.filter(
            organization=organization, id=entity_id
        ).exists()
    else:  # specification
        exists = SpecificationSheet.objects.filter(
            organization=organization, id=entity_id
        ).exists()
    if not exists:
        return "missing"
    return "ok"


def _looks_like_uuid(value: Any) -> bool:
    try:
        UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def _viewer_snapshot(user) -> dict[str, Any]:
    """Shape the viewer identity payload that presence + typing
    broadcasts carry.

    Kept narrow on purpose: id + display name only. No email, no
    role, no capability list — anything richer would leak data the
    viewer did not opt into sharing with their peers.
    """

    full_name = ""
    first_name = getattr(user, "first_name", "") or ""
    last_name = getattr(user, "last_name", "") or ""
    if first_name or last_name:
        full_name = f"{first_name} {last_name}".strip()
    return {
        "id": str(getattr(user, "id", "") or ""),
        "name": full_name or getattr(user, "email", "") or "Someone",
        # Opt-in profile photo. Empty string keeps the peer-rendered
        # avatar surface in "initials only" mode. Sent with every
        # presence.joined broadcast so late-arriving viewers see the
        # full roster with photos immediately.
        "avatar_url": getattr(user, "avatar_image", "") or "",
    }


# ---------------------------------------------------------------------------
# Public / kiosk consumer — connects via share-token + signed kiosk
# cookie, joins the unified ``comments.specification.<id>`` group so
# org-side members and public visitors see each other's presence,
# typing, and new comments live.
# ---------------------------------------------------------------------------


class PublicCommentConsumer(AsyncJsonWebsocketConsumer):
    """Kiosk variant of :class:`CommentConsumer`.

    URL pattern::

        ws/public/specification/<uuid:token>/

    Auth flow:

    1. :class:`apps.comments.middleware.CookieJWTAuthMiddleware` has
       already placed the cookie jar on ``scope["cookies"]``.
    2. We decode the signed kiosk session cookie for the given token,
       resolve the :class:`KioskSession` row, and validate that it is
       not revoked.
    3. On success we join ``comments.specification.<sheet_id>`` — the
       same group the authed consumer joins — so broadcasts fan out
       to every watcher regardless of side.
    """

    async def connect(self) -> None:
        kwargs = self.scope["url_route"]["kwargs"]
        token = kwargs.get("token")
        if not _looks_like_uuid(token):
            await self.close(code=CLOSE_BAD_TARGET)
            return

        resolved = await _resolve_kiosk_session(
            scope_cookies=self.scope.get("cookies") or {},
            public_token=str(token),
        )
        if resolved is None:
            await self.close(code=CLOSE_UNAUTHENTICATED)
            return

        session_id, sheet_id, org_id, viewer = resolved
        self.entity_kind = "specification"
        self.entity_id = str(sheet_id)
        self.organization_id = str(org_id)
        self.group_name = f"comments.specification.{sheet_id}"
        self.viewer = viewer
        self.kiosk_session_id = str(session_id)

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.joined", "viewer": self.viewer},
        )
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "presence.roster_request",
                "requester_channel": self.channel_name,
            },
        )

    async def disconnect(self, code: int) -> None:  # type: ignore[override]
        group = getattr(self, "group_name", None)
        if group:
            viewer = getattr(self, "viewer", None)
            if viewer is not None:
                await self.channel_layer.group_send(
                    group,
                    {"type": "presence.left", "viewer": viewer},
                )
            await self.channel_layer.group_discard(group, self.channel_name)

    async def receive_json(self, content: Any, **kwargs: Any) -> None:  # type: ignore[override]
        if not isinstance(content, dict):
            return
        message_type = content.get("type")
        if message_type == "ping":
            await self.send_json({"type": "pong"})
            return
        if message_type == "typing.start":
            await self.channel_layer.group_send(
                self.group_name,
                {"type": "typing.started", "viewer": self.viewer},
            )
            return
        if message_type == "typing.stop":
            await self.channel_layer.group_send(
                self.group_name,
                {"type": "typing.stopped", "viewer": self.viewer},
            )
            return

    # Handlers mirror :class:`CommentConsumer`. We duplicate the bodies
    # rather than inherit because the two consumers have different
    # ``connect`` contracts; a shared mixin would add indirection for
    # little gain while the handler list is small.

    async def presence_joined(self, event: dict) -> None:
        await self.send_json(
            {"type": "presence.joined", "viewer": event.get("viewer", {})}
        )

    async def presence_left(self, event: dict) -> None:
        await self.send_json(
            {"type": "presence.left", "viewer": event.get("viewer", {})}
        )

    async def presence_roster_request(self, event: dict) -> None:
        if event.get("requester_channel") == self.channel_name:
            return
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.joined", "viewer": self.viewer},
        )

    async def typing_started(self, event: dict) -> None:
        viewer = event.get("viewer", {})
        if viewer.get("id") == self.viewer.get("id"):
            return
        await self.send_json({"type": "typing.start", "viewer": viewer})

    async def typing_stopped(self, event: dict) -> None:
        viewer = event.get("viewer", {})
        if viewer.get("id") == self.viewer.get("id"):
            return
        await self.send_json({"type": "typing.stop", "viewer": viewer})

    async def comment_created(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.created", "payload": event.get("payload", {})}
        )

    async def comment_updated(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.updated", "payload": event.get("payload", {})}
        )

    async def comment_deleted(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.deleted", "payload": event.get("payload", {})}
        )

    async def comment_resolved(self, event: dict) -> None:
        await self.send_json(
            {"type": "comment.resolved", "payload": event.get("payload", {})}
        )


# ---------------------------------------------------------------------------
# Kiosk auth helper — runs inside ``database_sync_to_async`` so the
# signing decode and the ``KioskSession`` lookup happen in one
# worker-thread hop without blocking the event loop.
# ---------------------------------------------------------------------------


@database_sync_to_async
def _resolve_kiosk_session(
    *,
    scope_cookies: dict,
    public_token: str,
) -> tuple | None:
    """Return ``(session_id, sheet_id, org_id, viewer_dict)`` on
    success, ``None`` when auth should fail.

    Emulates :func:`apps.comments.kiosk.resolve_from_request` without
    needing an HTTP ``request`` object — Channels scopes don't carry
    one, so we re-implement the lookup using ``scope["cookies"]``.
    """

    import hashlib

    from django.core import signing

    from apps.comments.kiosk import (
        KIOSK_SESSION_COOKIE_PREFIX,
    )
    from apps.comments.models import KioskSession
    from apps.specifications.services import (
        PublicLinkNotEnabled,
        get_by_public_token,
    )

    try:
        sheet = get_by_public_token(public_token)
    except PublicLinkNotEnabled:
        return None

    cookie_name = f"{KIOSK_SESSION_COOKIE_PREFIX}{sheet.public_token.hex[:16]}"
    signed_value = scope_cookies.get(cookie_name)
    if not signed_value:
        return None

    # Signing salt MUST match :mod:`apps.comments.kiosk` — keep them
    # in sync.
    try:
        raw = signing.TimestampSigner(
            salt="apps.comments.kiosk.v1"
        ).unsign(signed_value, max_age=30 * 24 * 60 * 60)
        import uuid

        session_uuid = uuid.UUID(raw)
    except (signing.BadSignature, signing.SignatureExpired, ValueError):
        return None

    session_hash = hashlib.sha256(signed_value.encode("utf-8")).hexdigest()
    session = (
        KioskSession.objects.filter(
            id=session_uuid, session_hash=session_hash
        )
        .first()
    )
    if session is None or session.revoked_at is not None:
        return None
    if session.public_token != sheet.public_token:
        return None

    viewer = {
        # ``guest:<uuid>`` prefix keeps guest viewer ids distinct
        # from org-member ids (which are plain UUIDs) so presence
        # stores can render a different tint / "client" badge.
        "id": f"guest:{session.id}",
        "name": session.guest_name or "Client",
    }
    return (session.id, sheet.id, sheet.organization_id, viewer)
