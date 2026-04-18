"""URL routes for the organizations API."""

from django.urls import path

from apps.organizations.api.views import (
    AcceptInvitationView,
    InvitationDetailView,
    InvitationListCreateView,
    InvitationResendView,
    MembershipDetailView,
    MembershipListView,
    ModuleRegistryView,
    OrganizationListCreateView,
    PublicInvitationDetailView,
)

app_name = "organizations"

urlpatterns = [
    # ---- Authenticated, caller-scoped ----------------------------------
    path(
        "organizations/",
        OrganizationListCreateView.as_view(),
        name="organization-list",
    ),
    path(
        "organizations/modules/",
        ModuleRegistryView.as_view(),
        name="module-registry",
    ),
    # ---- Org-scoped: members & invitations -----------------------------
    path(
        "organizations/<uuid:org_id>/memberships/",
        MembershipListView.as_view(),
        name="membership-list",
    ),
    path(
        "organizations/<uuid:org_id>/memberships/<uuid:membership_id>/",
        MembershipDetailView.as_view(),
        name="membership-detail",
    ),
    path(
        "organizations/<uuid:org_id>/invitations/",
        InvitationListCreateView.as_view(),
        name="invitation-list",
    ),
    path(
        "organizations/<uuid:org_id>/invitations/<uuid:invitation_id>/",
        InvitationDetailView.as_view(),
        name="invitation-detail-admin",
    ),
    path(
        "organizations/<uuid:org_id>/invitations/<uuid:invitation_id>/resend/",
        InvitationResendView.as_view(),
        name="invitation-resend",
    ),
    # ---- Public invitation-accept flow ---------------------------------
    path(
        "invitations/<str:token>/",
        PublicInvitationDetailView.as_view(),
        name="invitation-detail",
    ),
    path(
        "invitations/<str:token>/accept/",
        AcceptInvitationView.as_view(),
        name="invitation-accept",
    ),
]
