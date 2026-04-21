"""WebSocket URL routes for the comments app.

Mounted from :mod:`config.asgi` inside a
:class:`channels.routing.URLRouter`. The middleware stack wraps this
router so every consumer sees ``scope["user"]`` populated (or
``AnonymousUser`` when the JWT cookie is missing / invalid — the
consumer itself is then responsible for the 4401 close).
"""

from __future__ import annotations

from django.urls import re_path

from apps.comments.consumers import CommentConsumer, PublicCommentConsumer


# URL structure mirrors the REST endpoints so the client can compute
# the WS URL from the entity id it already has on the page. The
# ``<entity_kind>`` segment is constrained to the two supported values
# so any other path closes with ``CLOSE_BAD_TARGET`` at the consumer
# rather than landing in an unmatched route.
websocket_urlpatterns = [
    re_path(
        r"^ws/org/(?P<org_id>[0-9a-fA-F-]{36})/"
        r"(?P<entity_kind>formulation|specification)/"
        r"(?P<entity_id>[0-9a-fA-F-]{36})/?$",
        CommentConsumer.as_asgi(),
        name="ws-comments-entity",
    ),
    # Kiosk (public / token-gated) route. Uses a signed session
    # cookie for auth — the middleware stamps it onto the scope and
    # the consumer validates it against the ``KioskSession`` row.
    re_path(
        r"^ws/public/specification/(?P<token>[0-9a-fA-F-]{36})/?$",
        PublicCommentConsumer.as_asgi(),
        name="ws-public-comments",
    ),
]
