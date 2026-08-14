"""WebSocket URL routes for the payments live feed.

Mounted from :mod:`config.asgi` inside the same
:class:`channels.routing.URLRouter` as the comments routes.
"""

from __future__ import annotations

from django.urls import re_path

from apps.payments.consumers import PaymentsFeedConsumer


websocket_urlpatterns = [
    re_path(
        r"^ws/org/(?P<org_id>[0-9a-fA-F-]{36})/payments/?$",
        PaymentsFeedConsumer.as_asgi(),
        name="ws-payments-feed",
    ),
]
