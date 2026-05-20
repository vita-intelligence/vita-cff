"""URL routes for the client portal API."""

from __future__ import annotations

from django.urls import path

from .messaging_views import (
    ProposalMessagesView,
    SpecMessagePostView,
    SpecMessageReadView,
)
from .profile_views import (
    AvatarView,
    EmailChangeConfirmView,
    EmailChangeRequestView,
    PasswordChangeView,
    ProfileView,
)
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

    # Profile / settings.
    path("profile/", ProfileView.as_view(), name="profile"),
    path(
        "profile/email/request/",
        EmailChangeRequestView.as_view(),
        name="profile-email-request",
    ),
    path(
        "profile/email/confirm/",
        EmailChangeConfirmView.as_view(),
        name="profile-email-confirm",
    ),
    path(
        "profile/password/",
        PasswordChangeView.as_view(),
        name="profile-password",
    ),
    path(
        "profile/avatar/",
        AvatarView.as_view(),
        name="profile-avatar",
    ),

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

    # Messaging — per-spec shared comments. Project-level threads
    # are read-only from the portal for now (they surface only
    # when staff toggles the comment to ``shared`` from the staff
    # comments bubble); the GET on the proposal endpoint includes
    # them when present.
    path(
        "proposals/<uuid:proposal_id>/messages/",
        ProposalMessagesView.as_view(),
        name="proposal-messages",
    ),
    path(
        "specs/<uuid:sheet_id>/messages/",
        SpecMessagePostView.as_view(),
        name="spec-message-post",
    ),
    path(
        "specs/<uuid:sheet_id>/messages/read/",
        SpecMessageReadView.as_view(),
        name="spec-message-read",
    ),
]
