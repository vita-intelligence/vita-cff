"""Tests for the per-org Wix CFF integration config layer.

Coverage:

* Round-trip ``set → get`` returns the plaintext API key.
* "Keep existing secret" sentinel: setting ``api_key=None`` (or
  empty) preserves the stored ciphertext.
* :func:`is_wix_cff_live` returns ``False`` when any required
  field is missing.
* The wire serializer never leaks the plaintext key; ``has_api_key``
  is the only flag the frontend gets.
* Rotating the API key clears ``last_tested_at`` (no stale
  "Connected" badge on a fresh secret).
"""

from __future__ import annotations

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.integration import (
    WixCFFNotConfigured,
    clear_wix_cff_config,
    get_wix_cff_config,
    is_wix_cff_live,
    serialize_wix_cff_config_for_api,
    set_wix_cff_config,
    stamp_last_tested,
)
from apps.organizations.tests.factories import OrganizationFactory


FORM_ID = "bec673ee-0020-4c34-a09a-8332356548af"
SITE_ID = "c0d9135f-baa5-4029-baec-42521e033385"


@pytest.mark.django_db
class TestSetAndGet:
    def test_round_trip_returns_plaintext_key(self):
        org = OrganizationFactory()
        actor = UserFactory()

        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="plaintext-secret-key",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        config = get_wix_cff_config(organization=org)
        assert config.api_key == "plaintext-secret-key"
        assert config.site_id == SITE_ID
        assert config.form_id == FORM_ID
        assert config.namespace == "wix.form_app.form"
        assert config.is_complete

    def test_keep_existing_secret_sentinel(self):
        org = OrganizationFactory()
        actor = UserFactory()

        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="original-key",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        # Save again with api_key=None — operator left the field blank.
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key=None,
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        config = get_wix_cff_config(organization=org)
        assert config.api_key == "original-key"

    def test_rotating_secret_clears_last_tested_at(self):
        org = OrganizationFactory()
        actor = UserFactory()

        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="first-key",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        stamp_last_tested(organization=org)
        org.refresh_from_db()
        assert org.wix_cff_config.get("last_tested_at") is not None

        # Rotate the secret.
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="rotated-key",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        assert org.wix_cff_config.get("last_tested_at") is None


@pytest.mark.django_db
class TestIsLive:
    def test_empty_config_is_not_live(self):
        org = OrganizationFactory()
        assert is_wix_cff_live(org) is False

    def test_disabled_is_not_live(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=False,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        assert is_wix_cff_live(org) is False

    def test_missing_form_id_is_not_live(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id="",
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        assert is_wix_cff_live(org) is False

    def test_complete_config_is_live(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        assert is_wix_cff_live(org) is True


@pytest.mark.django_db
class TestSerializer:
    def test_never_leaks_plaintext_key(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="super-secret",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        org.refresh_from_db()
        wire = serialize_wix_cff_config_for_api(org)

        assert "api_key" not in wire
        assert "api_key_ciphertext" not in wire
        assert wire["has_api_key"] is True
        assert wire["enabled"] is True
        assert wire["site_id"] == SITE_ID

    def test_empty_config_serializes_with_safe_defaults(self):
        org = OrganizationFactory()
        wire = serialize_wix_cff_config_for_api(org)

        assert wire == {
            "enabled": False,
            "has_api_key": False,
            "site_id": "",
            "form_id": "",
            "namespace": "wix.form_app.form",
            "last_tested_at": None,
        }


@pytest.mark.django_db
class TestClear:
    def test_clear_resets_to_empty_dict(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        clear_wix_cff_config(organization=org, actor=actor)
        org.refresh_from_db()

        assert org.wix_cff_config == {}
        assert is_wix_cff_live(org) is False

    def test_get_after_clear_raises_not_configured(self):
        org = OrganizationFactory()
        actor = UserFactory()
        set_wix_cff_config(
            organization=org,
            actor=actor,
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        clear_wix_cff_config(organization=org, actor=actor)
        org.refresh_from_db()
        with pytest.raises(WixCFFNotConfigured):
            get_wix_cff_config(organization=org)
