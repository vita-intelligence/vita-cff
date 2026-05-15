from django.apps import AppConfig


class SpecificationsConfig(AppConfig):
    name = "apps.specifications"
    label = "specifications"
    verbose_name = "Specifications"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Import-by-side-effect: the signal receivers register
        # themselves at import time via the ``@receiver`` decorator.
        # ``ready`` is the canonical place to do this — earlier
        # entry points (module import in ``__init__``) can race
        # against Django's app registry and crash on
        # ``apps not ready`` errors when the signal touches a
        # model.
        from apps.specifications import signals  # noqa: F401
