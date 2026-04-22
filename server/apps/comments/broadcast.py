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
