"""URL routes for the audit log API."""

from django.urls import path

from apps.audit.api.views import AuditLogListView


app_name = "audit"


urlpatterns = [
    path(
        "organizations/<uuid:org_id>/audit-log/",
        AuditLogListView.as_view(),
        name="audit-log-list",
    ),
]
