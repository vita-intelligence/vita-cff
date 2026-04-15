"""URL routes for the attributes API."""

from django.urls import re_path

from apps.attributes.api.views import (
    AttributeDefinitionDetailView,
    AttributeDefinitionListCreateView,
)

app_name = "attributes"

SLUG = r"(?P<slug>[a-z][a-z0-9_]{0,63})"

urlpatterns = [
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/attributes/$",
        AttributeDefinitionListCreateView.as_view(),
        name="attribute-definition-list",
    ),
    re_path(
        rf"^organizations/(?P<org_id>[0-9a-f-]{{36}})/catalogues/{SLUG}/attributes/(?P<definition_id>[0-9a-f-]{{36}})/$",
        AttributeDefinitionDetailView.as_view(),
        name="attribute-definition-detail",
    ),
]
