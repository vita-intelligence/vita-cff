"""URL routes for the trial-batches API."""

from django.urls import path

from apps.trial_batches.api.views import (
    TrialBatchBOMExportView,
    TrialBatchDetailView,
    TrialBatchListCreateView,
    TrialBatchRenderView,
)

app_name = "trial_batches"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/trial-batches/",
        TrialBatchListCreateView.as_view(),
        name="trial-batch-list",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/",
        TrialBatchDetailView.as_view(),
        name="trial-batch-detail",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/render/",
        TrialBatchRenderView.as_view(),
        name="trial-batch-render",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/bom/",
        TrialBatchBOMExportView.as_view(),
        name="trial-batch-bom",
    ),
]
