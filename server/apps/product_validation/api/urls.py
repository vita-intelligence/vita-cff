"""URL routes for the product-validation API."""

from django.urls import path

from apps.product_validation.api.views import (
    ValidationDetailView,
    ValidationForBatchView,
    ValidationListCreateView,
    ValidationStatsView,
    ValidationStatusView,
)

app_name = "product_validation"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/product-validations/",
        ValidationListCreateView.as_view(),
        name="validation-list",
    ),
    path(
        "organizations/<uuid:org_id>/product-validations/<uuid:validation_id>/",
        ValidationDetailView.as_view(),
        name="validation-detail",
    ),
    path(
        "organizations/<uuid:org_id>/product-validations/<uuid:validation_id>/stats/",
        ValidationStatsView.as_view(),
        name="validation-stats",
    ),
    path(
        "organizations/<uuid:org_id>/product-validations/<uuid:validation_id>/status/",
        ValidationStatusView.as_view(),
        name="validation-status",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/validation/",
        ValidationForBatchView.as_view(),
        name="validation-for-batch",
    ),
]
