from django.apps import AppConfig


class LabelDesignConfig(AppConfig):
    name = "apps.label_design"
    label = "label_design"
    verbose_name = "Label design"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Import-by-side-effect: signal receivers self-register at
        # import time. Match the pattern in apps/specifications/apps.py
        # so the workflow lifecycle bootstrap stays decoupled from the
        # caller that flipped Formulation.status to APPROVED.
        from apps.label_design import signals  # noqa: F401
