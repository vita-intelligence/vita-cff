"""WebSocket URL routes for the org-scoped live feed.

Mounted from :mod:`config.asgi` inside the same URLRouter as the
comments + payments routes. The payments-specific
``ws/org/<uuid>/payments/`` route was retired in favour of the
generic ``ws/org/<uuid>/feed/`` — payment mutations now broadcast
through :func:`apps.organizations.live.schedule_org_broadcast` like
every other entity.
"""

from __future__ import annotations

from django.urls import re_path

from apps.organizations.consumers import OrgFeedConsumer


websocket_urlpatterns = [
    re_path(
        r"^ws/org/(?P<org_id>[0-9a-fA-F-]{36})/feed/?$",
        OrgFeedConsumer.as_asgi(),
        name="ws-org-feed",
    ),
]
