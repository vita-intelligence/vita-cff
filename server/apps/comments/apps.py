from django.apps import AppConfig


class CommentsConfig(AppConfig):
    name = "apps.comments"
    label = "comments"
    verbose_name = "Comments"
    default_auto_field = "django.db.models.BigAutoField"
