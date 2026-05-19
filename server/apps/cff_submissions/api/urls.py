"""URL routes for the CFF submissions API."""

from django.urls import path

from .views import (
    CFFAssignView,
    CFFCreateProjectView,
    CFFDetailView,
    CFFFieldLabelsView,
    CFFListView,
    CFFSyncStatusView,
    CFFUnassignView,
    WixCFFIntegrationView,
    WixCFFTestConnectionView,
)

app_name = "cff_submissions"


urlpatterns = [
    # String-segment endpoints MUST come before the ``<uuid:submission_id>/``
    # detail route, or Django would try to parse the literal strings
    # ``field-labels`` / ``sync-status`` as UUIDs and fail.
    path(
        "organizations/<uuid:org_id>/cff-submissions/field-labels/",
        CFFFieldLabelsView.as_view(),
        name="field-labels",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/sync-status/",
        CFFSyncStatusView.as_view(),
        name="sync-status",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/",
        CFFListView.as_view(),
        name="list",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/<uuid:submission_id>/",
        CFFDetailView.as_view(),
        name="detail",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/<uuid:submission_id>/assign/",
        CFFAssignView.as_view(),
        name="assign",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/<uuid:submission_id>/unassign/",
        CFFUnassignView.as_view(),
        name="unassign",
    ),
    path(
        "organizations/<uuid:org_id>/cff-submissions/<uuid:submission_id>/create-project/",
        CFFCreateProjectView.as_view(),
        name="create-project",
    ),
    # Integration settings — owner-only.
    path(
        "organizations/<uuid:org_id>/integrations/wix-cff/",
        WixCFFIntegrationView.as_view(),
        name="integration",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/wix-cff/test/",
        WixCFFTestConnectionView.as_view(),
        name="integration-test",
    ),
]
