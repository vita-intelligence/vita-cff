"""URL routes for the comments API."""

from django.urls import path

from apps.comments.api.inbox_views import (
    InboxListView,
    InboxUnreadCountView,
    ThreadMarkReadView,
)
from apps.comments.api.kiosk_alert_views import NotifyClientView
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
    ProposalCommentsView,
    SpecificationCommentsView,
)

app_name = "comments"

urlpatterns = [
    # Messenger inbox — cross-org by design (a user can be a member of
    # several workspaces; the bell aggregates every chat they can see).
    # No org in the path because the surface is the user's view, not
    # one organisation's.
    path("comments/inbox/", InboxListView.as_view(), name="inbox"),
    path(
        "comments/inbox/unread_count/",
        InboxUnreadCountView.as_view(),
        name="inbox-unread-count",
    ),
    path(
        "comments/threads/<str:entity_kind>/<uuid:entity_id>/read/",
        ThreadMarkReadView.as_view(),
        name="thread-mark-read",
    ),
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
        "organizations/<uuid:org_id>/proposals/<uuid:proposal_id>/comments/",
        ProposalCommentsView.as_view(),
        name="proposal-comments",
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
    # Notify-client surface — team member triggers a manual email to
    # every identified kiosk customer on the sheet. GET peeks the
    # current state (last-alert metadata + recipient count); POST
    # fires the alert. Cooldown is enforced in the service.
    path(
        "organizations/<uuid:org_id>/specifications/<uuid:sheet_id>/notify-client/",
        NotifyClientView.as_view(),
        name="specification-notify-client",
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
