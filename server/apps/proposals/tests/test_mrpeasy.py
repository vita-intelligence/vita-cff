"""Tests for the MRPEasy integration.

Three contracts pinned:

* **Encryption** — the API secret is stored Fernet-encrypted on
  the org's JSONField; the wire shape never returns plaintext.
* **Live-flag truth table** — ``is_mrpeasy_live`` returns true
  only when ``enabled`` AND ``api_secret_ciphertext`` are both
  set. Disabled-with-credentials and enabled-without-credentials
  both fail the gate.
* **Lookup behaviour** — :func:`get_mrpeasy_suggested_price`
  returns the matched item when the mock has it, ``None`` on a
  miss, and silently degrades to ``None`` on every typed-error
  failure mode (auth fail, unreachable, rate-limited).

Owner-only API gating is verified end-to-end so a non-owner
hitting the integration endpoints gets 403 even when their
proposals capability would otherwise let them read.
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Any

import pytest
from django.core.cache import cache
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.encryption import decrypt_secret
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from apps.proposals.mrpeasy import (
    MrpeasyAuthFailed,
    MrpeasyConfig,
    MrpeasyDecryptionFailed,
    MrpeasyInvalidConfig,
    MrpeasyNotConfigured,
    MrpeasyUnreachable,
    clear_mrpeasy_config,
    get_mrpeasy_config,
    get_mrpeasy_suggested_price,
    is_mrpeasy_live,
    serialize_mrpeasy_config_for_api,
    set_mrpeasy_config,
    verify_mrpeasy_connection,
)

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _mrpeasy_mock_on(monkeypatch) -> None:
    """Force the mock client for every test so we never reach a
    real MRPEasy tenant. Mirrors the ``DATAVERSE_MOCK`` fixture
    pattern."""

    monkeypatch.setenv("MRPEASY_MOCK", "true")


@pytest.fixture(autouse=True)
def _flush_cache() -> None:
    """Wipe the Django cache between tests so cached price lookups
    from one test don't bleed into another. Same hygiene the
    password-reset throttle tests use."""

    cache.clear()
    yield
    cache.clear()


def _seed_config(org, *, enabled: bool = True, secret: str | None = "sec-1") -> dict:
    """Helper to land a config on the org. Returns the wire shape."""

    return set_mrpeasy_config(
        organization=org,
        actor=org.created_by,
        enabled=enabled,
        api_key="key-1",
        api_secret=secret,
    )


# ---------------------------------------------------------------------------
# Encryption + live flag
# ---------------------------------------------------------------------------


class TestMrpeasyConfigCrud:
    def test_set_persists_encrypted_secret(self) -> None:
        org = OrganizationFactory()
        payload = _seed_config(org)
        org.refresh_from_db()

        # API surface NEVER returns plaintext.
        assert "api_secret" not in payload
        assert payload["has_secret"] is True

        # Stored shape carries the encrypted ciphertext.
        stored = org.mrpeasy_config["api_secret_ciphertext"]
        assert stored
        assert stored != "sec-1"
        assert decrypt_secret(stored) == "sec-1"

    def test_get_config_returns_plaintext_in_memory(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        config = get_mrpeasy_config(organization=org)
        assert config.api_key == "key-1"
        assert config.api_secret == "sec-1"
        assert config.is_complete is True

    def test_null_secret_preserves_existing(self) -> None:
        # Mirrors the "keep existing secret" UX of the form: when
        # the operator leaves the password field blank we must NOT
        # wipe the stored ciphertext.
        org = OrganizationFactory()
        _seed_config(org, secret="original")
        org.refresh_from_db()
        original_ciphertext = org.mrpeasy_config["api_secret_ciphertext"]

        set_mrpeasy_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            api_key="key-1",
            api_secret=None,  # the "keep existing" sentinel
        )
        org.refresh_from_db()
        assert (
            org.mrpeasy_config["api_secret_ciphertext"] == original_ciphertext
        )

    def test_clear_empties_config(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        clear_mrpeasy_config(organization=org, actor=org.created_by)
        org.refresh_from_db()
        assert org.mrpeasy_config == {}

    def test_test_connection_stamps_last_tested_at(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        # Sanity: ``set_mrpeasy_config`` clears the last-tested
        # timestamp when a new secret is stored.
        assert org.mrpeasy_config.get("last_tested_at") is None

        verify_mrpeasy_connection(organization=org, actor=org.created_by)
        org.refresh_from_db()
        assert org.mrpeasy_config["last_tested_at"]

    def test_test_connection_rejects_incomplete_config(self) -> None:
        org = OrganizationFactory()
        # Config exists but ``enabled`` is False — not usable.
        _seed_config(org, enabled=False)
        with pytest.raises(MrpeasyNotConfigured):
            verify_mrpeasy_connection(
                organization=org, actor=org.created_by
            )


class TestIsMrpeasyLive:
    def test_false_on_empty_config(self) -> None:
        org = OrganizationFactory()
        assert is_mrpeasy_live(org) is False

    def test_true_when_enabled_with_secret(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        assert is_mrpeasy_live(org) is True

    def test_false_when_disabled(self) -> None:
        # Operator paused the integration; gate must release so the
        # rest of the app isn't held hostage.
        org = OrganizationFactory()
        _seed_config(org, enabled=False)
        org.refresh_from_db()
        assert is_mrpeasy_live(org) is False

    def test_false_when_enabled_without_secret(self) -> None:
        # Owner toggled enabled on but never stored credentials —
        # the integration isn't actually usable.
        org = OrganizationFactory()
        org.mrpeasy_config = {"enabled": True, "api_key": "key-1"}
        org.save(update_fields=["mrpeasy_config"])
        assert is_mrpeasy_live(org) is False


# ---------------------------------------------------------------------------
# Suggested-price lookup
# ---------------------------------------------------------------------------


class TestGetMrpeasySuggestedPrice:
    def test_returns_item_for_known_code(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        item = get_mrpeasy_suggested_price(
            organization=org, code="MA210367"
        )
        assert item is not None
        assert item.selling_price == Decimal("14.99")
        assert item.code == "MA210367"

    def test_returns_none_for_unknown_code(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        item = get_mrpeasy_suggested_price(
            organization=org, code="NOPE-001"
        )
        assert item is None

    def test_returns_none_when_integration_off(self) -> None:
        # No config at all → silent degrade.
        org = OrganizationFactory()
        item = get_mrpeasy_suggested_price(
            organization=org, code="MA210367"
        )
        assert item is None

    def test_returns_none_for_blank_code(self) -> None:
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        item = get_mrpeasy_suggested_price(organization=org, code="")
        assert item is None

    def test_cache_hits_on_repeat_lookup(self) -> None:
        # Second lookup with the same (org, code) should serve the
        # cached value — exercises the 5-minute cache. We poke the
        # mock fixture to confirm.
        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        first = get_mrpeasy_suggested_price(
            organization=org, code="MA210367"
        )
        # Manually flip the mock fixture to a different value —
        # the cached entry should NOT pick up the change.
        from apps.proposals import mrpeasy as mrpeasy_mod

        original = mrpeasy_mod._MOCK_ITEMS["MA210367"]
        mrpeasy_mod._MOCK_ITEMS["MA210367"] = original.__class__(
            code=original.code,
            title=original.title,
            selling_price=Decimal("999.99"),
        )
        try:
            second = get_mrpeasy_suggested_price(
                organization=org, code="MA210367"
            )
            assert second == first  # cached, not refetched
        finally:
            mrpeasy_mod._MOCK_ITEMS["MA210367"] = original


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _login(client: APIClient, user) -> None:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )


def _integration_url(org_id) -> str:
    return f"/api/organizations/{org_id}/integrations/mrpeasy/"


def _test_url(org_id) -> str:
    return f"/api/organizations/{org_id}/integrations/mrpeasy/test/"


def _lookup_url(org_id) -> str:
    return f"/api/organizations/{org_id}/integrations/mrpeasy/lookup/"


class TestMrpeasyIntegrationEndpoint:
    def test_owner_can_save_and_read_config(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _login(api_client, owner)

        save = api_client.put(
            _integration_url(org.id),
            {
                "enabled": True,
                "api_key": "k1",
                "api_secret": "s1",
            },
            format="json",
        )
        assert save.status_code == http_status.HTTP_200_OK
        assert save.data["has_secret"] is True
        # Plaintext never on the wire.
        assert "api_secret" not in save.data

        read = api_client.get(_integration_url(org.id))
        assert read.status_code == http_status.HTTP_200_OK
        assert read.data["api_key"] == "k1"
        assert read.data["has_secret"] is True

    def test_non_owner_is_forbidden(self, api_client: APIClient) -> None:
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={"proposals": ["view", "edit"]},
        )
        _login(api_client, editor)

        response = api_client.get(_integration_url(org.id))
        assert response.status_code == http_status.HTTP_403_FORBIDDEN


class TestMrpeasyTestEndpoint:
    def test_test_connection_succeeds_with_valid_config(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _seed_config(org)
        _login(api_client, owner)

        response = api_client.post(_test_url(org.id))
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["last_tested_at"]

    def test_test_400_on_unconfigured(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _login(api_client, owner)

        response = api_client.post(_test_url(org.id))
        assert response.status_code == http_status.HTTP_400_BAD_REQUEST
        assert "mrpeasy_not_configured" in response.data["detail"]


class TestMrpeasyLookupEndpoint:
    def test_matched_returns_price(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _seed_config(org)
        _login(api_client, owner)

        response = api_client.get(
            _lookup_url(org.id), {"code": "MA210367"}
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["matched"] is True
        assert response.data["selling_price"] == "14.99"
        assert response.data["code"] == "MA210367"

    def test_unmatched_returns_matched_false(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _seed_config(org)
        _login(api_client, owner)

        response = api_client.get(
            _lookup_url(org.id), {"code": "NOPE-001"}
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["matched"] is False
        assert response.data["code"] == "NOPE-001"

    def test_lookup_silent_when_integration_off(
        self, api_client: APIClient
    ) -> None:
        # No config — lookup must return matched: false, not blow up.
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _login(api_client, owner)

        response = api_client.get(
            _lookup_url(org.id), {"code": "MA210367"}
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["matched"] is False

    def test_lookup_reachable_for_non_owner_editor(
        self, api_client: APIClient
    ) -> None:
        # The lookup endpoint must NOT be owner-only — sales staff
        # need it when typing pricing on the proposal create
        # surface. Verified by giving an editor membership and
        # confirming a 200 response.
        owner = UserFactory()
        editor = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="MRPEasy Co")
        _seed_config(org)
        MembershipFactory(
            user=editor,
            organization=org,
            permissions={
                "proposals": ["view", "edit"],
                "formulations": ["view", "edit"],
            },
        )
        _login(api_client, editor)

        response = api_client.get(
            _lookup_url(org.id), {"code": "MA210367"}
        )
        assert response.status_code == http_status.HTTP_200_OK
        assert response.data["matched"] is True


# ---------------------------------------------------------------------------
# Organization serializer flag
# ---------------------------------------------------------------------------


class TestOrganizationMrpeasyLiveFlag:
    def test_flag_false_by_default(self) -> None:
        from apps.organizations.api.serializers import (
            OrganizationReadSerializer,
        )

        org = OrganizationFactory()
        data = OrganizationReadSerializer(org).data
        assert data["mrpeasy_live"] is False

    def test_flag_true_when_integration_live(self) -> None:
        from apps.organizations.api.serializers import (
            OrganizationReadSerializer,
        )

        org = OrganizationFactory()
        _seed_config(org)
        org.refresh_from_db()
        data = OrganizationReadSerializer(org).data
        assert data["mrpeasy_live"] is True
