"""URL routes for the organizations API."""

from django.urls import path

from apps.organizations.api.views import (
    AcceptInvitationView,
    InvitationCreateView,
    OrganizationListCreateView,
    PublicInvitationDetailView,
)

app_name = "organizations"

urlpatterns = [
    path(
        "organizations/",
        OrganizationListCreateView.as_view(),
        name="organization-list",
    ),
    path(
        "organizations/<uuid:org_id>/invitations/",
        InvitationCreateView.as_view(),
        name="invitation-create",
    ),
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
