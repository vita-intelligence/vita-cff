"""Root URL configuration for the Vita NPD platform."""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("apps.accounts.api.urls", namespace="accounts")),
    path(
        "api/",
        include("apps.organizations.api.urls", namespace="organizations"),
    ),
    path("api/", include("apps.catalogues.api.urls", namespace="catalogues")),
    path("api/", include("apps.attributes.api.urls", namespace="attributes")),
    path(
        "api/",
        include("apps.formulations.api.urls", namespace="formulations"),
    ),
    path(
        "api/",
        include("apps.specifications.api.urls", namespace="specifications"),
    ),
    path(
        "api/",
        include("apps.trial_batches.api.urls", namespace="trial_batches"),
    ),
    path(
        "api/",
        include(
            "apps.product_validation.api.urls",
            namespace="product_validation",
        ),
    ),
    path("api/", include("apps.ai.api.urls", namespace="ai")),
]
