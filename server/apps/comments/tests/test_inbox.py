"""Tests for the messenger inbox surface.

Covers the service layer (mark-read, list, count), the REST views,
and the fan-out broadcast contract — i.e. that posting a new comment
emits an ``inbox.message`` event to every org-member with the
``comments_view`` capability, but never to the comment's own author.

The WebSocket consumer is exercised end-to-end via the broadcast: we
swap the channel layer for an in-memory recorder so a single test
can assert on the exact set of target user IDs without needing a
real Channels worker.
"""

from __future__ import annotations

import datetime as _dt
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.tests.factories import UserFactory
from apps.comments.models import ThreadEntityKind, ThreadReadState
from apps.comments.services import (
    compute_total_unread,
    create_comment,
    list_inbox_threads,
    mark_thread_read,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def workspace(mailoutbox):
    """One org, two members (owner + viewer), and one formulation."""

    org = OrganizationFactory()
    owner = org.created_by
    viewer = UserFactory(email="viewer@vita.test")
    MembershipFactory(
        user=viewer,
        organization=org,
        permissions={
            "formulations": [
                "view",
                "comments_view",
                "comments_write",
            ]
        },
    )
    formulation = FormulationFactory(organization=org, created_by=owner)
    return {
        "org": org,
        "owner": owner,
        "viewer": viewer,
        "formulation": formulation,
    }


def _api_client_for(user) -> APIClient:
    """Authenticated APIClient that delivers the JWT via cookie — same
    transport prod uses."""

    from django.conf import settings

    client = APIClient()
    token = str(AccessToken.for_user(user))
    client.cookies[settings.AUTH_COOKIE_ACCESS_NAME] = token
    return client


@contextmanager
def _capture_on_commit():
    """Force ``transaction.on_commit`` callbacks to run synchronously
    inside the test transaction.

    Without this, the broadcast fan-out (registered on commit by
    :func:`schedule_comment_broadcast`) never fires under
    ``pytest.mark.django_db`` because the test wrapper transaction
    is rolled back at teardown, not committed.
    """

    with TestCase.captureOnCommitCallbacks(execute=True):
        yield


# ---------------------------------------------------------------------------
# Service: mark_thread_read
# ---------------------------------------------------------------------------


class TestMarkThreadRead:
    def test_first_call_creates_pointer_row(self, workspace) -> None:
        state = mark_thread_read(
            user=workspace["viewer"],
            entity_kind=ThreadEntityKind.FORMULATION.value,
            entity_id=workspace["formulation"].id,
        )
        assert state.pk is not None
        assert ThreadReadState.objects.count() == 1

    def test_second_call_updates_existing_row(self, workspace) -> None:
        first = mark_thread_read(
            user=workspace["viewer"],
            entity_kind=ThreadEntityKind.FORMULATION.value,
            entity_id=workspace["formulation"].id,
        )
        second = mark_thread_read(
            user=workspace["viewer"],
            entity_kind=ThreadEntityKind.FORMULATION.value,
            entity_id=workspace["formulation"].id,
        )
        assert first.pk == second.pk
        assert ThreadReadState.objects.count() == 1
        assert second.last_read_at >= first.last_read_at

    def test_rejects_unknown_entity_kind(self, workspace) -> None:
        with pytest.raises(ValueError):
            mark_thread_read(
                user=workspace["viewer"],
                entity_kind="trial_batch",
                entity_id=workspace["formulation"].id,
            )

    def test_explicit_timestamp_is_persisted(self, workspace) -> None:
        explicit = _dt.datetime(2026, 1, 1, 12, 0, tzinfo=_dt.timezone.utc)
        state = mark_thread_read(
            user=workspace["viewer"],
            entity_kind=ThreadEntityKind.FORMULATION.value,
            entity_id=workspace["formulation"].id,
            at=explicit,
        )
        assert state.last_read_at == explicit


# ---------------------------------------------------------------------------
# Service: list_inbox_threads + compute_total_unread
# ---------------------------------------------------------------------------


class TestListInboxThreads:
    def test_returns_threads_with_unread_count(self, workspace) -> None:
        # Both posts ``@``-mention the viewer so they count under the
        # quiet-notifications rule (only customer-authored or
        # @-mentions-me bump the unread badge).
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test Hello",
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test World",
        )
        threads = list_inbox_threads(user=workspace["viewer"])
        assert len(threads) == 1
        thread = threads[0]
        assert thread.entity_kind == "formulation"
        assert thread.entity_id == str(workspace["formulation"].id)
        assert thread.unread_count == 2
        assert thread.last_message_preview.endswith("World")

    def test_author_does_not_see_own_message_as_unread(
        self, workspace
    ) -> None:
        """``create_comment`` should bump the author's own read pointer
        so their inbox does not surface their own message as unread.
        Without this, the inbox bell would bump for the author every
        time they post on the next poll cycle even though the WS
        fan-out correctly skipped them."""

        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="My own message",
        )
        threads = list_inbox_threads(user=workspace["owner"])
        assert len(threads) == 1
        assert threads[0].unread_count == 0
        assert compute_total_unread(user=workspace["owner"]) == 0

    def test_marking_read_clears_unread(self, workspace) -> None:
        # Mention the viewer so the message would otherwise count
        # under the quiet-notifications rule — the test asserts that
        # ``mark_thread_read`` zeroes the badge regardless.
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test Hello",
        )
        mark_thread_read(
            user=workspace["viewer"],
            entity_kind="formulation",
            entity_id=workspace["formulation"].id,
        )
        threads = list_inbox_threads(user=workspace["viewer"])
        assert threads[0].unread_count == 0

    def test_user_without_comments_view_sees_nothing(self, workspace) -> None:
        # New user with a Membership but no comments_view capability.
        outsider = UserFactory(email="outsider@vita.test")
        MembershipFactory(
            user=outsider,
            organization=workspace["org"],
            permissions={"formulations": ["view"]},
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="Hi",
        )
        assert list_inbox_threads(user=outsider) == []

    def test_user_without_project_view_sees_nothing(self, workspace) -> None:
        """RBAC regression — a member who has ``comments_view`` but
        not ``view`` should NOT see project chats in the inbox.
        Without the ``view`` gate the bell would leak chats from
        projects the user cannot otherwise reach (no project list,
        no project page) which is an RBAC hole vs. the rest of the
        app."""

        comments_only_user = UserFactory(email="comments_only@vita.test")
        MembershipFactory(
            user=comments_only_user,
            organization=workspace["org"],
            permissions={
                "formulations": [
                    # Note: NO ``view`` here.
                    "comments_view",
                    "comments_write",
                ]
            },
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="Hi",
        )
        assert list_inbox_threads(user=comments_only_user) == []

    def test_unrelated_user_sees_nothing(self, workspace) -> None:
        stranger = UserFactory(email="stranger@elsewhere.test")
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="Hi",
        )
        assert list_inbox_threads(user=stranger) == []

    def test_total_unread_sums_across_threads(self, workspace) -> None:
        other_formulation = FormulationFactory(
            organization=workspace["org"], created_by=workspace["owner"]
        )
        # All three posts mention the viewer so each contributes to
        # the unread sum under the quiet-notifications rule.
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test A",
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=other_formulation,
            body="@viewer@vita.test B",
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=other_formulation,
            body="@viewer@vita.test C",
        )
        assert compute_total_unread(user=workspace["viewer"]) == 3

    def test_unmentioned_internal_messages_do_not_bump_unread(
        self, workspace
    ) -> None:
        """Quiet-notifications rule: an internal back-and-forth between
        teammates that does not @-mention the viewer still surfaces
        as a thread (so the conversation is discoverable), but
        ``unread_count`` stays at zero — only @-mentions-me or
        customer-authored messages bump the bell badge.
        """

        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="Internal note — no one mentioned",
        )
        threads = list_inbox_threads(user=workspace["viewer"])
        assert len(threads) == 1
        assert threads[0].unread_count == 0
        assert compute_total_unread(user=workspace["viewer"]) == 0

    def test_unrelated_mention_does_not_bump_my_unread(
        self, workspace
    ) -> None:
        """Mention targeting a different teammate must not bump the
        viewer's unread count. Guards against a naïve filter that
        would match any mention rather than ``mentions_cache``
        containing *this* user's id.
        """

        third = UserFactory(email="third@vita.test")
        MembershipFactory(
            user=third,
            organization=workspace["org"],
            permissions={
                "formulations": [
                    "view",
                    "comments_view",
                    "comments_write",
                ]
            },
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@third@vita.test heads up",
        )
        # The mentioned third user's badge bumps.
        assert compute_total_unread(user=third) == 1
        # The unmentioned viewer's badge stays quiet.
        assert compute_total_unread(user=workspace["viewer"]) == 0


# ---------------------------------------------------------------------------
# Broadcast: fan-out audience
# ---------------------------------------------------------------------------


class TestInboxFanOut:
    """Asserts on the exact set of group names that ``group_send`` is
    invoked with after a ``create_comment`` call. We patch
    :func:`async_to_sync` inside the broadcast module so the helper
    becomes a recorder — the channel layer is otherwise a fully
    in-memory implementation in tests."""

    def test_author_does_not_receive_inbox_event(self, workspace) -> None:
        sends: list[tuple[str, dict]] = []

        def fake_async_to_sync(group_send):
            def caller(group, message):
                sends.append((group, message))
            return caller

        with patch(
            "apps.comments.broadcast.async_to_sync",
            side_effect=fake_async_to_sync,
        ), _capture_on_commit():
            create_comment(
                organization=workspace["org"],
                actor=workspace["owner"],
                target=workspace["formulation"],
                body="Hi",
            )

        inbox_targets = {
            group
            for group, message in sends
            if message.get("type") == "inbox.message"
        }
        assert f"inbox.{workspace['viewer'].id}" in inbox_targets
        assert f"inbox.{workspace['owner'].id}" not in inbox_targets

    def test_member_without_capability_is_skipped(self, workspace) -> None:
        # Add a third member without ``comments_view``.
        muted = UserFactory(email="muted@vita.test")
        MembershipFactory(
            user=muted,
            organization=workspace["org"],
            permissions={"formulations": ["view"]},
        )

        sends: list[tuple[str, dict]] = []

        def fake_async_to_sync(group_send):
            def caller(group, message):
                sends.append((group, message))
            return caller

        with patch(
            "apps.comments.broadcast.async_to_sync",
            side_effect=fake_async_to_sync,
        ), _capture_on_commit():
            create_comment(
                organization=workspace["org"],
                actor=workspace["owner"],
                target=workspace["formulation"],
                body="Hi",
            )

        inbox_targets = {
            group
            for group, message in sends
            if message.get("type") == "inbox.message"
        }
        assert f"inbox.{muted.id}" not in inbox_targets

    def test_member_without_project_view_is_skipped(self, workspace) -> None:
        """Fan-out RBAC regression — a member with ``comments_view``
        but not ``view`` must not receive ``inbox.message`` events.
        See :func:`apps.comments.services._accessible_organizations_for_user`."""

        comments_only_user = UserFactory(email="comments_only@vita.test")
        MembershipFactory(
            user=comments_only_user,
            organization=workspace["org"],
            permissions={
                "formulations": [
                    # NO ``view`` — the user can see comments but not
                    # projects, so the inbox must not include this
                    # chat in their badge.
                    "comments_view",
                ]
            },
        )

        sends: list[tuple[str, dict]] = []

        def fake_async_to_sync(group_send):
            def caller(group, message):
                sends.append((group, message))
            return caller

        with patch(
            "apps.comments.broadcast.async_to_sync",
            side_effect=fake_async_to_sync,
        ), _capture_on_commit():
            create_comment(
                organization=workspace["org"],
                actor=workspace["owner"],
                target=workspace["formulation"],
                body="Hi",
            )

        inbox_targets = {
            group
            for group, message in sends
            if message.get("type") == "inbox.message"
        }
        assert f"inbox.{comments_only_user.id}" not in inbox_targets

    def test_update_does_not_fan_out(self, workspace) -> None:
        with _capture_on_commit():
            comment = create_comment(
                organization=workspace["org"],
                actor=workspace["owner"],
                target=workspace["formulation"],
                body="Hi",
            )
        from apps.comments.services import edit_comment

        sends: list[tuple[str, dict]] = []

        def fake_async_to_sync(group_send):
            def caller(group, message):
                sends.append((group, message))
            return caller

        with patch(
            "apps.comments.broadcast.async_to_sync",
            side_effect=fake_async_to_sync,
        ), _capture_on_commit():
            edit_comment(
                comment=comment, actor=workspace["owner"], body="Edited"
            )

        inbox_events = [
            (group, message)
            for group, message in sends
            if message.get("type") == "inbox.message"
        ]
        assert inbox_events == []


# ---------------------------------------------------------------------------
# REST views
# ---------------------------------------------------------------------------


class TestInboxRESTEndpoints:
    def test_list_view_returns_threads_for_viewer(self, workspace) -> None:
        # Mention the viewer so the post bumps unread under the
        # quiet-notifications rule — see ``_notify_unread_filter``.
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test Hello",
        )
        client = _api_client_for(workspace["viewer"])
        response = client.get(reverse("comments:inbox"))
        assert response.status_code == 200
        body = response.json()
        assert body["total_unread"] == 1
        assert len(body["threads"]) == 1
        assert body["threads"][0]["unread_count"] == 1
        assert body["threads"][0]["entity_kind"] == "formulation"

    def test_unauth_request_is_rejected(self, workspace) -> None:
        client = APIClient()
        response = client.get(reverse("comments:inbox"))
        assert response.status_code in (401, 403)

    def test_unread_count_endpoint(self, workspace) -> None:
        # Both posts mention the viewer so each contributes to the
        # badge under the quiet-notifications rule.
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test A",
        )
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="@viewer@vita.test B",
        )
        client = _api_client_for(workspace["viewer"])
        response = client.get(reverse("comments:inbox-unread-count"))
        assert response.status_code == 200
        assert response.json() == {"unread_count": 2}

    def test_mark_read_endpoint_creates_pointer(self, workspace) -> None:
        create_comment(
            organization=workspace["org"],
            actor=workspace["owner"],
            target=workspace["formulation"],
            body="Hi",
        )
        client = _api_client_for(workspace["viewer"])
        response = client.post(
            reverse(
                "comments:thread-mark-read",
                kwargs={
                    "entity_kind": "formulation",
                    "entity_id": workspace["formulation"].id,
                },
            ),
        )
        assert response.status_code == 200
        assert (
            ThreadReadState.objects.filter(user=workspace["viewer"]).count()
            == 1
        )

    def test_mark_read_404s_for_inaccessible_entity(self, workspace) -> None:
        outsider = UserFactory(email="outsider@vita.test")
        client = _api_client_for(outsider)
        response = client.post(
            reverse(
                "comments:thread-mark-read",
                kwargs={
                    "entity_kind": "formulation",
                    "entity_id": workspace["formulation"].id,
                },
            ),
        )
        assert response.status_code == 404

    def test_mark_read_404s_for_unknown_kind(self, workspace) -> None:
        client = _api_client_for(workspace["viewer"])
        response = client.post(
            f"/api/comments/threads/trial_batch/{workspace['formulation'].id}/read/",
        )
        assert response.status_code == 404
