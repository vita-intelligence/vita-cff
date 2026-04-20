"""URL routes for the specifications API."""

from django.urls import path

from apps.specifications.api.views import (
    PublicSpecificationPdfView,
    PublicSpecificationRenderView,
    SpecificationDetailView,
    SpecificationListCreateView,
    SpecificationPackagingOptionsView,
    SpecificationPackagingView,
    SpecificationPdfView,
    SpecificationPublicLinkView,
    SpecificationRenderView,
    SpecificationStatusView,
    SpecificationVisibilityView,
)

app_name = "specifications"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/specifications/",
        SpecificationListCreateView.as_view(),
        name="specification-list",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/packaging-options/",
        SpecificationPackagingOptionsView.as_view(),
        name="specification-packaging-options",
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
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/pdf/",
        SpecificationPdfView.as_view(),
        name="specification-pdf",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/packaging/",
        SpecificationPackagingView.as_view(),
        name="specification-packaging",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/public-link/",
        SpecificationPublicLinkView.as_view(),
        name="specification-public-link",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/status/",
        SpecificationStatusView.as_view(),
        name="specification-status",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/visibility/",
        SpecificationVisibilityView.as_view(),
        name="specification-visibility",
    ),
    # Unauthenticated preview endpoints — gated by an opaque UUID
    # token rather than the org/sheet id so neither leaks on the wire.
    path(
        "public/specifications/<uuid:token>/",
        PublicSpecificationRenderView.as_view(),
        name="public-specification-render",
    ),
    path(
        "public/specifications/<uuid:token>/pdf/",
        PublicSpecificationPdfView.as_view(),
        name="public-specification-pdf",
    ),
]
