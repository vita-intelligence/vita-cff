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
