"""URL routes for the client portal API."""

from __future__ import annotations

from django.urls import path

from .cff_views import (
    PortalCFFDetailView,
    PortalCFFListView,
    PortalCFFMessagesReadView,
    PortalCFFMessagesView,
)
from .inbox_views import (
    PortalInboxListView,
    PortalInboxUnreadCountView,
)
from .invite_views import (
    InviteActivateView,
    InvitePreviewView,
)
from .messaging_views import (
    ProposalChatListView,
    ProposalChatPostView,
    ProposalChatReadView,
    ProposalMessagesView,
    SpecMessageReadView,
    SpecMessageThreadView,
)
from .specs_views import (
    SpecDetailView,
    SpecListView,
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

    # Customer-portal invites — staff issues these from the customers
    # page (see :class:`apps.customers.api.views.CustomerPortalInviteView`)
    # and the customer redeems on this pair. Same shape as the kiosk
    # activate endpoints above so the FE can route both through one
    # post-activation handler.
    path(
        "invites/<str:token>/preview/",
        InvitePreviewView.as_view(),
        name="invite-preview",
    ),
    path(
        "invites/<str:token>/activate/",
        InviteActivateView.as_view(),
        name="invite-activate",
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

    # Inbox / bell — every thread the client account can see plus
    # a total-unread count. List shape matches the staff inbox so
    # the FE rendering is symmetric.
    path("inbox/", PortalInboxListView.as_view(), name="inbox-list"),
    path(
        "inbox/unread_count/",
        PortalInboxUnreadCountView.as_view(),
        name="inbox-unread-count",
    ),

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
    # Both ``GET`` (list comments) and ``POST`` (create comment)
    # share this URL. The standalone spec page fetches via GET;
    # the existing customer-portal tests + spec chat panel post
    # to the same URL.
    path(
        "specs/<uuid:sheet_id>/messages/",
        SpecMessageThreadView.as_view(),
        name="spec-message-thread",
    ),
    path(
        "specs/<uuid:sheet_id>/messages/read/",
        SpecMessageReadView.as_view(),
        name="spec-message-read",
    ),

    # Standalone specs surface — list + detail.
    path("specs/", SpecListView.as_view(), name="spec-list"),
    path(
        "specs/<uuid:sheet_id>/",
        SpecDetailView.as_view(),
        name="spec-detail",
    ),

    # Proposal-level chat — distinct from the per-spec threads
    # above so a proposal's "questions about this deal" don't
    # pile into a single spec's conversation.
    path(
        "proposals/<uuid:proposal_id>/proposal-messages/",
        ProposalChatListView.as_view(),
        name="proposal-chat-list",
    ),
    path(
        "proposals/<uuid:proposal_id>/proposal-messages/post/",
        ProposalChatPostView.as_view(),
        name="proposal-chat-post",
    ),
    path(
        "proposals/<uuid:proposal_id>/proposal-messages/read/",
        ProposalChatReadView.as_view(),
        name="proposal-chat-read",
    ),

    # CFF (Custom Formulation Request) — customer-facing intake
    # surface. The customer sees CFFs they own (email match OR
    # project link via :func:`apps.cff_submissions.services
    # .list_customer_cffs`) plus a shared comment thread on each
    # so they can follow up on the request they submitted.
    path("cffs/", PortalCFFListView.as_view(), name="cff-list"),
    path(
        "cffs/<uuid:submission_id>/",
        PortalCFFDetailView.as_view(),
        name="cff-detail",
    ),
    path(
        "cffs/<uuid:submission_id>/messages/",
        PortalCFFMessagesView.as_view(),
        name="cff-messages",
    ),
    path(
        "cffs/<uuid:submission_id>/messages/read/",
        PortalCFFMessagesReadView.as_view(),
        name="cff-messages-read",
    ),
]
