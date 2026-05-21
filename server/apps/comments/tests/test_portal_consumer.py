"""WebSocket consumer tests for the customer-portal variant.

Mirrors :mod:`apps.comments.tests.test_consumers` against the staff
consumer, scoped to the portal cookie + :class:`ClientAccount`. The
two consumers share the comments ``comments.<kind>.<id>`` group so a
single test can prove that customer-side presence / typing fans out
to staff watching the same proposal — and vice versa.

Coverage:

* Auth gate: missing portal cookie → ``4401``;  stale / wrong-customer
  proposal id → ``4404`` (same code as "unknown" so the response
  shape leaks nothing about whether the row exists in a tenant the
  caller cannot see).
* Entity authorisation: spec attached via the legacy 1-to-1 path AND
  the per-line attachment path both authorise the customer; a spec
  on a different customer's proposal does not.
* Group sharing: customer + staff joined to the same proposal see
  each other's ``presence.joined`` and ``typing.start`` broadcasts.
* Viewer snapshot: portal viewer id carries the ``client:<uuid>``
  prefix that the FE presence store uses to tint the row as
  "Customer" vs staff.

Built on top of ``channels.testing.WebsocketCommunicator`` against
the full ASGI ``application`` so middleware + URL router + consumer
get exercised together.
"""

from __future__ import annotations

import uuid

import pytest
from channels.testing import WebsocketCommunicator

from apps.accounts.tests.factories import UserFactory
from apps.client_portal.cookies import tokens_for_client
from apps.client_portal.models import ClientAccount
from apps.comments.consumers import (
    CLOSE_BAD_TARGET,
    CLOSE_UNAUTHENTICATED,
)
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import ProposalLine
from apps.proposals.tests.factories import ProposalFactory
from config.asgi import application


pytestmark = [pytest.mark.django_db(transaction=True), pytest.mark.asyncio]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sync(callable_):
    """Wrap a sync ORM call so the async test can ``await`` it. Same
    helper shape as :mod:`test_consumers` — the indirection runs the
    inner call on a thread with a matching DB connection rather than
    blocking the event loop."""

    from channels.db import database_sync_to_async

    return database_sync_to_async(callable_)


def _portal_cookie_header(account: ClientAccount) -> list[tuple[bytes, bytes]]:
    """Build the ``cookie:`` header the middleware will resolve into
    ``scope["client_account"]``. Matches the production cookie name
    (``vita_portal_access``) so the middleware's lookup path is
    exercised end-to-end."""

    from django.conf import settings

    access, _ = tokens_for_client(account)
    raw = f"{settings.PORTAL_AUTH_COOKIE_ACCESS_NAME}={access}".encode("latin-1")
    return [(b"cookie", raw)]


def _staff_cookie_header(user) -> list[tuple[bytes, bytes]]:
    """Mirror of the staff helper in :mod:`test_consumers`. Kept local
    so the two test modules don't grow a shared utility module for
    one helper each."""

    from django.conf import settings
    from rest_framework_simplejwt.tokens import AccessToken

    token = str(AccessToken.for_user(user))
    raw = f"{settings.AUTH_COOKIE_ACCESS_NAME}={token}".encode("latin-1")
    return [(b"cookie", raw)]


async def _safe_disconnect(communicator: WebsocketCommunicator) -> None:
    """``CancelledError`` from a teardown race is not actionable —
    swallow it so the suite reports the real failure if one happened
    earlier in the test. Same pattern :mod:`test_consumers` uses."""

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
    """Read events until one matches ``predicate`` or the budget is
    spent. Lifted verbatim from :mod:`test_consumers` to keep the
    two suites' wait semantics aligned."""

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
            continue
        if predicate(evt):
            return True
    return False


def _make_customer_with_account(*, company: str, email: str):
    """Build a Customer + activated ClientAccount pair the WS tests
    can authenticate as. ``activated_at`` is populated so the
    portal login state machine treats the account as a real session
    rather than a pending activation token."""

    org = OrganizationFactory()
    actor = UserFactory()
    customer = Customer.objects.create(
        organization=org,
        name="Customer Contact",
        company=company,
        email=email,
        created_by=actor,
        updated_by=actor,
    )
    account = ClientAccount.objects.create_account(
        email=email, customer=customer, password="portal-password-12345"
    )
    ClientAccount.objects.filter(pk=account.pk).update(
        activated_at="2026-01-01T00:00:00Z"
    )
    return customer, ClientAccount.objects.get(pk=account.pk)


# ---------------------------------------------------------------------------
# Auth gate
# ---------------------------------------------------------------------------


class TestAuth:
    async def test_missing_portal_cookie_closes_with_4401(self) -> None:
        # The middleware never populates ``scope["client_account"]``
        # when no portal cookie is present; the consumer's connect
        # gate fires the explicit 4401 close.
        proposal = await _sync(ProposalFactory)()

        path = f"/ws/portal/proposal/{proposal.id}/"
        communicator = WebsocketCommunicator(application, path)
        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            assert close_code == CLOSE_UNAUTHENTICATED
        finally:
            await communicator.disconnect()

    async def test_staff_cookie_only_does_not_authorise_portal_route(
        self,
    ) -> None:
        # A staff user signed into both surfaces in the same browser
        # would still need the portal cookie to land on this route —
        # ``scope["user"]`` is not consulted by the portal consumer.
        # Sending ONLY the staff cookie must close with 4401, never
        # accept on the basis of staff identity.
        proposal = await _sync(ProposalFactory)()
        staff_user = await _sync(UserFactory)(email="staff-only@vita.test")

        path = f"/ws/portal/proposal/{proposal.id}/"
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _staff_cookie_header(staff_user)
        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            assert close_code == CLOSE_UNAUTHENTICATED
        finally:
            await communicator.disconnect()


# ---------------------------------------------------------------------------
# Entity scoping — the customer can only see proposals + specs that
# belong to their own customer record.
# ---------------------------------------------------------------------------


class TestEntityScoping:
    async def test_authed_customer_connects_to_own_proposal(self) -> None:
        customer, account = await _sync(_make_customer_with_account)(
            company="Acme Foods Ltd", email="anna@acme.example.com"
        )
        proposal = await _sync(ProposalFactory)(
            organization=customer.organization,
            customer=customer,
            public_token=uuid.uuid4(),
        )

        path = f"/ws/portal/proposal/{proposal.id}/"
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _portal_cookie_header(account)
        try:
            connected, _code = await communicator.connect()
            assert connected is True

            # First broadcast: own ``presence.joined`` — the consumer
            # echoes its own join into the group on connect.
            evt = await communicator.receive_json_from(timeout=2)
            assert evt["type"] == "presence.joined"
            # Viewer carries the ``client:<uuid>`` prefix so the FE
            # presence store can tint this row differently from staff.
            assert evt["viewer"]["id"].startswith("client:")
            # Identity rendered as "<company>" — matches the staff
            # inbox + chat panels.
            assert evt["viewer"]["name"] == "Acme Foods Ltd"
        finally:
            await _safe_disconnect(communicator)

    async def test_customer_cannot_connect_to_other_customers_proposal(
        self,
    ) -> None:
        # Customer A authed. Proposal belongs to Customer B. Same
        # close code as a non-existent UUID so the response leaks no
        # information about whether the row exists in someone else's
        # tenant.
        _customer_a, account = await _sync(_make_customer_with_account)(
            company="Acme Foods Ltd", email="anna@acme.example.com"
        )
        customer_b, _ = await _sync(_make_customer_with_account)(
            company="Beta Brews Co", email="bob@beta.example.com"
        )
        foreign_proposal = await _sync(ProposalFactory)(
            organization=customer_b.organization,
            customer=customer_b,
        )

        path = f"/ws/portal/proposal/{foreign_proposal.id}/"
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _portal_cookie_header(account)
        try:
            connected, close_code = await communicator.connect()
            assert connected is False
            assert close_code == CLOSE_BAD_TARGET
        finally:
            await communicator.disconnect()

    async def test_formulation_kind_is_rejected_for_portal(self) -> None:
        # The route regex only matches proposal / specification, so
        # a formulation URL is rejected at the URLRouter level — same
        # ``ValueError("No route found")`` shape the staff malformed-
        # URL test asserts.
        _customer, account = await _sync(_make_customer_with_account)(
            company="Closed Off Co", email="closed@example.com"
        )

        communicator = WebsocketCommunicator(
            application,
            "/ws/portal/formulation/deadbeef-dead-beef-dead-beefdeadbeef/",
        )
        communicator.scope["headers"] = _portal_cookie_header(account)
        with pytest.raises(ValueError, match="No route found"):
            await communicator.connect()

    async def test_spec_via_legacy_one_to_one_attachment_authorises(
        self,
    ) -> None:
        # Specs reach the portal customer through either the legacy
        # ``Proposal.specification_sheet`` 1-to-1 or the per-line
        # attachment. This case exercises the 1-to-1 path.
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )

        customer, account = await _sync(_make_customer_with_account)(
            company="One To One Co", email="one2one@example.com"
        )
        sheet = await _sync(SpecificationSheetFactory)(
            organization=customer.organization,
        )
        proposal = await _sync(ProposalFactory)(
            organization=customer.organization,
            customer=customer,
            specification_sheet=sheet,
        )
        # ``proposal`` is referenced solely to make the attachment
        # observable to the read path under test.
        assert proposal.specification_sheet_id == sheet.id

        path = f"/ws/portal/specification/{sheet.id}/"
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _portal_cookie_header(account)
        try:
            connected, _code = await communicator.connect()
            assert connected is True
        finally:
            await _safe_disconnect(communicator)

    async def test_spec_via_per_line_attachment_authorises(self) -> None:
        # Per-line attachment — :class:`ProposalLine.specification_sheet`
        # links the sheet to a customer-owned proposal.
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )

        customer, account = await _sync(_make_customer_with_account)(
            company="Multi Line Co", email="multi@example.com"
        )
        proposal = await _sync(ProposalFactory)(
            organization=customer.organization,
            customer=customer,
        )
        sheet = await _sync(SpecificationSheetFactory)(
            organization=customer.organization,
        )
        await _sync(ProposalLine.objects.create)(
            proposal=proposal,
            specification_sheet=sheet,
        )

        path = f"/ws/portal/specification/{sheet.id}/"
        communicator = WebsocketCommunicator(application, path)
        communicator.scope["headers"] = _portal_cookie_header(account)
        try:
            connected, _code = await communicator.connect()
            assert connected is True
        finally:
            await _safe_disconnect(communicator)


# ---------------------------------------------------------------------------
# Shared-group behaviour — staff + customer joined to the same proposal
# see each other's presence + typing broadcasts.
# ---------------------------------------------------------------------------


class TestGroupSharing:
    async def test_staff_sees_portal_customer_presence_on_same_proposal(
        self,
    ) -> None:
        # Customer connects first, then staff member joins. Staff
        # must observe the customer's ``presence.joined`` via the
        # ``presence.roster_request`` reply path — same flow the
        # kiosk consumer uses to surface guest viewers to staff.
        from apps.organizations.services import create_organization
        from apps.organizations.tests.factories import MembershipFactory

        customer, account = await _sync(_make_customer_with_account)(
            company="Shared Group Co", email="shared@example.com"
        )
        # Move the staff side onto the SAME organisation the
        # customer's proposal lives in. The customer fixture builds
        # its own org via the factory; we wire a member into that
        # org rather than spinning up a parallel one.
        org = customer.organization
        # The staff WS auth gate requires ``comments_view`` on the
        # formulations module — same capability the staff REST
        # comments endpoint enforces.
        staff = await _sync(UserFactory)(
            email="shared-staff@vita.test",
            first_name="Sam",
            last_name="Staff",
        )
        # Activate the org through the management code path
        # ``create_organization`` did NOT exercise (the factory
        # bypasses signals). Without ``is_active=True`` the staff
        # consumer would close with ``CLOSE_ORG_INACTIVE``.
        await _sync(_activate_organization)(org)
        await _sync(MembershipFactory)(
            user=staff,
            organization=org,
            permissions={
                "formulations": ["view", "comments_view", "comments_write"],
                "proposals": ["view"],
            },
        )
        proposal = await _sync(ProposalFactory)(
            organization=org,
            customer=customer,
        )

        # Customer connects first.
        portal_path = f"/ws/portal/proposal/{proposal.id}/"
        portal_comm = WebsocketCommunicator(application, portal_path)
        portal_comm.scope["headers"] = _portal_cookie_header(account)

        # Staff connects to the same proposal entity via the staff
        # route — different URL, same group ``comments.proposal.<id>``.
        staff_path = f"/ws/org/{org.id}/proposal/{proposal.id}/"
        staff_comm = WebsocketCommunicator(application, staff_path)
        staff_comm.scope["headers"] = _staff_cookie_header(staff)

        try:
            portal_connected, _ = await portal_comm.connect()
            assert portal_connected is True
            # Drain the customer's own presence.joined echo so the
            # next read on this socket starts on a clean queue.
            await portal_comm.receive_json_from(timeout=2)

            staff_connected, _ = await staff_comm.connect()
            assert staff_connected is True

            # Staff must observe the customer's presence (via the
            # roster_request reply the customer's consumer emits).
            saw_customer = await _wait_for_event(
                staff_comm,
                predicate=lambda e: e.get("type") == "presence.joined"
                and str(e.get("viewer", {}).get("id", "")).startswith(
                    "client:"
                ),
            )
            assert saw_customer

            # Conversely the customer must observe the staff's join
            # (the staff consumer broadcasts its own presence.joined
            # on connect).
            saw_staff = await _wait_for_event(
                portal_comm,
                predicate=lambda e: e.get("type") == "presence.joined"
                and e.get("viewer", {}).get("id") == str(staff.id),
            )
            assert saw_staff
        finally:
            await _safe_disconnect(portal_comm)
            await _safe_disconnect(staff_comm)

    async def test_staff_rest_comment_reaches_portal_ws_on_same_proposal(
        self,
    ) -> None:
        # Reproduces the user-reported "bell pings but chat is silent"
        # bug: staff posts via the REST comments endpoint, customer
        # has the portal chat open. The :func:`create_comment` service
        # already schedules a ``comment.created`` broadcast on
        # transaction commit — this test proves that broadcast lands
        # on the portal consumer's WebSocket attached to the same
        # proposal.
        from apps.comments.services import create_comment

        customer, account = await _sync(_make_customer_with_account)(
            company="Live Chat Co", email="live@example.com"
        )
        org = customer.organization
        await _sync(_activate_organization)(org)
        # Staff user just needs to exist + own the
        # ``formulations.comments_write`` capability for the create
        # to be authorised by the staff REST layer. We invoke the
        # service directly here (skipping the REST view) because the
        # service is what every staff write path eventually calls;
        # the broadcast hop is unconditional on it.
        staff = await _sync(UserFactory)(
            email="live-staff@vita.test",
            first_name="Sam",
            last_name="Staff",
        )
        proposal = await _sync(ProposalFactory)(
            organization=org,
            customer=customer,
        )

        portal_path = f"/ws/portal/proposal/{proposal.id}/"
        portal_comm = WebsocketCommunicator(application, portal_path)
        portal_comm.scope["headers"] = _portal_cookie_header(account)

        try:
            connected, _ = await portal_comm.connect()
            assert connected is True
            # Drain the customer's own presence.joined echo.
            await portal_comm.receive_json_from(timeout=2)

            # Staff posts a comment — same code path the inline
            # comments panel takes when staff hits "send" on the
            # proposal page.
            await _sync(create_comment)(
                organization=org,
                actor=staff,
                target=proposal,
                body="hello from the vita team",
            )

            # Customer's portal WS must observe the ``comment.created``
            # broadcast on the shared ``comments.proposal.<id>`` group.
            saw_message = await _wait_for_event(
                portal_comm,
                predicate=lambda e: e.get("type") == "comment.created",
            )
            assert saw_message, (
                "Portal WS did not receive comment.created broadcast "
                "from staff REST write — this is the user-reported "
                "'bell pings but chat is silent' regression."
            )
        finally:
            await _safe_disconnect(portal_comm)

    async def test_portal_typing_reaches_staff_on_same_proposal(
        self,
    ) -> None:
        # Same setup as the presence test — but here the customer
        # sends ``typing.start`` and the staff side must observe it.
        from apps.organizations.tests.factories import MembershipFactory

        customer, account = await _sync(_make_customer_with_account)(
            company="Typing Co", email="type@example.com"
        )
        org = customer.organization
        staff = await _sync(UserFactory)(
            email="typing-staff@vita.test",
            first_name="Tess",
            last_name="Type",
        )
        await _sync(_activate_organization)(org)
        await _sync(MembershipFactory)(
            user=staff,
            organization=org,
            permissions={
                "formulations": ["view", "comments_view", "comments_write"],
                "proposals": ["view"],
            },
        )
        proposal = await _sync(ProposalFactory)(
            organization=org,
            customer=customer,
        )

        portal_path = f"/ws/portal/proposal/{proposal.id}/"
        portal_comm = WebsocketCommunicator(application, portal_path)
        portal_comm.scope["headers"] = _portal_cookie_header(account)
        staff_path = f"/ws/org/{org.id}/proposal/{proposal.id}/"
        staff_comm = WebsocketCommunicator(application, staff_path)
        staff_comm.scope["headers"] = _staff_cookie_header(staff)

        try:
            portal_connected, _ = await portal_comm.connect()
            assert portal_connected is True
            staff_connected, _ = await staff_comm.connect()
            assert staff_connected is True

            await portal_comm.send_json_to({"type": "typing.start"})

            saw_typing = await _wait_for_event(
                staff_comm,
                predicate=lambda e: e.get("type") == "typing.start"
                and str(e.get("viewer", {}).get("id", "")).startswith(
                    "client:"
                ),
            )
            assert saw_typing
        finally:
            await _safe_disconnect(portal_comm)
            await _safe_disconnect(staff_comm)


def _activate_organization(organization) -> None:
    """Flip the org's ``is_active`` flag on without invoking the
    management command. The :class:`OrganizationFactory` builds a
    deactivated row by default; the WS-level auth gate
    (``CLOSE_ORG_INACTIVE``) needs the live state."""

    organization.is_active = True
    organization.save(update_fields=["is_active"])
