"""URL routes for the trial-batches API."""

from django.urls import path

from apps.trial_batches.api.views import (
    TrialBatchBOMExportView,
    TrialBatchCreatePspMoView,
    TrialBatchDetailView,
    TrialBatchListCreateView,
    TrialBatchPspMoBookingsView,
    TrialBatchPspMoChainView,
    TrialBatchRenderView,
)
from apps.trial_batches.api.samples_views import PendingSamplePaymentsView

app_name = "trial_batches"

urlpatterns = [
    # R&D Samples fulfilment queue — approved sample Payments not
    # yet turned into a TrialBatch. Feeds the /samples page under
    # the R&D nav group.
    path(
        "organizations/<uuid:org_id>/samples/pending/",
        PendingSamplePaymentsView.as_view(),
        name="pending-sample-payments",
    ),
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
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/create-psp-mo/",
        TrialBatchCreatePspMoView.as_view(),
        name="trial-batch-create-psp-mo",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/psp-mo-bookings/",
        TrialBatchPspMoBookingsView.as_view(),
        name="trial-batch-psp-mo-bookings",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batches/<uuid:batch_id>/psp-mo-chain/",
        TrialBatchPspMoChainView.as_view(),
        name="trial-batch-psp-mo-chain",
    ),
]
