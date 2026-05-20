"""URL routes for the client portal API."""

from __future__ import annotations

from django.urls import path

from .views import (
    ActivationPreviewView,
    ActivationView,
    LoginView,
    LogoutView,
    MeView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    ProposalDetailView,
    ProposalDownloadView,
    ProposalFinalizeView,
    ProposalListView,
    ProposalPdfView,
    ProposalRejectView,
    ProposalSignSpecView,
    ProposalSignView,
)


app_name = "client_portal"


urlpatterns = [
    # Activation (cookie-issuing — public). Same path for GET preview
    # and POST submit so the activation page is a single resource.
    path(
        "activate/<str:token>/",
        ActivationView.as_view(),
        name="activate-submit",
    ),
    path(
        "activate/<str:token>/preview/",
        ActivationPreviewView.as_view(),
        name="activate-preview",
    ),

    # Auth (cookie-issuing / clearing — public).
    path("auth/login/", LoginView.as_view(), name="login"),
    path("auth/logout/", LogoutView.as_view(), name="logout"),
    path(
        "auth/password-reset/request/",
        PasswordResetRequestView.as_view(),
        name="password-reset-request",
    ),
    path(
        "auth/password-reset/confirm/",
        PasswordResetConfirmView.as_view(),
        name="password-reset-confirm",
    ),

    # Authenticated identity + dashboard.
    path("auth/me/", MeView.as_view(), name="me"),
    path("proposals/", ProposalListView.as_view(), name="proposal-list"),
    path(
        "proposals/<uuid:proposal_id>/",
        ProposalDetailView.as_view(),
        name="proposal-detail",
    ),
    path(
        "proposals/<uuid:proposal_id>/pdf/",
        ProposalPdfView.as_view(),
        name="proposal-pdf",
    ),
    path(
        "proposals/<uuid:proposal_id>/download/",
        ProposalDownloadView.as_view(),
        name="proposal-download",
    ),
    path(
        "proposals/<uuid:proposal_id>/sign/",
        ProposalSignView.as_view(),
        name="proposal-sign",
    ),
    path(
        "proposals/<uuid:proposal_id>/specs/<uuid:sheet_id>/sign/",
        ProposalSignSpecView.as_view(),
        name="proposal-spec-sign",
    ),
    path(
        "proposals/<uuid:proposal_id>/reject/",
        ProposalRejectView.as_view(),
        name="proposal-reject",
    ),
    path(
        "proposals/<uuid:proposal_id>/finalize/",
        ProposalFinalizeView.as_view(),
        name="proposal-finalize",
    ),
]
