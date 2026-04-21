"""Integration tests for the kiosk (public) comment endpoints."""

from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.comments.kiosk import (
    KIOSK_RATE_LIMIT_MAX_COMMENTS,
    KIOSK_SESSION_COOKIE_PREFIX,
)
from apps.comments.models import Comment, KioskSession
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.specifications.models import SpecificationSheet
from apps.specifications.services import rotate_public_token


pytestmark = pytest.mark.django_db


@pytest.fixture
def shared_sheet():
    """Seed an org + formulation + spec sheet with an issued share token."""

    from apps.formulations.models import FormulationVersion

    owner = UserFactory(email="kiosk-owner@vita.test")
    org = create_organization(user=owner, name="KioskCo")
    formulation = FormulationFactory(organization=org, created_by=owner)
    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=1,
        label="v1",
        created_by=owner,
    )
    sheet = SpecificationSheet.objects.create(
        organization=org,
        formulation_version=version,
        code="MA-KIOSK-1",
        created_by=owner,
        updated_by=owner,
    )
    rotate_public_token(sheet=sheet, actor=owner)
    sheet.refresh_from_db()
    return sheet


def _identify_url(token) -> str:
    return reverse("comments:public-identify", kwargs={"token": token})


def _comments_url(token) -> str:
    return reverse("comments:public-comments", kwargs={"token": token})


class TestIdentify:
    def test_happy_path_sets_signed_cookie(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        response = api_client.post(
            _identify_url(str(shared_sheet.public_token)),
            {
                "name": "Jane Doe",
                "email": "jane@acme.example",
                "company": "ACME",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["email"] == "jane@acme.example"
        # Cookie uses a token-scoped name so two shares don't collide.
        cookie_names = [
            name
            for name in response.cookies.keys()
            if name.startswith(KIOSK_SESSION_COOKIE_PREFIX)
        ]
        assert len(cookie_names) == 1
        assert KioskSession.objects.count() == 1

    def test_missing_name_rejected_400(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        response = api_client.post(
            _identify_url(str(shared_sheet.public_token)),
            {"name": "", "email": "jane@acme.example"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_revoked_token_is_404(self, api_client: APIClient) -> None:
        # Unknown token → 404 with the kiosk_token_invalid code.
        response = api_client.post(
            _identify_url("deadbeef-dead-beef-dead-beefdeadbeef"),
            {"name": "x", "email": "x@x.test"},
            format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND


class TestPublicComments:
    def test_identified_visitor_can_post(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        api_client.post(
            _identify_url(str(shared_sheet.public_token)),
            {"name": "Jane", "email": "jane@acme.example"},
            format="json",
        )
        response = api_client.post(
            _comments_url(str(shared_sheet.public_token)),
            {"body": "Looks great, one question about dosage."},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert response.json()["author"]["kind"] == "guest"
        assert response.json()["author"]["name"] == "Jane"
        assert Comment.objects.filter(
            specification_sheet=shared_sheet
        ).count() == 1

    def test_unidentified_post_rejected_403(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        response = api_client.post(
            _comments_url(str(shared_sheet.public_token)),
            {"body": "hi"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN
        assert "kiosk_session_invalid" in response.json().get("detail", [])

    def test_list_is_open_without_cookie(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        response = api_client.get(
            _comments_url(str(shared_sheet.public_token))
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert set(body.keys()) == {"next", "previous", "results"}

    def test_rotation_revokes_existing_session(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        api_client.post(
            _identify_url(str(shared_sheet.public_token)),
            {"name": "Jane", "email": "jane@acme.example"},
            format="json",
        )
        owner = shared_sheet.created_by
        rotate_public_token(sheet=shared_sheet, actor=owner)
        shared_sheet.refresh_from_db()

        # Posting against the new token with the stale cookie fails —
        # the cookie was issued for the previous token.
        response = api_client.post(
            _comments_url(str(shared_sheet.public_token)),
            {"body": "hi"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestRateLimit:
    def test_over_cap_rejected(
        self, api_client: APIClient, shared_sheet
    ) -> None:
        api_client.post(
            _identify_url(str(shared_sheet.public_token)),
            {"name": "Jane", "email": "jane@acme.example"},
            format="json",
        )
        url = _comments_url(str(shared_sheet.public_token))
        for i in range(KIOSK_RATE_LIMIT_MAX_COMMENTS):
            resp = api_client.post(url, {"body": f"msg {i}"}, format="json")
            assert resp.status_code == status.HTTP_201_CREATED
        over = api_client.post(url, {"body": "one too many"}, format="json")
        assert over.status_code == status.HTTP_403_FORBIDDEN
        assert "kiosk_rate_limited" in over.json().get("detail", [])
