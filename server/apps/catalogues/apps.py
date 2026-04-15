from django.apps import AppConfig


class CataloguesConfig(AppConfig):
    name = "apps.catalogues"
    label = "catalogues"
    verbose_name = "Catalogues"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Import the signal handlers so newly-created organizations
        # receive their seeded system catalogues automatically.
        from apps.catalogues import signals  # noqa: F401
