from django.apps import AppConfig


class PaymentsConfig(AppConfig):
    name = "apps.payments"
    label = "payments"
    verbose_name = "Payments"
    default_auto_field = "django.db.models.BigAutoField"
