"""Service-layer tests for the PSP integration.

Covers the pieces that don't hit the HTTP boundary — config
lifecycle, mutual exclusion with MRPEasy, projection, decryption
failure paths.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals import mrpeasy as mrpeasy_module
from apps.psp import services as psp
from apps.psp.services import (
    PspConfig,
    PspInvalidConfig,
    PspItem,
    _project_item,
    clear_psp_config,
    get_psp_config,
    is_psp_live,
    serialize_psp_config_for_api,
    set_psp_config,
)


pytestmark = pytest.mark.django_db


class TestIsPspLive:
    def test_empty_config_is_not_live(self):
        org = OrganizationFactory()
        assert is_psp_live(org) is False

    def test_missing_token_is_not_live(self):
        org = OrganizationFactory()
        org.psp_config = {"enabled": True, "base_url": "https://psp"}
        assert is_psp_live(org) is False

    def test_disabled_is_not_live(self):
        org = OrganizationFactory()
        org.psp_config = {
            "enabled": False,
            "base_url": "https://psp",
            "integration_token_ciphertext": "cipher",
        }
        assert is_psp_live(org) is False

    def test_fully_populated_is_live(self):
        org = OrganizationFactory()
        org.psp_config = {
            "enabled": True,
            "base_url": "https://psp",
            "integration_token_ciphertext": "cipher",
        }
        assert is_psp_live(org) is True


class TestSetPspConfig:
    def test_persists_and_encrypts(self):
        org = OrganizationFactory()
        payload = set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp.internal",
            integration_token="psp_live_secret_1",
        )
        assert payload["enabled"] is True
        assert payload["base_url"] == "https://psp.internal"
        assert payload["has_token"] is True
        assert payload["last_tested_at"] is None
        org.refresh_from_db()
        assert org.psp_config["enabled"] is True
        # Ciphertext must not be the plaintext value.
        assert "psp_live_secret_1" not in org.psp_config["integration_token_ciphertext"]

    def test_empty_token_preserves_stored_ciphertext(self):
        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="original",
        )
        original_cipher = org.psp_config["integration_token_ciphertext"]
        # Re-save with empty token — cipher must persist verbatim.
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp-new",
            integration_token="",
        )
        org.refresh_from_db()
        assert org.psp_config["integration_token_ciphertext"] == original_cipher
        assert org.psp_config["base_url"] == "https://psp-new"

    def test_rotated_token_clears_last_tested(self):
        """``last_tested_at`` MUST clear on token rotation so a
        stale success badge can't hang on a broken integration."""

        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="v1",
        )
        # Simulate a successful test stamp.
        org.psp_config = {
            **org.psp_config,
            "last_tested_at": "2026-07-14T10:00:00",
        }
        org.save(update_fields=["psp_config"])

        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="v2-rotated",
        )
        org.refresh_from_db()
        assert org.psp_config["last_tested_at"] is None

    def test_base_url_trailing_slash_stripped(self):
        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp.internal/  ",
            integration_token="t",
        )
        org.refresh_from_db()
        # Whitespace trimmed AND trailing slash removed so the client
        # can concatenate ``base + /api/...`` without double slashes.
        assert org.psp_config["base_url"] == "https://psp.internal"


class TestMutualExclusionWithMrpeasy:
    def test_enabling_psp_clears_live_mrpeasy(self):
        """When both an active MRPEasy config and a PSP-enable
        happen on the same org, the MRPEasy side clears. The two
        integrations share consumer paths — both live at once
        would produce ambiguous 'which source wins' behaviour."""

        org = OrganizationFactory()
        mrpeasy_module.set_mrpeasy_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            api_key="key",
            api_secret="secret",
        )
        assert mrpeasy_module.is_mrpeasy_live(org)

        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="psp-token",
        )
        org.refresh_from_db()
        assert is_psp_live(org)
        assert not mrpeasy_module.is_mrpeasy_live(org)

    def test_enabling_mrpeasy_clears_live_psp(self):
        """Symmetric guard — MRPEasy-enable clears PSP."""

        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="psp-token",
        )
        assert is_psp_live(org)

        mrpeasy_module.set_mrpeasy_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            api_key="key",
            api_secret="secret",
        )
        org.refresh_from_db()
        assert mrpeasy_module.is_mrpeasy_live(org)
        assert not is_psp_live(org)

    def test_disabled_psp_save_does_not_clear_mrpeasy(self):
        """Saving PSP config with ``enabled=False`` (e.g. draft
        setup that hasn't gone live yet) must NOT clear an existing
        MRPEasy config. The clear only triggers when the operator
        actually flips PSP on."""

        org = OrganizationFactory()
        mrpeasy_module.set_mrpeasy_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            api_key="key",
            api_secret="secret",
        )
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=False,
            base_url="https://psp-draft",
            integration_token="draft-token",
        )
        org.refresh_from_db()
        assert mrpeasy_module.is_mrpeasy_live(org)


class TestClearPspConfig:
    def test_wipes_the_field(self):
        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="t",
        )
        clear_psp_config(organization=org, actor=org.created_by)
        org.refresh_from_db()
        assert org.psp_config == {}


class TestSerializeForApi:
    def test_never_returns_plaintext_token(self):
        org = OrganizationFactory()
        org.psp_config = {
            "enabled": True,
            "base_url": "https://psp",
            "integration_token_ciphertext": "ciphertext-abc",
        }
        payload = serialize_psp_config_for_api(org)
        assert payload == {
            "enabled": True,
            "base_url": "https://psp",
            "has_token": True,
            "last_tested_at": None,
        }
        assert "integration_token" not in payload
        assert "integration_token_ciphertext" not in payload


class TestGetPspConfig:
    def test_round_trips_plaintext_token(self):
        org = OrganizationFactory()
        set_psp_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            base_url="https://psp",
            integration_token="the-secret",
        )
        org.refresh_from_db()
        config = get_psp_config(organization=org)
        assert isinstance(config, PspConfig)
        assert config.enabled is True
        assert config.base_url == "https://psp"
        assert config.integration_token == "the-secret"
        assert config.is_complete is True


class TestPspItemProjection:
    def test_maps_populated_row(self):
        item = _project_item(
            {
                "uuid": "abc-123",
                "name": "Vitamin C",
                "description": "Ascorbic acid",
                "item_type": "raw_material",
                "external_sku": "VIT-C",
                "barcode": "5000000000000",
                "is_active": True,
                "use_as": "active",
                "product_family": {
                    "uuid": "pf-1",
                    "name": "Vitamins",
                },
                "selling_price": "5.2500",
                "currency_code": "GBP",
            }
        )
        assert isinstance(item, PspItem)
        assert item.uuid == "abc-123"
        assert item.selling_price == Decimal("5.2500")
        assert item.currency_code == "GBP"
        assert item.use_as == "active"
        assert item.product_family_uuid == "pf-1"

    def test_missing_fields_degrade_safely(self):
        item = _project_item({"uuid": "x", "name": "Bare"})
        assert item.description == ""
        assert item.selling_price is None
        assert item.use_as is None
        assert item.product_family_uuid is None
        assert item.currency_code is None
        assert item.is_active is True  # default

    def test_unparseable_price_becomes_null(self):
        item = _project_item(
            {"uuid": "x", "name": "Bare", "selling_price": "N/A"}
        )
        assert item.selling_price is None


class TestClientFactoryGuard:
    def test_incomplete_config_refuses_client(self):
        cfg = PspConfig(enabled=False, base_url="", integration_token="")
        with pytest.raises(PspInvalidConfig):
            psp.PspClient(cfg)


class TestSilentDegradation:
    def test_list_returns_empty_when_not_live(self, monkeypatch):
        """A picker call on an org with no PSP config must return
        [] rather than raising — the FE renders 'no matches'
        identically to a real empty result."""

        org = OrganizationFactory()
        assert psp.list_psp_items(organization=org) == []

    def test_get_item_returns_none_when_not_live(self):
        org = OrganizationFactory()
        assert psp.get_psp_item(organization=org, uuid="x") is None
