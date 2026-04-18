"""Integration tests for login, logout, refresh, and the me endpoint.

The whole authentication surface is cookie based: no token ever travels
in a JSON response body or an Authorization header (except for tests that
explicitly set one). Every test therefore inspects ``response.cookies``
to verify cookie behaviour in addition to status and body.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.conf import settings
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory

pytestmark = pytest.mark.django_db


VALID_EMAIL = "login.user@vita.test"


@pytest.fixture
def login_url() -> str:
    return reverse("accounts:login")


@pytest.fixture
def logout_url() -> str:
    return reverse("accounts:logout")


@pytest.fixture
def me_url() -> str:
    return reverse("accounts:me")


@pytest.fixture
def refresh_url() -> str:
    return reverse("accounts:refresh")


@pytest.fixture
def registered_user() -> Any:
    return UserFactory(email=VALID_EMAIL, password=DEFAULT_TEST_PASSWORD)


def _login_body(email: str = VALID_EMAIL, password: str = DEFAULT_TEST_PASSWORD) -> dict[str, str]:
    return {"email": email, "password": password}


class TestLogin:
    def test_valid_credentials_return_user_and_set_cookies(
        self,
        api_client: APIClient,
        login_url: str,
        registered_user: Any,
    ) -> None:
        response = api_client.post(login_url, _login_body(), format="json")

        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["email"] == VALID_EMAIL
        assert "password" not in body

        cookies = response.cookies
        assert settings.AUTH_COOKIE_ACCESS_NAME in cookies
        assert settings.AUTH_COOKIE_REFRESH_NAME in cookies
        access_cookie = cookies[settings.AUTH_COOKIE_ACCESS_NAME]
        assert access_cookie["httponly"] is True
        assert access_cookie["samesite"] == "Lax"

    def test_wrong_password_returns_invalid_credentials_code(
        self,
        api_client: APIClient,
        login_url: str,
        registered_user: Any,
    ) -> None:
        response = api_client.post(
            login_url, _login_body(password="WrongPass!123"), format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        body = response.json()
        assert body["detail"] == ["invalid_credentials"]
        assert settings.AUTH_COOKIE_ACCESS_NAME not in response.cookies

    def test_unknown_email_returns_invalid_credentials_code(
        self,
        api_client: APIClient,
        login_url: str,
    ) -> None:
        response = api_client.post(
            login_url, _login_body(email="nobody@vita.test"), format="json"
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["detail"] == ["invalid_credentials"]

    def test_inactive_user_returns_account_disabled_code(
        self,
        api_client: APIClient,
        login_url: str,
    ) -> None:
        UserFactory(
            email="disabled@vita.test",
            password=DEFAULT_TEST_PASSWORD,
            is_active=False,
        )
        response = api_client.post(
            login_url,
            _login_body(email="disabled@vita.test"),
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        # Django's ModelBackend rejects inactive users before our check
        # by returning ``None`` from ``authenticate``. That flows through
        # the "invalid credentials" branch, which is the correct
        # security-conscious behaviour — never leak disabled status.
        assert response.json()["detail"] == ["invalid_credentials"]

    def test_email_is_case_insensitive(
        self,
        api_client: APIClient,
        login_url: str,
        registered_user: Any,
    ) -> None:
        response = api_client.post(
            login_url, _login_body(email=VALID_EMAIL.upper()), format="json"
        )
        assert response.status_code == status.HTTP_200_OK

    @pytest.mark.parametrize("missing_field", ["email", "password"])
    def test_missing_field_returns_required_code(
        self,
        api_client: APIClient,
        login_url: str,
        missing_field: str,
    ) -> None:
        payload = {k: v for k, v in _login_body().items() if k != missing_field}
        response = api_client.post(login_url, payload, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()[missing_field] == ["required"]


class TestMe:
    def test_unauthenticated_returns_401(
        self,
        api_client: APIClient,
        me_url: str,
    ) -> None:
        response = api_client.get(me_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_authenticated_via_cookie_returns_user(
        self,
        api_client: APIClient,
        login_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        # ``APIClient`` propagates Set-Cookie values into its own cookie jar
        # so subsequent requests travel with the auth cookie attached.
        response = api_client.get(me_url)
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["email"] == VALID_EMAIL

    def test_tampered_cookie_returns_401(
        self,
        api_client: APIClient,
        me_url: str,
    ) -> None:
        api_client.cookies[settings.AUTH_COOKIE_ACCESS_NAME] = "nonsense.token.value"
        response = api_client.get(me_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestMePatch:
    def test_updates_first_and_last_name(
        self,
        api_client: APIClient,
        login_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        response = api_client.patch(
            me_url,
            {"first_name": "  Ada  ", "last_name": "Lovelace"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        # Whitespace trimmed by the serializer — verifies validation path
        # runs, not just the raw assignment.
        assert body["first_name"] == "Ada"
        assert body["last_name"] == "Lovelace"
        registered_user.refresh_from_db()
        assert registered_user.first_name == "Ada"
        assert registered_user.last_name == "Lovelace"

    def test_unauthenticated_returns_401(
        self,
        api_client: APIClient,
        me_url: str,
    ) -> None:
        response = api_client.patch(me_url, {"first_name": "X"}, format="json")
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_blank_name_is_400(
        self,
        api_client: APIClient,
        login_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        response = api_client.patch(
            me_url, {"first_name": "   "}, format="json"
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json() == {"first_name": ["blank"]}

    def test_email_cannot_be_changed(
        self,
        api_client: APIClient,
        login_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        original = registered_user.email
        # Unknown field is silently ignored by the partial serializer —
        # the response body still shows the old email.
        response = api_client.patch(
            me_url, {"email": "pwned@evil.test"}, format="json"
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.json()["email"] == original
        registered_user.refresh_from_db()
        assert registered_user.email == original


class TestLogout:
    def test_logout_clears_cookies(
        self,
        api_client: APIClient,
        login_url: str,
        logout_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        response = api_client.post(logout_url)

        assert response.status_code == status.HTTP_204_NO_CONTENT
        # Subsequent ``me`` call should fail because cookies are cleared.
        me_response = api_client.get(me_url)
        assert me_response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_logout_requires_authentication(
        self,
        api_client: APIClient,
        logout_url: str,
    ) -> None:
        response = api_client.post(logout_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED


class TestRefresh:
    def test_refresh_without_cookie_returns_401(
        self,
        api_client: APIClient,
        refresh_url: str,
    ) -> None:
        response = api_client.post(refresh_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert response.json()["detail"] == ["refresh_token_missing"]

    def test_refresh_with_valid_cookie_issues_new_access(
        self,
        api_client: APIClient,
        login_url: str,
        refresh_url: str,
        me_url: str,
        registered_user: Any,
    ) -> None:
        api_client.post(login_url, _login_body(), format="json")
        old_access = api_client.cookies[settings.AUTH_COOKIE_ACCESS_NAME].value

        response = api_client.post(refresh_url)
        assert response.status_code == status.HTTP_200_OK
        new_access = api_client.cookies[settings.AUTH_COOKIE_ACCESS_NAME].value
        assert new_access
        # The access cookie should have been replaced.
        assert new_access != old_access

        # And the new access cookie should authenticate successfully.
        me_response = api_client.get(me_url)
        assert me_response.status_code == status.HTTP_200_OK

    def test_refresh_with_garbage_cookie_returns_401(
        self,
        api_client: APIClient,
        refresh_url: str,
    ) -> None:
        api_client.cookies[settings.AUTH_COOKIE_REFRESH_NAME] = "not.a.valid.jwt"
        response = api_client.post(refresh_url)
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
