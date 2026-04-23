"""URL routes for the formulations API."""

from django.urls import path

from apps.formulations.api.views import (
    FormulationApprovedVersionView,
    FormulationComputeView,
    FormulationDetailView,
    FormulationLinesView,
    FormulationListCreateView,
    FormulationOverviewView,
    FormulationRollbackView,
    FormulationSalesPersonView,
    FormulationVersionListView,
)

app_name = "formulations"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/formulations/",
        FormulationListCreateView.as_view(),
        name="formulation-list",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/",
        FormulationDetailView.as_view(),
        name="formulation-detail",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/lines/",
        FormulationLinesView.as_view(),
        name="formulation-lines",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/compute/",
        FormulationComputeView.as_view(),
        name="formulation-compute",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/overview/",
        FormulationOverviewView.as_view(),
        name="formulation-overview",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/versions/",
        FormulationVersionListView.as_view(),
        name="formulation-versions",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/rollback/",
        FormulationRollbackView.as_view(),
        name="formulation-rollback",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/sales-person/",
        FormulationSalesPersonView.as_view(),
        name="formulation-sales-person",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/approved-version/",
        FormulationApprovedVersionView.as_view(),
        name="formulation-approved-version",
    ),
]
