"""ASGI entrypoint for the Vita NPD platform.

Shape:

* ``http`` connections flow into Django's normal ASGI application
  — same middleware stack, same URL conf. The REST API is
  unaffected by the presence of Channels; it still runs under
  ``config.wsgi.application`` whenever the process is invoked via a
  pure WSGI server, and under :func:`get_asgi_application` when
  Daphne / Uvicorn hosts the app.

* ``websocket`` connections go through Channels. The
  :class:`CookieJWTAuthMiddleware` resolves ``scope["user"]`` from
  the same ``vita_access`` cookie the REST layer reads; consumers
  decide whether to accept or close based on that user + per-route
  authorisation.

Routing module lives in :mod:`apps.comments.routing`. When a second
feature adds WS routes we concatenate the pattern lists here rather
than introducing another URL router per app.
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

# Django's ``get_asgi_application()`` performs the app registry
# population step. Call it BEFORE importing anything that touches
# Django models — Channels' ``URLRouter`` is safe to import afterwards.
django_asgi_app = get_asgi_application()

# Deferred imports — must follow ``get_asgi_application()`` so the app
# registry is ready when the routing module reaches for model classes.
from apps.comments.middleware import CookieJWTAuthMiddleware  # noqa: E402
from apps.comments.routing import websocket_urlpatterns as comments_ws_urls  # noqa: E402


application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": CookieJWTAuthMiddleware(
            URLRouter(comments_ws_urls),
        ),
    }
)
