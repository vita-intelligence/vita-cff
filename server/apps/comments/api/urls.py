"""URL routes for the comments API."""

from django.urls import path

from apps.comments.api.public_views import (
    PublicSpecificationCommentsView,
    PublicSpecificationIdentifyView,
)
from apps.comments.api.views import (
    CommentDetailView,
    CommentFlagView,
    CommentResolveView,
    FormulationCommentsView,
    MentionableMembersView,
    SpecificationCommentsView,
)

app_name = "comments"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/formulations/<uuid:formulation_id>/comments/",
        FormulationCommentsView.as_view(),
        name="formulation-comments",
    ),
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/comments/",
        SpecificationCommentsView.as_view(),
        name="specification-comments",
    ),
    path(
        "organizations/<uuid:org_id>/comments/<uuid:comment_id>/",
        CommentDetailView.as_view(),
        name="comment-detail",
    ),
    path(
        "organizations/<uuid:org_id>/comments/<uuid:comment_id>/resolve/",
        CommentResolveView.as_view(action="resolve"),
        name="comment-resolve",
    ),
    path(
        "organizations/<uuid:org_id>/comments/<uuid:comment_id>/unresolve/",
        CommentResolveView.as_view(action="unresolve"),
        name="comment-unresolve",
    ),
    path(
        "organizations/<uuid:org_id>/comments/<uuid:comment_id>/flag/",
        CommentFlagView.as_view(action="flag"),
        name="comment-flag",
    ),
    path(
        "organizations/<uuid:org_id>/comments/<uuid:comment_id>/unflag/",
        CommentFlagView.as_view(action="unflag"),
        name="comment-unflag",
    ),
    path(
        "organizations/<uuid:org_id>/members/mentionable/",
        MentionableMembersView.as_view(),
        name="members-mentionable",
    ),
    # Kiosk (public, token-gated) endpoints. No org in the URL
    # because visitors do not know one — the share token binds
    # the request to a single sheet and therefore a single org.
    path(
        "public/specifications/<uuid:token>/identify/",
        PublicSpecificationIdentifyView.as_view(),
        name="public-identify",
    ),
    path(
        "public/specifications/<uuid:token>/comments/",
        PublicSpecificationCommentsView.as_view(),
        name="public-comments",
    ),
]
