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
from apps.trial_batches.api.cycle_scientist_views import (
    TrialBatchCycleCreateAndLinkBatchView,
    TrialBatchCycleFormulationVersionsView,
    TrialBatchCycleListView,
    TrialBatchCycleOpenNextSlotView,
    TrialBatchCycleTeamOverrideCloseView,
)

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
    # Trial-batch cycle scientist queue — active cycles + one-click
    # create-and-link-batch + open-next-slot + team-override-close.
    # Feeds the "Trial batches in flight" module on /samples.
    path(
        "organizations/<uuid:org_id>/trial-batch-cycles/",
        TrialBatchCycleListView.as_view(),
        name="trial-batch-cycles-list",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batch-cycles/<uuid:cycle_id>/slots/<uuid:slot_id>/create-and-link-batch/",
        TrialBatchCycleCreateAndLinkBatchView.as_view(),
        name="trial-batch-cycle-create-and-link-batch",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batch-cycles/<uuid:cycle_id>/open-next-slot/",
        TrialBatchCycleOpenNextSlotView.as_view(),
        name="trial-batch-cycle-open-next-slot",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batch-cycles/<uuid:cycle_id>/team-override-close/",
        TrialBatchCycleTeamOverrideCloseView.as_view(),
        name="trial-batch-cycle-team-override-close",
    ),
    path(
        "organizations/<uuid:org_id>/trial-batch-cycles/<uuid:cycle_id>/formulation-versions/",
        TrialBatchCycleFormulationVersionsView.as_view(),
        name="trial-batch-cycle-formulation-versions",
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
