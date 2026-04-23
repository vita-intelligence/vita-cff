"""URL routes for the customers API."""

from django.urls import path

from apps.customers.api.views import (
    CustomerDetailView,
    CustomerListCreateView,
)

app_name = "customers"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/customers/",
        CustomerListCreateView.as_view(),
        name="customer-list",
    ),
    path(
        "organizations/<uuid:org_id>/customers/<uuid:customer_id>/",
        CustomerDetailView.as_view(),
        name="customer-detail",
    ),
]
