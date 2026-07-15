"""URL routes for the formulations API."""

from django.urls import path

from apps.formulations.api.rd_pipeline_views import (
    RDPipelineBoardView,
    RDPipelineColumnView,
)
from apps.formulations.api.views import (
    FormulationApprovedVersionView,
    FormulationCloneView,
    FormulationComputeView,
    FormulationDetailView,
    FormulationLeadScientistView,
    FormulationLinesView,
    FormulationListCreateView,
    FormulationOverviewView,
    FormulationRollbackView,
    FormulationRTGPublishView,
    FormulationSalesPersonView,
    FormulationStagesView,
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
    # Stage builder — wholesale-replace endpoint. Payload:
    # ``{"stages": [{id?, sort_order, name, stage_key,
    # workstation_group_uuid?, ...}]}``.
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/stages/",
        FormulationStagesView.as_view(),
        name="formulation-stages",
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
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/lead-scientist/",
        FormulationLeadScientistView.as_view(),
        name="formulation-lead-scientist",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/approved-version/",
        FormulationApprovedVersionView.as_view(),
        name="formulation-approved-version",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/clone/",
        FormulationCloneView.as_view(),
        name="formulation-clone",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/rtg-publish/",
        FormulationRTGPublishView.as_view(),
        name="formulation-rtg-publish",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/rd-pipeline/",
        RDPipelineBoardView.as_view(),
        name="formulation-rd-pipeline",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/rd-pipeline/<str:stage>/",
        RDPipelineColumnView.as_view(),
        name="formulation-rd-pipeline-column",
    ),
]
