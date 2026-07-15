"""API-layer tests for the PSP integration endpoints.

Owner-only guards on config CRUD + test, viewer-friendly gate on
the picker endpoints, silent-degrade behaviour on the items lookup.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.psp import services as psp_services
from apps.psp.services import PspItem


pytestmark = pytest.mark.django_db


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


@pytest.fixture
def owned_org():
    """Owner + org pair. The owner has the implicit is_owner=True
    on their membership, which is what the ``_OwnerOnly`` permission
    class gates on."""

    owner = UserFactory(email="owner@psp.test", password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=owner, name="PSP Co")
    return owner, org


@pytest.fixture
def non_owner_member(owned_org):
    """A member of the same org, no is_owner flag, with just
    ``formulations.view`` so they can hit the picker endpoints but
    are 403'd on the config surface."""

    _owner, org = owned_org
    user = UserFactory(email="viewer@psp.test", password=DEFAULT_TEST_PASSWORD)
    MembershipFactory(
        user=user,
        organization=org,
        permissions={"formulations": ["view"]},
    )
    return user


class TestConfigCRUD:
    def test_owner_can_read_write_delete(self, owned_org):
        owner, org = owned_org
        client = _login(APIClient(), owner)
        url = reverse(
            "psp:psp-integration", kwargs={"org_id": str(org.id)}
        )

        # GET on an unconfigured org — every field defaults.
        r = client.get(url)
        assert r.status_code == status.HTTP_200_OK
        assert r.json() == {
            "enabled": False,
            "base_url": "",
            "has_token": False,
            "last_tested_at": None,
        }

        # PUT — round-trip.
        r = client.put(
            url,
            {
                "enabled": True,
                "base_url": "https://psp.internal",
                "integration_token": "psp_live_secret",
            },
            format="json",
        )
        assert r.status_code == status.HTTP_200_OK
        body = r.json()
        assert body["enabled"] is True
        assert body["base_url"] == "https://psp.internal"
        assert body["has_token"] is True
        # Plaintext token never comes back — critical for security.
        assert "integration_token" not in body

        # DELETE — wipes the config.
        r = client.delete(url)
        assert r.status_code == status.HTTP_200_OK
        assert r.json()["has_token"] is False

    def test_non_owner_cannot_touch_config(self, owned_org, non_owner_member):
        _owner, org = owned_org
        client = _login(APIClient(), non_owner_member)
        url = reverse(
            "psp:psp-integration", kwargs={"org_id": str(org.id)}
        )
        assert client.get(url).status_code == status.HTTP_403_FORBIDDEN
        assert (
            client.put(
                url,
                {"enabled": True, "base_url": "https://x", "integration_token": "t"},
                format="json",
            ).status_code
            == status.HTTP_403_FORBIDDEN
        )
        assert client.delete(url).status_code == status.HTTP_403_FORBIDDEN


class TestTestConnection:
    def test_not_configured_returns_400(self, owned_org):
        owner, org = owned_org
        client = _login(APIClient(), owner)
        url = reverse("psp:psp-test", kwargs={"org_id": str(org.id)})
        r = client.post(url)
        assert r.status_code == status.HTTP_400_BAD_REQUEST
        assert r.json()["detail"] == ["psp_not_configured"]

    def test_success_stamps_last_tested_at(self, owned_org):
        owner, org = owned_org
        psp_services.set_psp_config(
            organization=org,
            actor=owner,
            enabled=True,
            base_url="https://psp",
            integration_token="t",
        )

        class _OkClient:
            def __init__(self, cfg): ...

            def test_connection(self):
                return None

        psp_services._TEST_CLIENT = _OkClient
        try:
            client = _login(APIClient(), owner)
            r = client.post(
                reverse("psp:psp-test", kwargs={"org_id": str(org.id)})
            )
            assert r.status_code == status.HTTP_200_OK
            body = r.json()
            assert body["has_token"] is True
            assert body["last_tested_at"] is not None
        finally:
            psp_services._TEST_CLIENT = None

    def test_auth_failed_returns_400(self, owned_org):
        owner, org = owned_org
        psp_services.set_psp_config(
            organization=org,
            actor=owner,
            enabled=True,
            base_url="https://psp",
            integration_token="bad",
        )

        class _FailClient:
            def __init__(self, cfg): ...

            def test_connection(self):
                raise psp_services.PspAuthFailed("bad creds")

        psp_services._TEST_CLIENT = _FailClient
        try:
            client = _login(APIClient(), owner)
            r = client.post(
                reverse("psp:psp-test", kwargs={"org_id": str(org.id)})
            )
            assert r.status_code == status.HTTP_400_BAD_REQUEST
            assert r.json()["detail"] == ["psp_auth_failed"]
        finally:
            psp_services._TEST_CLIENT = None


class TestPickerEndpoints:
    def test_items_empty_when_not_configured(self, owned_org):
        """Silent degradation: an unconfigured integration returns
        ``{items: []}`` rather than 400 — the modal renders 'no
        matches' identically to a real empty result."""

        _owner, org = owned_org
        viewer = UserFactory(
            email="v2@psp.test", password=DEFAULT_TEST_PASSWORD
        )
        MembershipFactory(
            user=viewer,
            organization=org,
            permissions={"formulations": ["view"]},
        )
        client = _login(APIClient(), viewer)
        url = reverse("psp:psp-items", kwargs={"org_id": str(org.id)})
        r = client.get(url)
        assert r.status_code == status.HTTP_200_OK
        assert r.json() == {"items": []}

    def test_items_pass_through_from_client(self, owned_org):
        owner, org = owned_org
        psp_services.set_psp_config(
            organization=org,
            actor=owner,
            enabled=True,
            base_url="https://psp",
            integration_token="t",
        )

        class _StubClient:
            def __init__(self, cfg): ...

            def list_items(self, *, search=None, item_types=None, use_as=None):
                # Recording the args on the class so the test can
                # assert query params flowed through unchanged.
                _StubClient.calls = {
                    "search": search,
                    "item_types": item_types,
                    "use_as": use_as,
                }
                return [
                    PspItem(
                        uuid="u1",
                        name="Vitamin C",
                        description="",
                        item_type="raw_material",
                        external_sku="VIT-C",
                        code="MA00001",
                        barcode="",
                        is_active=True,
                        use_as="active",
                        product_family_uuid=None,
                        product_family_name=None,
                        selling_price=None,
                        currency_code=None,
                        attributes={
                            "purity": "0.98",
                            "extract_ratio": 1.0,
                            "type": "Vitamin",
                        },
                    )
                ]

            def get_item(self, uuid):
                return None

        psp_services._TEST_CLIENT = _StubClient
        try:
            client = _login(APIClient(), owner)
            url = reverse("psp:psp-items", kwargs={"org_id": str(org.id)})
            r = client.get(
                url,
                {
                    "search": "Vit",
                    "item_types": "raw_material,packaging",
                    "use_as": "active",
                },
            )
            assert r.status_code == status.HTTP_200_OK
            items = r.json()["items"]
            assert len(items) == 1
            assert items[0]["uuid"] == "u1"
            assert items[0]["use_as"] == "active"
            # Full attributes map must reach the FE, otherwise the
            # builder's ``canComputeMaterial`` gate fires
            # "missing_purity" on every PSP-sourced picker row.
            assert items[0]["attributes"] == {
                "purity": "0.98",
                "extract_ratio": 1.0,
                "type": "Vitamin",
            }
            # Query params were parsed correctly.
            assert _StubClient.calls == {
                "search": "Vit",
                "item_types": ["raw_material", "packaging"],
                "use_as": "active",
            }
        finally:
            psp_services._TEST_CLIENT = None

    def test_item_detail_matched_shape(self, owned_org):
        owner, org = owned_org
        psp_services.set_psp_config(
            organization=org,
            actor=owner,
            enabled=True,
            base_url="https://psp",
            integration_token="t",
        )

        class _FoundClient:
            def __init__(self, cfg): ...

            def get_item(self, uuid):
                return PspItem(
                    uuid=uuid,
                    name="Match",
                    description="",
                    item_type="raw_material",
                    external_sku="",
                    code="MA00002",
                    barcode="",
                    is_active=True,
                    use_as=None,
                    product_family_uuid=None,
                    product_family_name=None,
                    selling_price=None,
                    currency_code=None,
                    attributes={},
                )

        psp_services._TEST_CLIENT = _FoundClient
        try:
            client = _login(APIClient(), owner)
            item_uuid = "12345678-1234-1234-1234-123456789abc"
            url = reverse(
                "psp:psp-item-detail",
                kwargs={"org_id": str(org.id), "item_uuid": item_uuid},
            )
            r = client.get(url)
            assert r.status_code == status.HTTP_200_OK
            body = r.json()
            assert body["matched"] is True
            assert body["item"]["uuid"] == item_uuid
        finally:
            psp_services._TEST_CLIENT = None

    def test_item_detail_miss_returns_matched_false(self, owned_org):
        owner, org = owned_org
        psp_services.set_psp_config(
            organization=org,
            actor=owner,
            enabled=True,
            base_url="https://psp",
            integration_token="t",
        )

        class _MissClient:
            def __init__(self, cfg): ...

            def get_item(self, uuid):
                return None

        psp_services._TEST_CLIENT = _MissClient
        try:
            client = _login(APIClient(), owner)
            item_uuid = "12345678-1234-1234-1234-123456789abc"
            url = reverse(
                "psp:psp-item-detail",
                kwargs={"org_id": str(org.id), "item_uuid": item_uuid},
            )
            r = client.get(url)
            assert r.status_code == status.HTTP_200_OK
            assert r.json() == {"matched": False, "uuid": item_uuid}
        finally:
            psp_services._TEST_CLIENT = None
