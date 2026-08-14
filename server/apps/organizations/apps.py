from django.apps import AppConfig


class OrganizationsConfig(AppConfig):
    name = "apps.organizations"
    label = "organizations"
    verbose_name = "Organizations"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self) -> None:
        # Wire post_save / post_delete signals into the org live
        # feed so any mutation on the six participating models
        # (CFF / project / proposal / trial batch / label design /
        # specification) fans out to every open staff tab. See
        # :mod:`apps.organizations.live_signals` for the full
        # rationale + why Payment is excluded from the signal map.
        from apps.organizations.live_signals import connect_live_signals
        connect_live_signals()
