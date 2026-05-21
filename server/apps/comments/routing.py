"""WebSocket URL routes for the comments app.

Mounted from :mod:`config.asgi` inside a
:class:`channels.routing.URLRouter`. The middleware stack wraps this
router so every consumer sees ``scope["user"]`` populated (or
``AnonymousUser`` when the JWT cookie is missing / invalid — the
consumer itself is then responsible for the 4401 close).
"""

from __future__ import annotations

from django.urls import re_path

from apps.comments.consumers import (
    CommentConsumer,
    PortalCommentConsumer,
    PublicCommentConsumer,
    UserInboxConsumer,
)


# URL structure mirrors the REST endpoints so the client can compute
# the WS URL from the entity id it already has on the page. Each
# ``<entity_kind>`` segment is constrained to the values that consumer
# accepts so a crafted path closes with ``CLOSE_BAD_TARGET`` at the
# consumer rather than landing in an unmatched route.
websocket_urlpatterns = [
    # Note: the staff consumer accepts ``proposal`` too — the regex
    # below mirrors what :class:`CommentConsumer.connect` will let
    # through after authorisation, so a staff URL with
    # ``entity_kind=proposal`` lands on the right consumer.
    re_path(
        r"^ws/org/(?P<org_id>[0-9a-fA-F-]{36})/"
        r"(?P<entity_kind>formulation|specification|proposal|cff_submission)/"
        r"(?P<entity_id>[0-9a-fA-F-]{36})/?$",
        CommentConsumer.as_asgi(),
        name="ws-comments-entity",
    ),
    # Per-user inbox firehose. Single socket per signed-in user,
    # receives a stream of ``inbox.message`` events whenever a new
    # comment lands on any thread the user has access to. Powers the
    # global messenger bell + dropdown.
    re_path(
        r"^ws/inbox/?$",
        UserInboxConsumer.as_asgi(),
        name="ws-inbox",
    ),
    # Kiosk (public / token-gated) route. Uses a signed session
    # cookie for auth — the middleware stamps it onto the scope and
    # the consumer validates it against the ``KioskSession`` row.
    re_path(
        r"^ws/public/specification/(?P<token>[0-9a-fA-F-]{36})/?$",
        PublicCommentConsumer.as_asgi(),
        name="ws-public-comments",
    ),
    # Customer portal route. Uses the ``vita_portal_access`` cookie
    # the middleware resolves to a :class:`ClientAccount`. The
    # consumer joins the SAME ``comments.<kind>.<entity_id>`` group
    # the staff route joins, so staff sees the customer's presence /
    # typing and vice versa. ``entity_kind`` is restricted to the
    # surfaces the portal actually exposes — proposals, specs, and
    # CFF intake threads (the customer can read + reply on the
    # request they originally submitted).
    re_path(
        r"^ws/portal/"
        r"(?P<entity_kind>proposal|specification|cff_submission)/"
        r"(?P<entity_id>[0-9a-fA-F-]{36})/?$",
        PortalCommentConsumer.as_asgi(),
        name="ws-portal-comments",
    ),
]
