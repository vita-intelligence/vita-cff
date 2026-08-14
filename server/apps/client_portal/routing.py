"""WebSocket URL routes for the portal live feed.

Mounted from :mod:`config.asgi` alongside the org + comments routes.
"""

from __future__ import annotations

from django.urls import re_path

from apps.client_portal.consumers import PortalFeedConsumer


websocket_urlpatterns = [
    re_path(
        r"^ws/portal/feed/?$",
        PortalFeedConsumer.as_asgi(),
        name="ws-portal-feed",
    ),
]
