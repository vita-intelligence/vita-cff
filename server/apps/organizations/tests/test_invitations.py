"""Integration tests for the invitations flow."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from django.conf import settings
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.models import Invitation, Membership
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    InvitationFactory,
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db

UserModel = get_user_model()


@pytest.fixture
def login_url() -> str:
    return reverse("accounts:login")


@pytest.fixture
def owner_client(api_client: APIClient, login_url: str) -> tuple[APIClient, Any, Any]:
    """Return ``(client, owner_user, org)`` with a freshly authenticated session."""

    user = UserFactory(email="founder@vita.test", password=DEFAULT_TEST_PASSWORD)
    api_client.post(
        login_url,
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    org = create_organization(user=user, name="Founders Inc")
    return api_client, user, org


def _invitation_create_url(org_id: str) -> str:
    return reverse("organizations:invitation-list", args=[org_id])


def _invitation_detail_url(token: str) -> str:
    return reverse("organizations:invitation-detail", args=[token])


def _invitation_accept_url(token: str) -> str:
    return reverse("organizations:invitation-accept", args=[token])


# ---------------------------------------------------------------------------
# POST /api/organizations/<id>/invitations/
# ---------------------------------------------------------------------------


class TestCreateInvitation:
    def test_owner_can_create_invitation(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _invitation_create_url(str(org.id)),
            {"email": "newhire@vita.test"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["email"] == "newhire@vita.test"
        assert body["token"]
        assert body["accepted_at"] is None

        invitation = Invitation.objects.get(id=body["id"])
        assert invitation.organization == org

    def test_unauthenticated_cannot_create_invitation(
        self, api_client: APIClient
    ) -> None:
        org = OrganizationFactory()
        response = api_client.post(
            _invitation_create_url(str(org.id)),
            {"email": "newhire@vita.test"},
            format="json",
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_gets_404_not_403(
        self,
        api_client: APIClient,
        login_url: str,
    ) -> None:
        # The caller is authenticated but does not belong to the target org.
        stranger = UserFactory(email="stranger@vita.test", password=DEFAULT_TEST_PASSWORD)
        api_client.post(
            login_url,
            {"email": stranger.email, "password": DEFAULT_TEST_PASSWORD},
            format="json",
        )
        other_org = OrganizationFactory()

        response = api_client.post(
            _invitation_create_url(str(other_org.id)),
            {"email": "newhire@vita.test"},
            format="json",
        )
        # We do not leak org existence to non-members.
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_non_admin_member_is_forbidden(
        self,
        api_client: APIClient,
        login_url: str,
    ) -> None:
        # Member exists but lacks members:admin.
        member_user = UserFactory(
            email="member@vita.test", password=DEFAULT_TEST_PASSWORD
        )
        org = OrganizationFactory()
        MembershipFactory(
            user=member_user,
            organization=org,
            is_owner=False,
            permissions={"members": ["view"]},
        )
        api_client.post(
            login_url,
            {"email": member_user.email, "password": DEFAULT_TEST_PASSWORD},
            format="json",
        )

        response = api_client.post(
            _invitation_create_url(str(org.id)),
            {"email": "newhire@vita.test"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_admin_member_can_invite_without_being_owner(
        self,
        api_client: APIClient,
        login_url: str,
    ) -> None:
        admin_user = UserFactory(
            email="admin@vita.test", password=DEFAULT_TEST_PASSWORD
        )
        org = OrganizationFactory()
        MembershipFactory(
            user=admin_user,
            organization=org,
            is_owner=False,
            permissions={
                "members": ["view", "invite", "edit_permissions", "remove"]
            },
        )
        api_client.post(
            login_url,
            {"email": admin_user.email, "password": DEFAULT_TEST_PASSWORD},
            format="json",
        )

        response = api_client.post(
            _invitation_create_url(str(org.id)),
            {"email": "newhire@vita.test"},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED

    def test_inviting_existing_member_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, owner, org = owner_client
        response = client.post(
            _invitation_create_url(str(org.id)),
            {"email": owner.email},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["email_already_member"]

    def test_existing_pending_invite_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        url = _invitation_create_url(str(org.id))
        client.post(url, {"email": "pending@vita.test"}, format="json")
        response = client.post(url, {"email": "pending@vita.test"}, format="json")

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["invitation_already_exists"]

    def test_invalid_email_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _invitation_create_url(str(org.id)),
            {"email": "not-an-email"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["invalid"]

    def test_missing_email_is_rejected(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _invitation_create_url(str(org.id)), {}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["required"]


# ---------------------------------------------------------------------------
# GET /api/invitations/<token>/
# ---------------------------------------------------------------------------


class TestPublicInvitationDetail:
    def test_returns_minimal_payload(self, api_client: APIClient) -> None:
        invitation = InvitationFactory(email="hire@vita.test")
        response = api_client.get(_invitation_detail_url(invitation.token))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["email"] == "hire@vita.test"
        assert body["organization_name"] == invitation.organization.name
        assert "invited_by_name" in body
        assert "expires_at" in body
        # Secrets must not be echoed on the public endpoint.
        assert "token" not in body
        assert "permissions" not in body

    def test_unknown_token_is_404(self, api_client: APIClient) -> None:
        response = api_client.get(_invitation_detail_url("not-a-real-token"))
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert response.json()["detail"] == ["invitation_not_found"]

    def test_already_accepted_is_410(self, api_client: APIClient) -> None:
        invitation = InvitationFactory()
        invitation.accepted_at = timezone.now()
        invitation.save(update_fields=["accepted_at"])

        response = api_client.get(_invitation_detail_url(invitation.token))
        assert response.status_code == status.HTTP_410_GONE
        assert response.json()["detail"] == ["invitation_already_accepted"]

    def test_expired_is_410(self, api_client: APIClient) -> None:
        invitation = InvitationFactory()
        invitation.expires_at = timezone.now() - timedelta(seconds=1)
        invitation.save(update_fields=["expires_at"])

        response = api_client.get(_invitation_detail_url(invitation.token))
        assert response.status_code == status.HTTP_410_GONE
        assert response.json()["detail"] == ["invitation_expired"]

    def test_endpoint_is_public(self, api_client: APIClient) -> None:
        invitation = InvitationFactory()
        # Purposefully no cookies, no auth headers.
        response = api_client.get(_invitation_detail_url(invitation.token))
        assert response.status_code == status.HTTP_200_OK


# ---------------------------------------------------------------------------
# POST /api/invitations/<token>/accept/
# ---------------------------------------------------------------------------


VALID_ACCEPT_PAYLOAD: dict[str, str] = {
    "first_name": "Grace",
    "last_name": "Hopper",
    "password": "Sup3r$ecret!Test",
    "password_confirm": "Sup3r$ecret!Test",
}


class TestAcceptInvitation:
    def test_happy_path_creates_user_membership_and_sets_cookies(
        self, api_client: APIClient
    ) -> None:
        invitation = InvitationFactory(email="grace@vita.test")

        response = api_client.post(
            _invitation_accept_url(invitation.token),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["email"] == "grace@vita.test"
        assert body["first_name"] == "Grace"
        assert body["last_name"] == "Hopper"

        # Cookies must be set so the invitee lands authenticated.
        cookies = response.cookies
        assert settings.AUTH_COOKIE_ACCESS_NAME in cookies
        assert settings.AUTH_COOKIE_REFRESH_NAME in cookies

        user = UserModel.objects.get(email="grace@vita.test")
        assert user.check_password("Sup3r$ecret!Test") is True

        membership = Membership.objects.get(
            user=user, organization=invitation.organization
        )
        assert membership.is_owner is False
        assert membership.permissions == {}

        invitation.refresh_from_db()
        assert invitation.accepted_at is not None

    def test_accept_sets_permissions_from_invitation(
        self, api_client: APIClient
    ) -> None:
        invitation = InvitationFactory(
            email="scientist@vita.test",
            permissions={"members": ["view"]},
        )
        response = api_client.post(
            _invitation_accept_url(invitation.token),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        user = UserModel.objects.get(email="scientist@vita.test")
        membership = Membership.objects.get(user=user)
        assert membership.permissions == {"members": ["view"]}

    def test_unknown_token_is_404(self, api_client: APIClient) -> None:
        response = api_client.post(
            _invitation_accept_url("fake"),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND
        assert response.json()["detail"] == ["invitation_not_found"]

    def test_already_accepted_is_410(self, api_client: APIClient) -> None:
        invitation = InvitationFactory(email="used@vita.test")
        invitation.accepted_at = timezone.now()
        invitation.save(update_fields=["accepted_at"])

        response = api_client.post(
            _invitation_accept_url(invitation.token),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_410_GONE
        assert response.json()["detail"] == ["invitation_already_accepted"]

    def test_expired_is_410(self, api_client: APIClient) -> None:
        invitation = InvitationFactory(email="late@vita.test")
        invitation.expires_at = timezone.now() - timedelta(seconds=1)
        invitation.save(update_fields=["expires_at"])

        response = api_client.post(
            _invitation_accept_url(invitation.token),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_410_GONE
        assert response.json()["detail"] == ["invitation_expired"]

    def test_existing_user_with_same_email_is_rejected(
        self, api_client: APIClient
    ) -> None:
        # Someone already has an account with this email — accept must
        # not silently overwrite their password.
        UserFactory(email="taken@vita.test", password=DEFAULT_TEST_PASSWORD)
        invitation = InvitationFactory(email="taken@vita.test")

        response = api_client.post(
            _invitation_accept_url(invitation.token),
            VALID_ACCEPT_PAYLOAD,
            format="json",
        )
        assert response.status_code == status.HTTP_409_CONFLICT
        assert response.json()["detail"] == ["email_already_registered"]

    def test_mismatched_passwords_rejected(self, api_client: APIClient) -> None:
        invitation = InvitationFactory()
        payload = {**VALID_ACCEPT_PAYLOAD, "password_confirm": "Different1!"}
        response = api_client.post(
            _invitation_accept_url(invitation.token), payload, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["password_confirm"] == ["passwords_do_not_match"]

    @pytest.mark.parametrize(
        "missing",
        ["first_name", "last_name", "password", "password_confirm"],
    )
    def test_missing_field_is_rejected(
        self, api_client: APIClient, missing: str
    ) -> None:
        invitation = InvitationFactory()
        payload = {k: v for k, v in VALID_ACCEPT_PAYLOAD.items() if k != missing}
        response = api_client.post(
            _invitation_accept_url(invitation.token), payload, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()[missing] == ["required"]

    def test_weak_password_rejected(self, api_client: APIClient) -> None:
        invitation = InvitationFactory()
        payload = {
            **VALID_ACCEPT_PAYLOAD,
            "password": "short1",
            "password_confirm": "short1",
        }
        response = api_client.post(
            _invitation_accept_url(invitation.token), payload, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "password_too_short" in response.json()["password"]
