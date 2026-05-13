"""URL routes for the customers API."""

from django.urls import path

from apps.customers.api.views import (
    CustomerDetailView,
    CustomerListCreateView,
    DynamicsCustomerImportView,
    DynamicsCustomerSearchView,
    DynamicsIntegrationView,
    DynamicsTestConnectionView,
)

app_name = "customers"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/customers/",
        CustomerListCreateView.as_view(),
        name="customer-list",
    ),
    # The import-from-dynamics route MUST sit before the
    # ``<uuid:customer_id>/`` route or Django's URL resolver would
    # try to parse the literal string ``import-from-dynamics`` as a
    # UUID and fail with a 404.
    path(
        "organizations/<uuid:org_id>/customers/import-from-dynamics/",
        DynamicsCustomerImportView.as_view(),
        name="customer-dynamics-import",
    ),
    path(
        "organizations/<uuid:org_id>/customers/<uuid:customer_id>/",
        CustomerDetailView.as_view(),
        name="customer-detail",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/dynamics/",
        DynamicsIntegrationView.as_view(),
        name="dynamics-integration",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/dynamics/test/",
        DynamicsTestConnectionView.as_view(),
        name="dynamics-integration-test",
    ),
    path(
        "organizations/<uuid:org_id>/dynamics/customers/search/",
        DynamicsCustomerSearchView.as_view(),
        name="dynamics-customer-search",
    ),
]
