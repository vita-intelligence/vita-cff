"""Broadcast primitives for comment events.

Kept out of :mod:`apps.comments.services` so the service layer stays
ignorant of Channels. The services call :func:`schedule_comment_broadcast`
once per write; this module figures out the group, serialises the
payload, and hands it to :func:`channel_layer.group_send` on commit.

Resilience rule (same as the audit logger): a broken broadcast
**never** breaks the surrounding transaction. If Redis or the
channel layer is down, the write still lands, and the clients
reconcile via their next fetch (they refetch on reconnect anyway).
"""

from __future__ import annotations

import logging
from typing import Any

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction

from apps.comments.models import Comment


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Group-name helpers
# ---------------------------------------------------------------------------


def group_name_for_comment(comment: Comment) -> str | None:
    """Return the canonical group name for ``comment``'s target.

    Matches the scheme :class:`~apps.comments.consumers.CommentConsumer`
    joins on connect. Returns ``None`` when the comment is attached to
    a target we don't yet broadcast on (future trial-batch /
    validation targets would fall here until their consumer ships).
    """

    if comment.formulation_id is not None:
        return f"comments.formulation.{comment.formulation_id}"
    if comment.specification_sheet_id is not None:
        return f"comments.specification.{comment.specification_sheet_id}"
    return None


def inbox_group_name(user_id: str) -> str:
    """Return the canonical Channels group for a user's inbox firehose.

    The :class:`~apps.comments.consumers.UserInboxConsumer` joins this
    group on connect. Period separator (not colon) so the name passes
    the Channels group-name regex without escaping.
    """

    return f"inbox.{user_id}"


def _entity_kind_and_id(comment: Comment) -> tuple[str, str] | None:
    """Return ``(entity_kind, entity_id)`` the inbox FE keys on, or
    ``None`` for unsupported targets (kiosk / future entities)."""

    if comment.formulation_id is not None:
        return ("formulation", str(comment.formulation_id))
    if comment.specification_sheet_id is not None:
        return ("specification", str(comment.specification_sheet_id))
    return None


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def schedule_comment_broadcast(comment: Comment, event: str) -> None:
    """Schedule a ``comment.*`` broadcast for the open transaction.

    ``event`` must be one of ``"created"`` / ``"updated"`` /
    ``"deleted"`` / ``"resolved"`` — matching the handler method
    names on :class:`CommentConsumer`. The broadcast fires once the
    surrounding atomic block commits; a rollback means no broadcast.

    Outside a transaction this runs immediately. Services always wrap
    their writes in ``@transaction.atomic``, so the ``on_commit`` hook
    is the normal path.

    Two fan-outs are scheduled on the same commit hook:

    1. The per-entity ``comments.{kind}.{id}`` group — what the
       in-page chat panel listens on. Fires for every event kind.
    2. The per-user ``inbox.{user_id}`` group — what the global
       messenger bell listens on. Fires only on ``"created"`` for v1
       (updates, deletes, and resolves don't bump unread counts).
    """

    if event not in {"created", "updated", "deleted", "resolved"}:
        logger.warning("Unknown comment broadcast event: %s", event)
        return

    group = group_name_for_comment(comment)
    if group is None:
        return

    payload = _serialise_comment(comment, event)
    comment_id = str(comment.id)

    def _emit() -> None:
        _send_to_group(group=group, event=event, payload=payload, comment_id=comment_id)
        if event == "created":
            _fan_out_inbox_message(comment=comment, payload=payload)

    transaction.on_commit(_emit)


def broadcast_comment_now(
    *,
    group: str,
    event: str,
    payload: dict[str, Any],
    comment_id: str,
) -> None:
    """Synchronous variant used by the tests and the unlikely
    ``delete_comment`` path where the comment row is being mutated
    outside the usual transaction.atomic / service sequence."""

    _send_to_group(group=group, event=event, payload=payload, comment_id=comment_id)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _send_to_group(
    *,
    group: str,
    event: str,
    payload: dict[str, Any],
    comment_id: str,
) -> None:
    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.debug(
            "No channel layer configured; skipping comment broadcast (%s).",
            event,
        )
        return
    message = {"type": f"comment.{event}", "payload": payload}
    if event == "deleted":
        # Lean payload for deletes — the only thing receivers need
        # is the id so they can drop the row from their cache.
        message["payload"] = {"id": comment_id}

    try:
        async_to_sync(channel_layer.group_send)(group, message)
    except Exception:  # noqa: BLE001 — broadcasts are best-effort
        logger.exception(
            "Failed to broadcast comment %s event to %s", event, group
        )


def _fan_out_inbox_message(*, comment: Comment, payload: dict[str, Any]) -> None:
    """Push an ``inbox.message`` event to every org member who can see
    this thread.

    Audience rule mirrors the WS connect-time gate in
    :class:`CommentConsumer`: members of ``comment.organization`` who
    hold the ``formulations.comments_view`` capability. The author of
    the comment is intentionally excluded — their own click already
    bumped their local unread state, and re-flagging the thread as
    unread on their inbox would be confusing.

    Best-effort like :func:`_send_to_group` — a Redis outage means the
    bell badge lags by one fetch, never blocks the write.
    """

    # Local imports keep this module free of org / module concerns
    # at import time so circular-import surprises don't bite when the
    # broadcaster is itself imported from services.
    from apps.organizations.modules import (
        FORMULATIONS_MODULE,
        FormulationsCapability,
    )
    from apps.organizations.services import (
        has_capability,
        list_memberships,
    )

    entity = _entity_kind_and_id(comment)
    if entity is None:
        # Unsupported target — no inbox fan-out. The per-entity
        # broadcast already short-circuited the same way upstream.
        return
    entity_kind, entity_id = entity

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.debug("No channel layer configured; skipping inbox fan-out.")
        return

    author_id = str(comment.author_id) if comment.author_id else ""
    inbox_payload = {
        "comment": payload,
        "entity_kind": entity_kind,
        "entity_id": entity_id,
        "organization_id": str(comment.organization_id),
    }

    try:
        memberships = list_memberships(organization=comment.organization)
    except Exception:  # noqa: BLE001 — defensive: never block the write
        logger.exception("Failed to load org memberships for inbox fan-out")
        return

    for membership in memberships:
        user_id = str(membership.user_id)
        if user_id == author_id:
            continue
        # Audience gate mirrors the inbox REST eligibility check
        # (see :func:`apps.comments.services._accessible_organizations_for_user`).
        # Requires BOTH ``view`` (so the user could otherwise reach
        # the project page) AND ``comments_view`` (so the chat
        # surface is theirs to see) — without the ``view`` check
        # the inbox would leak chats from projects the user cannot
        # otherwise navigate to in the app.
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.VIEW,
        ):
            continue
        if not has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.COMMENTS_VIEW,
        ):
            continue
        try:
            async_to_sync(channel_layer.group_send)(
                inbox_group_name(user_id),
                {"type": "inbox.message", "payload": inbox_payload},
            )
        except Exception:  # noqa: BLE001 — one failure must not stop the fan-out
            logger.exception(
                "Failed to fan out inbox event to user %s", user_id
            )


def _serialise_comment(comment: Comment, event: str) -> dict[str, Any]:
    """Build the on-the-wire shape the client expects.

    Lives here rather than in :mod:`serializers` so the broadcast
    path does not import DRF — keeping Channels-side code narrow
    also means the ASGI worker does not need DRF to be fully
    initialised before it can ship a broadcast.
    """

    if event == "deleted":
        return {"id": str(comment.id)}

    target_type: str
    target_id: str | None
    if comment.formulation_id is not None:
        target_type = "formulation"
        target_id = str(comment.formulation_id)
    elif comment.specification_sheet_id is not None:
        target_type = "specification"
        target_id = str(comment.specification_sheet_id)
    else:
        target_type = "unknown"
        target_id = None

    author: dict[str, Any]
    if comment.is_deleted:
        author = {
            "id": None,
            "kind": "system",
            "name": "",
            "email": "",
            "org_label": "",
            "avatar_url": "",
        }
    elif comment.author_id and comment.author is not None:
        user = comment.author
        author = {
            "id": str(user.id),
            "kind": "member",
            "name": (user.get_full_name() or user.email).strip(),
            "email": user.email,
            "org_label": "",
            "avatar_url": user.avatar_image or "",
        }
    else:
        author = {
            "id": None,
            "kind": "guest",
            "name": comment.guest_name,
            "email": comment.guest_email,
            "org_label": comment.guest_org_label,
            "avatar_url": "",
        }

    mentions: list[dict[str, Any]] = []
    if not comment.is_deleted:
        for row in comment.mentions.select_related("mentioned_user").all():
            user = row.mentioned_user
            mentions.append(
                {
                    "id": str(row.mentioned_user_id),
                    "name": (user.get_full_name() or user.email).strip(),
                    "email": user.email,
                }
            )

    return {
        "id": str(comment.id),
        "parent_id": str(comment.parent_id) if comment.parent_id else None,
        "target_type": target_type,
        "target_id": target_id,
        "author": author,
        "body": comment.body,
        "mentions": mentions,
        "needs_resolution": comment.needs_resolution,
        "is_resolved": comment.is_resolved,
        "is_edited": comment.is_edited,
        "is_deleted": comment.is_deleted,
        "created_at": comment.created_at.isoformat(),
        "updated_at": comment.updated_at.isoformat(),
        "edited_at": comment.edited_at.isoformat() if comment.edited_at else None,
        "resolved_at": comment.resolved_at.isoformat() if comment.resolved_at else None,
        "deleted_at": comment.deleted_at.isoformat() if comment.deleted_at else None,
    }
