"""Root URL configuration for the Vita NPD platform."""

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.http import JsonResponse
from django.urls import include, path


def _healthz(_request):
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("healthz/", _healthz, name="healthz"),
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
    path(
        "api/",
        include("apps.proposals.api.urls", namespace="proposals"),
    ),
    path(
        "api/",
        include("apps.customers.api.urls", namespace="customers"),
    ),
    path("api/", include("apps.ai.api.urls", namespace="ai")),
    path("api/", include("apps.audit.api.urls", namespace="audit")),
    path("api/", include("apps.comments.api.urls", namespace="comments")),
    path(
        "api/",
        include("apps.cff_submissions.api.urls", namespace="cff_submissions"),
    ),
    path(
        "api/portal/",
        include("apps.client_portal.api.urls", namespace="client_portal"),
    ),
    path("api/", include("apps.payments.api.urls", namespace="payments")),
    path(
        "api/",
        include("apps.label_design.api.urls", namespace="label_design"),
    ),
]


# ``MEDIA_URL`` is served by Django itself only when ``DEBUG`` is
# True. In production, ``django-storages`` returns full Azure Blob
# URLs from every ``FileField.url`` — the browser hits Azure
# directly so Django never serves a media file. The dev-only
# helper below uses Django's built-in static-file view to serve
# ``MEDIA_ROOT`` over HTTP so the Next.js ``/media/*`` rewrite
# can reach uploaded artwork without an Azure account on the
# developer's laptop.
if settings.DEBUG:
    urlpatterns += static(
        settings.MEDIA_URL, document_root=settings.MEDIA_ROOT
    )
