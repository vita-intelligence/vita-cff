"""Tests for the portal messaging endpoints.

Coverage:

* Client posts a shared comment on a spec they own → row is
  written with ``visibility=shared`` and ``client_account`` set.
* Cross-customer isolation — client A can't post on a spec
  attached to customer B's proposal.
* ``GET .../messages/`` returns only ``shared`` rows (internal
  staff chatter never leaks).
* Read state is bumped idempotently.
"""

from __future__ import annotations

import uuid

import pytest
from django.contrib.contenttypes.models import ContentType
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.client_portal.models import ClientAccount
from apps.comments.models import Comment, CommentReadState
from apps.customers.models import Customer
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import ProposalLine
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
)


@pytest.fixture
def org(db):
    return OrganizationFactory()


@pytest.fixture
def customer(db, org):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="Jane",
        company="Acme",
        email="jane@acme.example.com",
        created_by=actor,
        updated_by=actor,
    )


@pytest.fixture
def other_customer(db, org):
    actor = UserFactory()
    return Customer.objects.create(
        organization=org,
        name="Other",
        company="Other Ltd",
        email="other@other.example.com",
        created_by=actor,
        updated_by=actor,
    )


def _make_proposal_with_spec(*, organization, customer):
    """Build a proposal + an attached spec + a line linking the two
    so the portal messaging endpoints can find the spec via the
    canonical per-line attachment path.
    """

    proposal = ProposalFactory(
        organization=organization,
        customer=customer,
    )
    actor = UserFactory()
    sheet = SpecificationSheet.objects.create(
        organization=organization,
        formulation_version=proposal.formulation_version,
        document_kind=SpecificationDocumentKind.DRAFT,
        created_by=actor,
        updated_by=actor,
    )
    # Attach via a proposal line so ``_attached_spec_sheets`` finds it.
    ProposalLine.objects.create(
        proposal=proposal,
        specification_sheet=sheet,
        formulation_version=proposal.formulation_version,
        display_order=1,
    )
    return proposal, sheet


def _activate_client(api_client: APIClient, proposal):
    """Walk the activation endpoint so the test session carries the
    portal cookie. Sets a fixed activation code on the proposal so
    the test doesn't need to coordinate with the random generator
    in ``send_proposal_to_client`` — every call hands the same
    code to the activation POST."""

    proposal.activation_code = "123456"
    proposal.activation_code_sent_at = timezone.now()
    proposal.save(
        update_fields=["activation_code", "activation_code_sent_at"],
    )
    api_client.post(
        f"/api/portal/activate/{proposal.public_token}/",
        {"password": "supersecret-12345", "code": "123456"},
        format="json",
    )


@pytest.mark.django_db
class TestPortalMessaging:
    def test_post_creates_shared_comment_owned_by_client(self, org, customer):
        proposal, sheet = _make_proposal_with_spec(
            organization=org, customer=customer,
        )
        # Public token + activate.
        proposal.public_token = uuid.uuid4()
        proposal.save()
        client = APIClient()
        _activate_client(client, proposal)

        r = client.post(
            f"/api/portal/specs/{sheet.id}/messages/",
            {"body": "hi from acme"},
            format="json",
        )
        assert r.status_code == 201, r.content

        row = Comment.objects.get(client_account__email="jane@acme.example.com")
        assert row.visibility == Comment.Visibility.SHARED
        assert row.body == "hi from acme"
        assert row.author_id is None  # no staff author

    def test_cross_customer_post_returns_404(
        self, org, customer, other_customer,
    ):
        proposal, sheet = _make_proposal_with_spec(
            organization=org, customer=other_customer,
        )
        # My own proposal so I can activate as customer A.
        my_proposal, _ = _make_proposal_with_spec(
            organization=org, customer=customer,
        )
        my_proposal.public_token = uuid.uuid4()
        my_proposal.save()
        client = APIClient()
        _activate_client(client, my_proposal)

        r = client.post(
            f"/api/portal/specs/{sheet.id}/messages/",
            {"body": "snooping"},
            format="json",
        )
        # Same 404 as "doesn't exist" — never leak existence.
        assert r.status_code == 404

    def test_list_excludes_internal_comments(self, org, customer):
        proposal, sheet = _make_proposal_with_spec(
            organization=org, customer=customer,
        )
        proposal.public_token = uuid.uuid4()
        proposal.save()
        staff = UserFactory()
        spec_ct = ContentType.objects.get_for_model(SpecificationSheet)
        # One internal + one shared. Only the shared row should
        # surface in the portal response.
        Comment.objects.create(
            organization=org,
            content_type=spec_ct,
            object_id=sheet.id,
            specification_sheet=sheet,
            author=staff,
            visibility=Comment.Visibility.INTERNAL,
            body="staff-only note",
        )
        Comment.objects.create(
            organization=org,
            content_type=spec_ct,
            object_id=sheet.id,
            specification_sheet=sheet,
            author=staff,
            visibility=Comment.Visibility.SHARED,
            body="hi customer",
        )

        client = APIClient()
        _activate_client(client, proposal)
        r = client.get(f"/api/portal/proposals/{proposal.id}/messages/")
        assert r.status_code == 200, r.content
        body = r.json()
        assert len(body["results"]) == 1
        assert body["results"][0]["body"] == "hi customer"

    def test_mark_read_is_idempotent(self, org, customer):
        proposal, sheet = _make_proposal_with_spec(
            organization=org, customer=customer,
        )
        proposal.public_token = uuid.uuid4()
        proposal.save()
        client = APIClient()
        _activate_client(client, proposal)

        for _ in range(3):
            r = client.post(
                f"/api/portal/specs/{sheet.id}/messages/read/",
            )
            assert r.status_code == 200, r.content

        account = ClientAccount.objects.get(email="jane@acme.example.com")
        assert (
            CommentReadState.objects.filter(viewer_client=account).count() == 1
        )
