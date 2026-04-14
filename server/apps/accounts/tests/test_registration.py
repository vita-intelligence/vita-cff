"""Integration tests for the registration endpoint."""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory

UserModel = get_user_model()

pytestmark = pytest.mark.django_db


VALID_PAYLOAD: dict[str, str] = {
    "email": "new.scientist@vita.test",
    "first_name": "Ada",
    "last_name": "Lovelace",
    "password": DEFAULT_TEST_PASSWORD,
    "password_confirm": DEFAULT_TEST_PASSWORD,
}


def _post(client: APIClient, url: str, payload: dict[str, Any]) -> Any:
    return client.post(url, payload, format="json")


class TestRegistrationHappyPath:
    def test_returns_201_and_public_user_payload(
        self, api_client: APIClient, register_url: str
    ) -> None:
        response = _post(api_client, register_url, VALID_PAYLOAD)

        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["email"] == VALID_PAYLOAD["email"]
        assert body["first_name"] == VALID_PAYLOAD["first_name"]
        assert body["last_name"] == VALID_PAYLOAD["last_name"]
        assert body["full_name"] == "Ada Lovelace"
        assert "id" in body
        assert "date_joined" in body

    def test_response_never_leaks_credentials(
        self, api_client: APIClient, register_url: str
    ) -> None:
        response = _post(api_client, register_url, VALID_PAYLOAD)

        body = response.json()
        assert "password" not in body
        assert "password_confirm" not in body

    def test_persists_user_with_hashed_password(
        self, api_client: APIClient, register_url: str
    ) -> None:
        _post(api_client, register_url, VALID_PAYLOAD)

        user = UserModel.objects.get(email=VALID_PAYLOAD["email"])
        assert user.password != VALID_PAYLOAD["password"]
        assert user.check_password(VALID_PAYLOAD["password"]) is True
        assert user.is_active is True
        assert user.is_staff is False
        assert user.is_superuser is False

    def test_unauthenticated_clients_can_register(
        self, api_client: APIClient, register_url: str
    ) -> None:
        # No credentials attached to the client.
        response = _post(api_client, register_url, VALID_PAYLOAD)
        assert response.status_code == status.HTTP_201_CREATED


class TestRegistrationValidation:
    def test_duplicate_email_exact_match_is_rejected(
        self, api_client: APIClient, register_url: str
    ) -> None:
        UserFactory(email=VALID_PAYLOAD["email"])

        response = _post(api_client, register_url, VALID_PAYLOAD)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["email_already_exists"]

    def test_duplicate_email_case_insensitive_is_rejected(
        self, api_client: APIClient, register_url: str
    ) -> None:
        UserFactory(email="case@vita.test")

        payload = {**VALID_PAYLOAD, "email": "CASE@VITA.TEST"}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["email_already_exists"]

    def test_mismatched_passwords_are_rejected(
        self, api_client: APIClient, register_url: str
    ) -> None:
        payload = {**VALID_PAYLOAD, "password_confirm": "Different$Pass1!"}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["password_confirm"] == ["passwords_do_not_match"]

    @pytest.mark.parametrize(
        ("weak_password", "expected_code"),
        [
            ("short1", "password_too_short"),
            ("password", "password_too_common"),
            ("87654321", "password_entirely_numeric"),
            ("new.scientist", "password_too_similar"),
        ],
    )
    def test_weak_passwords_are_rejected(
        self,
        api_client: APIClient,
        register_url: str,
        weak_password: str,
        expected_code: str,
    ) -> None:
        payload = {
            **VALID_PAYLOAD,
            "password": weak_password,
            "password_confirm": weak_password,
        }
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert expected_code in response.json()["password"]

    @pytest.mark.parametrize(
        "missing_field",
        ["email", "first_name", "last_name", "password", "password_confirm"],
    )
    def test_missing_required_field_is_rejected(
        self, api_client: APIClient, register_url: str, missing_field: str
    ) -> None:
        payload = {k: v for k, v in VALID_PAYLOAD.items() if k != missing_field}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()[missing_field] == ["required"]

    @pytest.mark.parametrize(
        ("blank_field", "expected_code"),
        [
            ("email", "blank"),
            ("first_name", "blank"),
            ("last_name", "blank"),
        ],
    )
    def test_blank_required_field_is_rejected(
        self,
        api_client: APIClient,
        register_url: str,
        blank_field: str,
        expected_code: str,
    ) -> None:
        payload = {**VALID_PAYLOAD, blank_field: ""}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()[blank_field] == [expected_code]

    def test_invalid_email_format_is_rejected(
        self, api_client: APIClient, register_url: str
    ) -> None:
        payload = {**VALID_PAYLOAD, "email": "not-an-email"}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["email"] == ["invalid"]

    def test_email_domain_is_normalized_on_save(
        self, api_client: APIClient, register_url: str
    ) -> None:
        payload = {**VALID_PAYLOAD, "email": "Max@VITA.TEST"}
        response = _post(api_client, register_url, payload)

        assert response.status_code == status.HTTP_201_CREATED
        # Django's normalizer lowercases the domain only.
        assert UserModel.objects.filter(email="Max@vita.test").exists()


class TestRegistrationMethodSafety:
    def test_get_is_not_allowed(
        self, api_client: APIClient, register_url: str
    ) -> None:
        response = api_client.get(register_url)
        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED

    def test_put_is_not_allowed(
        self, api_client: APIClient, register_url: str
    ) -> None:
        response = api_client.put(register_url, VALID_PAYLOAD, format="json")
        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED

    def test_delete_is_not_allowed(
        self, api_client: APIClient, register_url: str
    ) -> None:
        response = api_client.delete(register_url)
        assert response.status_code == status.HTTP_405_METHOD_NOT_ALLOWED
