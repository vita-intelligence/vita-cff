"""URL routes for the specifications API."""

from django.urls import path

from apps.specifications.api.views import (
    SpecificationDetailView,
    SpecificationListCreateView,
    SpecificationRenderView,
    SpecificationStatusView,
)

app_name = "specifications"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/specifications/",
        SpecificationListCreateView.as_view(),
        name="specification-list",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/",
        SpecificationDetailView.as_view(),
        name="specification-detail",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/render/",
        SpecificationRenderView.as_view(),
        name="specification-render",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/status/",
        SpecificationStatusView.as_view(),
        name="specification-status",
    ),
]
