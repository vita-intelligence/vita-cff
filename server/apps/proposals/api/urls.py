"""URL routes for the proposals API."""

from django.urls import path

from apps.proposals.api.mrpeasy_views import (
    MrpeasyIntegrationView,
    MrpeasyItemListView,
    MrpeasyPriceLookupView,
    MrpeasyTestConnectionView,
)
from apps.proposals.api.views import (
    ProposalAuditView,
    ProposalCompleteRequiredFieldsView,
    ProposalCostPreviewView,
    ProposalDetailView,
    ProposalLineDetailView,
    ProposalLineListCreateView,
    ProposalListCreateView,
    ProposalPdfDownloadView,
    ProposalRenderView,
    ProposalSendTestEmailView,
    ProposalSendToClientView,
    ProposalStatusView,
    ProposalTransitionsView,
)

app_name = "proposals"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/proposals/",
        ProposalListCreateView.as_view(),
        name="proposal-list",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/",
        ProposalDetailView.as_view(),
        name="proposal-detail",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/status/",
        ProposalStatusView.as_view(),
        name="proposal-status",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/complete-required-fields/",
        ProposalCompleteRequiredFieldsView.as_view(),
        name="proposal-complete-required-fields",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/send-to-client/",
        ProposalSendToClientView.as_view(),
        name="proposal-send-to-client",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/send-test-email/",
        ProposalSendTestEmailView.as_view(),
        name="proposal-send-test-email",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/transitions/",
        ProposalTransitionsView.as_view(),
        name="proposal-transitions",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/render/",
        ProposalRenderView.as_view(),
        name="proposal-render",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/download/",
        ProposalPdfDownloadView.as_view(),
        name="proposal-pdf-download",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/audit/",
        ProposalAuditView.as_view(),
        name="proposal-audit",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/lines/",
        ProposalLineListCreateView.as_view(),
        name="proposal-line-list",
    ),
    path(
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/lines/<uuid:line_id>/",
        ProposalLineDetailView.as_view(),
        name="proposal-line-detail",
    ),
    path(
        "organizations/<uuid:org_id>/formulation-versions/<uuid:version_id>/cost-preview/",
        ProposalCostPreviewView.as_view(),
        name="proposal-cost-preview",
    ),
    # The legacy anonymous kiosk routes (``public/proposals/<token>/*``)
    # were removed when the customer portal landed. Customer access now
    # flows through ``apps.client_portal`` — view + sign + reject +
    # finalize live behind authenticated portal sessions. The
    # ``PublicProposal*View`` classes remain in
    # :mod:`apps.proposals.api.views` because their rendering helpers
    # (``_render_public_proposal_payload``, ``_canonical_proposal_payload``,
    # ``_document_hash``) are imported by the portal views; the views
    # themselves are no longer routed.
    # MRPEasy integration. Same ``<org_id>/integrations/<name>/``
    # URL shape the Dynamics integration uses so the settings page
    # and any future integration follow a single discoverable
    # pattern.
    path(
        "organizations/<uuid:org_id>/integrations/mrpeasy/",
        MrpeasyIntegrationView.as_view(),
        name="mrpeasy-integration",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/mrpeasy/test/",
        MrpeasyTestConnectionView.as_view(),
        name="mrpeasy-test",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/mrpeasy/lookup/",
        MrpeasyPriceLookupView.as_view(),
        name="mrpeasy-lookup",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/mrpeasy/items/",
        MrpeasyItemListView.as_view(),
        name="mrpeasy-items",
    ),
]
