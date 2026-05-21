"""Integration tests for the comments API."""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.comments.models import Comment
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory


pytestmark = pytest.mark.django_db


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _formulation_comments_url(org_id, formulation_id) -> str:
    return reverse(
        "comments:formulation-comments",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _comment_detail_url(org_id, comment_id) -> str:
    return reverse(
        "comments:comment-detail",
        kwargs={"org_id": org_id, "comment_id": comment_id},
    )


def _comment_resolve_url(org_id, comment_id) -> str:
    return reverse(
        "comments:comment-resolve",
        kwargs={"org_id": org_id, "comment_id": comment_id},
    )


def _comment_unresolve_url(org_id, comment_id) -> str:
    return reverse(
        "comments:comment-unresolve",
        kwargs={"org_id": org_id, "comment_id": comment_id},
    )


def _mentionable_url(org_id) -> str:
    return reverse(
        "comments:members-mentionable", kwargs={"org_id": org_id}
    )


@pytest.fixture
def owner_client(api_client: APIClient):
    user = UserFactory(email="owner@comments.test", password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Comments Co")
    _login(api_client, user)
    return api_client, user, org


class TestFormulationCommentsCRUD:
    def test_owner_posts_comment(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        response = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "Looks good."},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["body"] == "Looks good."
        assert body["author"]["kind"] == "member"
        assert body["is_resolved"] is False
        assert Comment.objects.filter(organization=org).count() == 1

    def test_blank_body_returns_code(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        response = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "   "},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "comment_body_blank" in response.json().get("body", [])

    def test_reply_to_reply_rejected_with_code(
        self, owner_client
    ) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)

        root = Comment.objects.create(
            organization=org,
            author=user,
            body="root",
            content_type=_ct(formulation),
            object_id=formulation.id,
            formulation=formulation,
        )
        reply = Comment.objects.create(
            organization=org,
            author=user,
            body="reply",
            content_type=_ct(formulation),
            object_id=formulation.id,
            formulation=formulation,
            parent=root,
        )

        response = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "bad", "parent_id": str(reply.id)},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "comment_reply_depth_exceeded" in response.json().get(
            "parent_id", []
        )

    def test_list_returns_thread(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        for i in range(3):
            client.post(
                _formulation_comments_url(
                    str(org.id), str(formulation.id)
                ),
                {"body": f"c{i}"},
                format="json",
            )
        response = client.get(
            _formulation_comments_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["results"]) == 3


class TestEditDelete:
    def test_author_edits_own_comment(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        post = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "v1"},
            format="json",
        ).json()

        response = client.patch(
            _comment_detail_url(str(org.id), post["id"]),
            {"body": "v2"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["body"] == "v2"
        assert response.json()["is_edited"] is True

    def test_non_author_cannot_edit(
        self, owner_client, api_client: APIClient
    ) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        post = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "v1"},
            format="json",
        ).json()

        intruder = UserFactory(email="intruder@comments.test")
        MembershipFactory(
            user=intruder,
            organization=org,
            permissions={
                "formulations": [
                    "view",
                    "comments_view",
                    "comments_write",
                ]
            },
        )
        other_client = APIClient()
        _login(other_client, intruder)
        response = other_client.patch(
            _comment_detail_url(str(org.id), post["id"]),
            {"body": "hacked"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_delete_author_succeeds(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        post = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "gone"},
            format="json",
        ).json()

        response = client.delete(
            _comment_detail_url(str(org.id), post["id"])
        )
        assert response.status_code == status.HTTP_204_NO_CONTENT
        comment = Comment.objects.get(id=post["id"])
        assert comment.is_deleted is True


class TestResolveUnresolve:
    def test_owner_resolves_and_unresolves(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        post = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "thread"},
            format="json",
        ).json()

        res = client.post(_comment_resolve_url(str(org.id), post["id"]))
        assert res.status_code == status.HTTP_200_OK
        assert res.json()["is_resolved"] is True

        un = client.post(_comment_unresolve_url(str(org.id), post["id"]))
        assert un.status_code == status.HTTP_200_OK
        assert un.json()["is_resolved"] is False

    def test_resolve_on_reply_returns_code(self, owner_client) -> None:
        client, user, org = owner_client
        formulation = FormulationFactory(organization=org, created_by=user)
        root = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "root"},
            format="json",
        ).json()
        reply = client.post(
            _formulation_comments_url(str(org.id), str(formulation.id)),
            {"body": "reply", "parent_id": root["id"]},
            format="json",
        ).json()
        response = client.post(
            _comment_resolve_url(str(org.id), reply["id"])
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "comment_resolve_non_root" in response.json().get(
            "is_resolved", []
        )


class TestPermissions:
    def test_unauthenticated_rejected(self, api_client: APIClient) -> None:
        org = create_organization(
            user=UserFactory(password=DEFAULT_TEST_PASSWORD),
            name="X",
        )
        formulation = FormulationFactory(
            organization=org, created_by=org.created_by
        )
        response = api_client.get(
            _formulation_comments_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_hits_404(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(
            email="o@x.test", password=DEFAULT_TEST_PASSWORD
        )
        org = create_organization(user=owner, name="HiddenCo")
        formulation = FormulationFactory(organization=org, created_by=owner)
        outsider = UserFactory(
            email="out@comments.test", password=DEFAULT_TEST_PASSWORD
        )
        _login(api_client, outsider)
        response = api_client.get(
            _formulation_comments_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_without_capability_gets_403(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(
            email="owner@caps.test", password=DEFAULT_TEST_PASSWORD
        )
        org = create_organization(user=owner, name="CapsCo")
        formulation = FormulationFactory(organization=org, created_by=owner)
        member = UserFactory(
            email="member@caps.test", password=DEFAULT_TEST_PASSWORD
        )
        # Only ``view`` granted — explicitly no comments_view.
        MembershipFactory(
            user=member,
            organization=org,
            permissions={"formulations": ["view"]},
        )
        _login(api_client, member)
        response = api_client.get(
            _formulation_comments_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestMentionableMembers:
    def test_returns_active_members(self, owner_client) -> None:
        client, _user, org = owner_client
        alice = UserFactory(
            first_name="Alice", last_name="A", email="alice@m.test"
        )
        MembershipFactory(
            user=alice,
            organization=org,
            permissions={"formulations": ["view", "comments_view"]},
        )
        response = client.get(_mentionable_url(str(org.id)) + "?q=alice")
        assert response.status_code == status.HTTP_200_OK
        results = response.json()["results"]
        emails = {r["email"] for r in results}
        assert "alice@m.test" in emails


def _ct(instance):
    from django.contrib.contenttypes.models import ContentType
    return ContentType.objects.get_for_model(instance.__class__)


# ---------------------------------------------------------------------------
# CFF (Custom Formulation Request) submission comments — internal
# triage thread keyed off the new ``cff_submission`` polymorphic
# target. The endpoint differs from the formulation / spec / proposal
# variants in two ways:
#
#   1. Different capability gate — ``cff_submissions.view`` rather
#      than ``formulations.comments_view``.
#   2. Default visibility — ``internal`` rather than ``shared`` (the
#      customer who filled the CFF never sees this thread).
# ---------------------------------------------------------------------------


def _cff_comments_url(org_id, submission_id) -> str:
    return reverse(
        "comments:cff-submission-comments",
        kwargs={"org_id": org_id, "submission_id": submission_id},
    )


def _make_cff_submission(org):
    """Build a minimal CFFSubmission row for the test. Lives here
    so the test module stays self-contained — the CFF app's
    ``_make_submission_row`` helper is private to its own test
    file."""

    import uuid
    from datetime import datetime, timezone

    from apps.cff_submissions.models import (
        CFFSubmission,
        CFFSubmissionStatus,
    )

    return CFFSubmission.objects.create(
        organization=org,
        wix_submission_id=uuid.uuid4(),
        # ``wix_form_id`` is a ``UUIDField`` on the model — Wix
        # form ids are real UUIDs even though they look like
        # opaque slugs on the wire. A plain string would fail
        # validation here.
        wix_form_id=uuid.uuid4(),
        wix_namespace="wix.form_app.form",
        wix_status=CFFSubmissionStatus.CONFIRMED,
        wix_created_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        wix_updated_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        raw_payload={"submissions": {"email_fc7d": "client@example.com"}},
    )


class TestCFFSubmissionComments:
    def test_owner_posts_cff_comment(self, owner_client) -> None:
        # Owners short-circuit every capability check via the
        # ``has_capability`` path, so this also covers the happy
        # case for the ``cff_submissions.view`` gate.
        client, _user, org = owner_client
        submission = _make_cff_submission(org)

        response = client.post(
            _cff_comments_url(str(org.id), str(submission.id)),
            {"body": "Triage: looks like a fit for the burner range."},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["body"].startswith("Triage: looks like a fit")
        assert body["target_type"] == "cff_submission"
        assert body["target_id"] == str(submission.id)
        # CFF is internal triage — staff-only — so the default
        # visibility on the persisted row must NOT be ``shared``.
        # The wire shape (CommentReadSerializer) doesn't expose
        # ``visibility`` today, so we assert against the DB row
        # directly. Comment also carries the denormalised FK that
        # the inbox + WS broadcast layers route off.
        from apps.comments.models import Comment
        comment = Comment.objects.get(id=body["id"])
        assert comment.cff_submission_id == submission.id
        assert comment.visibility == Comment.Visibility.INTERNAL

    def test_list_returns_only_this_threads_comments(
        self, owner_client,
    ) -> None:
        # Posting on submission A must not surface on submission B's
        # thread — the per-row filter is the same denormalised FK
        # column the broadcast layer uses, so a regression on one
        # would point at a typo on the other.
        client, _user, org = owner_client
        sub_a = _make_cff_submission(org)
        sub_b = _make_cff_submission(org)
        client.post(
            _cff_comments_url(str(org.id), str(sub_a.id)),
            {"body": "on A"}, format="json",
        )
        client.post(
            _cff_comments_url(str(org.id), str(sub_b.id)),
            {"body": "on B"}, format="json",
        )

        response = client.get(_cff_comments_url(str(org.id), str(sub_a.id)))
        assert response.status_code == status.HTTP_200_OK
        bodies = [c["body"] for c in response.json()["results"]]
        assert bodies == ["on A"]

    def test_member_without_cff_view_is_forbidden(
        self, api_client: APIClient,
    ) -> None:
        # ``cff_submissions.view`` is the gate; a member without it
        # should hit 403 (or 404 if the permission class collapses
        # the leak surface — either way, NOT 201).
        owner = UserFactory(email="cff-owner@x.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="CFF Co")
        submission = _make_cff_submission(org)

        member = UserFactory(
            email="cff-member@x.test", password=DEFAULT_TEST_PASSWORD,
        )
        # Grant formulations.view + comments_view (the "old" gate) —
        # the response must still refuse because the CFF endpoint
        # checks the CFF module specifically.
        MembershipFactory(
            user=member,
            organization=org,
            permissions={"formulations": ["view", "comments_view"]},
        )
        _login(api_client, member)

        response = api_client.post(
            _cff_comments_url(str(org.id), str(submission.id)),
            {"body": "should fail"},
            format="json",
        )
        assert response.status_code in (
            status.HTTP_403_FORBIDDEN,
            status.HTTP_404_NOT_FOUND,
        )

    def test_member_with_cff_view_can_post(
        self, api_client: APIClient,
    ) -> None:
        # A commercial / triage role with ONLY the CFF capability
        # (no formulations module access) can still comment — this
        # is the access-axis decision behind the new permission gate.
        owner = UserFactory(email="cff-owner2@x.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="CFF Co 2")
        submission = _make_cff_submission(org)

        triager = UserFactory(
            email="cff-triager@x.test", password=DEFAULT_TEST_PASSWORD,
        )
        MembershipFactory(
            user=triager,
            organization=org,
            permissions={"cff_submissions": ["view"]},
        )
        _login(api_client, triager)

        response = api_client.post(
            _cff_comments_url(str(org.id), str(submission.id)),
            {"body": "from triage"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
