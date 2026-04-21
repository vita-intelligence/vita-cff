"""WebSocket consumer tests for the comments app.

Exercises the skeleton :class:`CommentConsumer` — auth gating,
group join, ping/pong round-trip, tenancy isolation. Business
messages (comment.* / presence.* / typing.*) land in commits 4-5
and will get their own test files.

These tests use ``channels.testing.WebsocketCommunicator`` against
the full ASGI ``application`` stack (middleware + URL router), so
they exercise JWT-cookie verification + consumer logic together.
"""

from __future__ import annotations

import pytest
from channels.testing import WebsocketCommunicator
from rest_framework_simplejwt.tokens import AccessToken

from apps.accounts.tests.factories import UserFactory
from apps.comments.consumers import (
    CLOSE_BAD_TARGET,
    CLOSE_FORBIDDEN,
    CLOSE_ORG_INACTIVE,
    CLOSE_UNAUTHENTICATED,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from config.asgi import application


pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


def _cookie_header_for_user(user) -> list[tuple[bytes, bytes]]:
    """Build a ``cookie:`` header list the way Daphne delivers it.

    ``scope["headers"]`` is a list of ``(name: bytes, value: bytes)``
    pairs — we mirror the production shape so the middleware's
    cookie parser is exercised in full.
    """

    from django.conf import settings

    token = str(AccessToken.for_user(user))
    header_value = f"{settings.AUTH_COOKIE_ACCESS_NAME}={token}".encode(
        "latin-1"
    )
    return [(b"cookie", header_value)]


def _ws_path(org_id, kind: str, entity_id) -> str:
    return f"/ws/org/{org_id}/{kind}/{entity_id}/"


async def _connect(path: str, headers: list[tuple[bytes, bytes]] | None = None):
    communicator = WebsocketCommunicator(application, path)
    if headers is not None:
        communicator.scope["headers"] = headers
    connected, close_code = await communicator.connect()
    return communicator, connected, close_code


async def _safe_disconnect(communicator: WebsocketCommunicator) -> None:
    """Teardown helper that tolerates already-cancelled communicators.

    When a consumer pair broadcasts into a group and one of them is
    already torn down, the second ``disconnect()`` surfaces a
    :class:`asyncio.CancelledError` from the underlying ASGI future.
    ``CancelledError`` inherits from :class:`BaseException` in Python
    3.8+, so a plain ``except Exception`` does **not** catch it — we
    suppress ``BaseException`` here and re-raise ``KeyboardInterrupt``
    so Ctrl-C still works.
    """

    try:
        await communicator.disconnect()
    except KeyboardInterrupt:
        raise
    except BaseException:
        pass


async def _wait_for_event(
    communicator: WebsocketCommunicator,
    *,
    predicate,
    timeout_seconds: float = 2.0,
    max_events: int = 30,
) -> bool:
    """Read from ``communicator`` until an event satisfies ``predicate``.

    Returns ``True`` on match, ``False`` if ``timeout_seconds``
    elapses without one. Intentionally **not** a draining helper —
    each inner ``receive_json_from`` call uses its own small timeout
    so an expected event's queue position (say, third in a batch of
    three) is found without the communicator's underlying future
    getting cancelled by an oversized outer timeout.
    """

    import time

    deadline = time.monotonic() + timeout_seconds
    for _ in range(max_events):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        try:
            evt = await communicator.receive_json_from(
                timeout=min(0.5, remaining)
            )
        except Exception:  # noqa: BLE001 — TimeoutError: queue empty for now
            # Empty slice — try one more time if we still have budget.
            continue
        if predicate(evt):
            return True
    return False


class TestAuth:
    async def test_unauthenticated_closed_with_4401(self) -> None:
        # Create a real org + entity so the URL itself is valid —
        # ensures we trip the auth gate, not the "bad target" one.
        org = await _sync(OrganizationFactory)()
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=org.created_by
        )
        path = _ws_path(org.id, "formulation", formulation.id)

        communicator, connected, close_code = await _connect(path)
        try:
            assert connected is False
            assert close_code == CLOSE_UNAUTHENTICATED
        finally:
            await communicator.disconnect()


class TestConnectAcceptsMember:
    async def test_authed_member_connects_and_pings(self) -> None:
        owner = await _sync(UserFactory)(email="ws-owner@vita.test")
        org = await _sync(create_organization)(
            user=owner, name="WS Co"
        )
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )

        path = _ws_path(org.id, "formulation", formulation.id)
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _cookie_header_for_user(owner)

        try:
            connected, _code = await communicator.connect()
            assert connected is True

            # Drain the automatic ``presence.joined`` the consumer
            # broadcasts on connect — one, and only one, lands on the
            # client side of a lone connection (roster_request is
            # suppressed against the requester itself).
            first = await communicator.receive_json_from(timeout=2)
            assert first["type"] == "presence.joined"

            # Ping → pong round-trip
            await communicator.send_json_to({"type": "ping"})
            reply = await communicator.receive_json_from(timeout=2)
            assert reply == {"type": "pong"}
        finally:
            await _safe_disconnect(communicator)


class TestMissingCapability:
    async def test_member_without_comments_view_is_forbidden(self) -> None:
        owner = await _sync(UserFactory)(email="caps-owner@vita.test")
        org = await _sync(create_organization)(user=owner, name="CapsCo")
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )

        # Member has only the plain ``view`` capability (no comments_view).
        member = await _sync(UserFactory)(email="caps-member@vita.test")
        await _sync(MembershipFactory)(
            user=member,
            organization=org,
            permissions={"formulations": ["view"]},
        )

        path = _ws_path(org.id, "formulation", formulation.id)
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _cookie_header_for_user(member)

        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            assert close_code == CLOSE_FORBIDDEN
        finally:
            await communicator.disconnect()


class TestTenancyIsolation:
    async def test_non_member_cannot_connect_to_foreign_org(self) -> None:
        owner = await _sync(UserFactory)(email="iso-owner@vita.test")
        org = await _sync(create_organization)(user=owner, name="IsolatedCo")
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )

        outsider = await _sync(UserFactory)(email="iso-outsider@vita.test")

        path = _ws_path(org.id, "formulation", formulation.id)
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _cookie_header_for_user(outsider)

        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            # Non-members hit the same "missing" branch as unknown entities
            # so the leak surface is one consistent code.
            assert close_code == CLOSE_BAD_TARGET
        finally:
            await communicator.disconnect()


class TestInactiveOrgBlock:
    async def test_inactive_org_closes_with_inactive_code(self) -> None:
        owner = await _sync(UserFactory)(email="inactive-owner@vita.test")
        org = await _sync(create_organization)(user=owner, name="InactiveCo")
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )
        # Flip the org off without going through the signal autouse
        # fixture's activate step — we want the real-world "admin
        # suspended this tenant" state.
        await _sync(_deactivate_organization)(org)

        path = _ws_path(org.id, "formulation", formulation.id)
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _cookie_header_for_user(owner)

        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            assert close_code == CLOSE_ORG_INACTIVE
        finally:
            await communicator.disconnect()


class TestPresenceBroadcasts:
    async def test_joiner_sees_own_presence_announcement(self) -> None:
        owner = await _sync(UserFactory)(
            email="presence-owner@vita.test", first_name="Pat", last_name="Owner"
        )
        org = await _sync(create_organization)(user=owner, name="PresenceCo")
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )

        path = _ws_path(org.id, "formulation", formulation.id)
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _cookie_header_for_user(owner)
        try:
            connected, _code = await communicator.connect()
            assert connected is True

            # First broadcast after accept is our own ``presence.joined``.
            first = await communicator.receive_json_from(timeout=2)
            assert first["type"] == "presence.joined"
            assert first["viewer"]["id"] == str(owner.id)
            assert first["viewer"]["name"] == "Pat Owner"
        finally:
            await communicator.disconnect()

    async def test_second_viewer_learns_about_the_first(self) -> None:
        owner = await _sync(UserFactory)(
            email="roster-owner@vita.test", first_name="Alice", last_name="A"
        )
        org = await _sync(create_organization)(user=owner, name="RosterCo")
        member = await _sync(UserFactory)(
            email="roster-member@vita.test", first_name="Bob", last_name="B"
        )
        await _sync(MembershipFactory)(
            user=member,
            organization=org,
            permissions={
                "formulations": ["view", "comments_view", "comments_write"]
            },
        )
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )
        path = _ws_path(org.id, "formulation", formulation.id)

        comm_a = WebsocketCommunicator(application, path)
        comm_a.scope["headers"] = _cookie_header_for_user(owner)
        comm_b = WebsocketCommunicator(application, path)
        comm_b.scope["headers"] = _cookie_header_for_user(member)

        try:
            connected_a, _ = await comm_a.connect()
            assert connected_a is True
            # A sees its own ``presence.joined``.
            first_a = await comm_a.receive_json_from(timeout=2)
            assert first_a["type"] == "presence.joined"

            # B joins — triggers two things visible to A:
            #   1. ``presence.joined`` for B (B's own broadcast).
            #   2. (no self-echo for A, since its own roster_request
            #      handler ignores its own requester_channel.)
            # A must see (1).
            connected_b, _ = await comm_b.connect()
            assert connected_b is True

            # A must eventually see B's ``presence.joined`` event.
            # The channel layer may deliver one or two presence.joined
            # events for A (its own roster_request echo is self-filtered
            # server-side, but B's joined broadcast must arrive).
            saw_b_on_a = await _wait_for_event(
                comm_a,
                predicate=lambda e: e.get("type") == "presence.joined"
                and e["viewer"]["id"] == str(member.id),
            )
            assert saw_b_on_a

            # B must see:
            #   - its own ``presence.joined`` (from its broadcast).
            #   - A's ``presence.joined`` (A's handler replies to B's
            #     roster_request).
            # Collect the first few events and assert both IDs appear.
            saw_a_on_b = await _wait_for_event(
                comm_b,
                predicate=lambda e: e.get("type") == "presence.joined"
                and e["viewer"]["id"] == str(owner.id),
            )
            assert saw_a_on_b
        finally:
            await _safe_disconnect(comm_a)
            await _safe_disconnect(comm_b)

    async def test_disconnect_broadcasts_presence_left(self) -> None:
        owner = await _sync(UserFactory)(email="left-owner@vita.test")
        org = await _sync(create_organization)(user=owner, name="LeftCo")
        member = await _sync(UserFactory)(email="left-member@vita.test")
        await _sync(MembershipFactory)(
            user=member,
            organization=org,
            permissions={
                "formulations": ["view", "comments_view", "comments_write"]
            },
        )
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )
        path = _ws_path(org.id, "formulation", formulation.id)

        comm_a = WebsocketCommunicator(application, path)
        comm_a.scope["headers"] = _cookie_header_for_user(owner)
        comm_b = WebsocketCommunicator(application, path)
        comm_b.scope["headers"] = _cookie_header_for_user(member)

        try:
            connected_a, _ = await comm_a.connect()
            assert connected_a is True
            first_a = await comm_a.receive_json_from(timeout=2)
            assert first_a["type"] == "presence.joined"

            connected_b, _ = await comm_b.connect()
            assert connected_b is True

            # A observes B's join (and an optional roster-request echo).
            saw_b_on_a = await _wait_for_event(
                comm_a,
                predicate=lambda e: e.get("type") == "presence.joined"
                and e["viewer"]["id"] == str(member.id),
            )
            assert saw_b_on_a

            await _safe_disconnect(comm_b)

            # Now A must receive ``presence.left`` for B.
            saw_left = await _wait_for_event(
                comm_a,
                predicate=lambda e: e.get("type") == "presence.left"
                and e["viewer"]["id"] == str(member.id),
            )
            assert saw_left
        finally:
            await _safe_disconnect(comm_a)


class TestTypingBroadcasts:
    async def test_typing_start_relays_to_other_viewers(self) -> None:
        """The ``typing.start`` message fans out to every other viewer
        of the same entity, with the typist's identity attached, and
        does **not** echo back to the typist. Combined in a single
        test so we exercise the echo-suppression path without needing
        two separate drain-heavy tests."""

        owner = await _sync(UserFactory)(email="typing-owner@vita.test")
        org = await _sync(create_organization)(user=owner, name="TypingCo")
        member = await _sync(UserFactory)(email="typing-member@vita.test")
        await _sync(MembershipFactory)(
            user=member,
            organization=org,
            permissions={
                "formulations": ["view", "comments_view", "comments_write"]
            },
        )
        formulation = await _sync(FormulationFactory)(
            organization=org, created_by=owner
        )
        path = _ws_path(org.id, "formulation", formulation.id)

        comm_a = WebsocketCommunicator(application, path)
        comm_a.scope["headers"] = _cookie_header_for_user(owner)
        comm_b = WebsocketCommunicator(application, path)
        comm_b.scope["headers"] = _cookie_header_for_user(member)

        try:
            await comm_a.connect()
            await comm_a.receive_json_from(timeout=2)  # own presence.joined
            await comm_b.connect()
            await _wait_for_event(
                comm_a,
                predicate=lambda e: e.get("type") == "presence.joined"
                and e["viewer"]["id"] == str(member.id),
            )

            # B types. A must see typing.start carrying B's identity.
            await comm_b.send_json_to({"type": "typing.start"})

            saw_typing = await _wait_for_event(
                comm_a,
                predicate=lambda e: e.get("type") == "typing.start"
                and e["viewer"]["id"] == str(member.id),
            )
            assert saw_typing

            # B itself must NOT receive its own typing.start echo.
            # Poll briefly and ensure no such event lands.
            echo_seen = await _wait_for_event(
                comm_b,
                predicate=lambda e: e.get("type") == "typing.start"
                and e["viewer"]["id"] == str(member.id),
                timeout_seconds=0.5,
            )
            assert echo_seen is False
        finally:
            await _safe_disconnect(comm_a)
            await _safe_disconnect(comm_b)


class TestMalformedUrl:
    async def test_bogus_entity_kind_rejected_by_router(self) -> None:
        # Unknown ``entity_kind`` fails the ``URLRouter`` regex before
        # reaching our consumer. Channels raises ``ValueError("No
        # route found")`` into the communicator's future; we assert
        # that behaviour so a future accidental widening of the URL
        # pattern (e.g. catch-all route) is caught by the suite.
        owner = await _sync(UserFactory)(email="bogus-owner@vita.test")
        await _sync(create_organization)(user=owner, name="BogusCo")

        communicator = WebsocketCommunicator(
            application,
            "/ws/org/deadbeef-dead-beef-dead-beefdeadbeef/widget/deadbeef-dead-beef-dead-beefdeadbeef/",
        )
        communicator.scope["headers"] = _cookie_header_for_user(owner)
        with pytest.raises(ValueError, match="No route found"):
            await communicator.connect()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sync(callable_):
    """Wrap a sync ORM factory / service so an async test can ``await`` it.

    ``channels.db.database_sync_to_async`` is the canonical hop — it
    ensures the call runs inside a thread with a matching DB
    connection rather than inside the event loop.
    """

    from channels.db import database_sync_to_async

    return database_sync_to_async(callable_)


def _deactivate_organization(organization) -> None:
    """Revert the autouse-fixture activation by flipping the flag back
    off. Matches the real admin flow (``manage.py deactivate_
    organization``) without invoking the management command."""

    organization.is_active = False
    organization.save(update_fields=["is_active"])
