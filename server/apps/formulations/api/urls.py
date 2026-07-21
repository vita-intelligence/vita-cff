"""URL routes for the formulations API."""

from django.urls import path

from apps.formulations.api.rd_pipeline_views import (
    RDPipelineBoardView,
    RDPipelineColumnView,
)
from apps.formulations.api.photo_file_views import (
    FormulationFileDetailView,
    FormulationFilesView,
    FormulationPhotoDetailView,
    FormulationPhotosView,
)
from apps.formulations.api.views import (
    FormulationApplyStageTemplateView,
    FormulationApprovedVersionView,
    FormulationCloneView,
    FormulationComputeView,
    FormulationDetailView,
    FormulationLeadScientistView,
    FormulationLinesView,
    FormulationListCreateView,
    FormulationOverviewView,
    FormulationPullPspBomView,
    FormulationRollbackView,
    FormulationSyncPspView,
    FormulationRTGPublishView,
    FormulationSalesPersonView,
    FormulationStagesView,
    FormulationVersionListView,
    FormulationWizardRoutingView,
    StageTemplateDetailView,
    StageTemplateListView,
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
    # Wizard step 3 — persist per-ingredient stage routing (actives
    # + materialised band picks) so the PSP push cascade reads each
    # stage's real BOM from the ORM instead of an FE override.
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/wizard-routing/",
        FormulationWizardRoutingView.as_view(),
        name="formulation-wizard-routing",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/sync-psp/",
        FormulationSyncPspView.as_view(),
        name="formulation-sync-psp",
    ),
    # Hydrate the finished-stage BOM from PSP's primary BOM (PSP as
    # source of truth). Auto-snapshots the pre-pull state so a
    # mis-click is recoverable from the version drawer.
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/pull-psp-bom/",
        FormulationPullPspBomView.as_view(),
        name="formulation-pull-psp-bom",
    ),
    # Stage templates — org-owned reusable stage graphs. List drives
    # the New-formulation dropdown + Stages tab picker; apply
    # wholesale-replaces the formulation's stages with the template's
    # payload.
    path(
        "organizations/<uuid:org_id>/formulation-stage-templates/",
        StageTemplateListView.as_view(),
        name="stage-template-list",
    ),
    path(
        "organizations/<uuid:org_id>/formulation-stage-templates/<uuid:template_id>/",
        StageTemplateDetailView.as_view(),
        name="stage-template-detail",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/apply-stage-template/",
        FormulationApplyStageTemplateView.as_view(),
        name="formulation-apply-stage-template",
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
    # Photos + files. Bytes live on NPD storage; the push cascade
    # mirrors them onto the finished-product PSP item best-effort.
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/photos/",
        FormulationPhotosView.as_view(),
        name="formulation-photos",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/photos/<uuid:photo_id>/",
        FormulationPhotoDetailView.as_view(),
        name="formulation-photo-detail",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/files/",
        FormulationFilesView.as_view(),
        name="formulation-files",
    ),
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/files/<uuid:file_id>/",
        FormulationFileDetailView.as_view(),
        name="formulation-file-detail",
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
