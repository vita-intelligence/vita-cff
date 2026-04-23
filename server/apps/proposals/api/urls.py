"""URL routes for the proposals API."""

from django.urls import path

from apps.proposals.api.views import (
    ProposalCostPreviewView,
    ProposalDetailView,
    ProposalDocxView,
    ProposalLineDetailView,
    ProposalLineListCreateView,
    ProposalListCreateView,
    ProposalRenderView,
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
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/docx/",
        ProposalDocxView.as_view(),
        name="proposal-docx",
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
]
