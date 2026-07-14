"""URL routes for the PSP integration API."""

from django.urls import path

from apps.psp.api.views import (
    PspIntegrationView,
    PspItemDetailView,
    PspItemListView,
    PspTestConnectionView,
)


app_name = "psp"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/integrations/psp/",
        PspIntegrationView.as_view(),
        name="psp-integration",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/test/",
        PspTestConnectionView.as_view(),
        name="psp-test",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/",
        PspItemListView.as_view(),
        name="psp-items",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/<uuid:item_uuid>/",
        PspItemDetailView.as_view(),
        name="psp-item-detail",
    ),
]
