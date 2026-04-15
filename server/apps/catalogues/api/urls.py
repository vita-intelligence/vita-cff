"""URL routes for the catalogues API.

The slug pattern is a simple ``[a-z0-9_]+`` matcher: catalogue slugs
are machine identifiers in the same shape as Python attribute keys,
and we deliberately avoid hyphens so URLs stay aligned with the
identifier the backend uses in permission checks.
"""

from django.urls import path, re_path

from apps.catalogues.api.views import (
    CatalogueDetailView,
    CatalogueListCreateView,
    ItemDetailView,
    ItemImportView,
    ItemListCreateView,
)

app_name = "catalogues"

SLUG = r"(?P<slug>[a-z][a-z0-9_]{0,63})"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/catalogues/",
        CatalogueListCreateView.as_view(),
        name="catalogue-list",
    ),
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/$",
        CatalogueDetailView.as_view(),
        name="catalogue-detail",
    ),
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/items/$",
        ItemListCreateView.as_view(),
        name="item-list",
    ),
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/items/import/$",
        ItemImportView.as_view(),
        name="item-import",
    ),
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/items/(?P<item_id>[0-9a-f-]{{36}})/$",
        ItemDetailView.as_view(),
        name="item-detail",
    ),
]
