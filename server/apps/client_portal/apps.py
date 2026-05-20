"""App config for the client portal."""

from __future__ import annotations

from django.apps import AppConfig


class ClientPortalConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.client_portal"
    verbose_name = "Client portal"
