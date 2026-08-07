"""URL routes for the Website integration API."""

from django.urls import path

from apps.website.api.views import (
    WebsiteAccessTokenListCreateView,
    WebsiteAccessTokenRevokeView,
    WebsiteRTGCatalogDetailView,
    WebsiteRTGCatalogView,
)


app_name = "website"

urlpatterns = [
    # Settings CRUD — owner-only.
    path(
        "organizations/<uuid:org_id>/integrations/website-access-tokens/",
        WebsiteAccessTokenListCreateView.as_view(),
        name="access-tokens",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/website-access-tokens/"
        "<uuid:token_id>/revoke/",
        WebsiteAccessTokenRevokeView.as_view(),
        name="access-token-revoke",
    ),
    # Public reads — token-authed, no org UUID in the URL because
    # the token itself scopes the response.
    path(
        "website/rtg-catalog/",
        WebsiteRTGCatalogView.as_view(),
        name="rtg-catalog",
    ),
    path(
        "website/rtg-catalog/<slug:slug>/",
        WebsiteRTGCatalogDetailView.as_view(),
        name="rtg-catalog-detail",
    ),
]
