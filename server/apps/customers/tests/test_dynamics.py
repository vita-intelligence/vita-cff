"""Tests for the Microsoft Dynamics integration.

Covers the slice we can exercise without touching a real tenant:
the encryption helper, the service-layer config CRUD, the mock
client's behaviour, and the idempotent import flow. The real HTTP
client (``HttpDataverseClient``) is exercised end-to-end at runtime
when an admin clicks "Test Connection" from the Settings page —
unit-testing the network code without a sandbox would either
require a deep stdlib monkeypatch (brittle) or an actual outbound
call (forbidden), so we lean on the mock client for everything
that flows through the service layer.
"""

from __future__ import annotations

import pytest

from apps.customers.dynamics import (
    DataverseInvalidConfig,
    DynamicsConfig,
    DynamicsContact,
    HttpDataverseClient,
    MockDataverseClient,
    get_client,
)
from apps.customers.models import Customer
from apps.customers.services import (
    DynamicsNotConfigured,
    clear_dynamics_config,
    get_dynamics_config,
    import_customer_from_dynamics,
    search_dynamics_contacts,
    serialize_dynamics_config_for_api,
    set_dynamics_config,
    # Aliased to avoid pytest's auto-discovery treating the service
    # function as a top-level test case (its ``test_`` prefix is the
    # action verb, not a test marker).
    test_dynamics_connection as run_dynamics_connection_test,
)
from apps.organizations.encryption import (
    DecryptionFailed,
    decrypt_secret,
    encrypt_secret,
)
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Encryption helper
# ---------------------------------------------------------------------------


class TestEncryptSecret:
    def test_round_trips(self) -> None:
        plaintext = "super-secret-client-secret-value"
        ciphertext = encrypt_secret(plaintext)
        assert ciphertext != plaintext
        assert decrypt_secret(ciphertext) == plaintext

    def test_empty_passthrough(self) -> None:
        # Empty input → empty output on both sides. Lets callers
        # treat "no secret stored" as falsy without special casing.
        assert encrypt_secret("") == ""
        assert decrypt_secret("") == ""

    def test_invalid_ciphertext_raises_decryption_failed(self) -> None:
        with pytest.raises(DecryptionFailed):
            decrypt_secret("this-is-not-a-fernet-token")


# ---------------------------------------------------------------------------
# Config CRUD
# ---------------------------------------------------------------------------


class TestDynamicsConfigCrud:
    def _seed(self, org) -> dict:
        return set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            dataverse_url="https://contoso.crm.dynamics.com",
            tenant_id="t-1",
            client_id="c-1",
            client_secret="initial-secret",
        )

    def test_set_persists_encrypted_secret(self) -> None:
        org = OrganizationFactory()
        payload = self._seed(org)
        org.refresh_from_db()

        # API surface NEVER returns the plaintext secret.
        assert "client_secret" not in payload
        assert payload["has_secret"] is True

        # Stored shape carries the encrypted ciphertext.
        stored = org.dynamics_config["client_secret_ciphertext"]
        assert stored
        assert stored != "initial-secret"
        assert decrypt_secret(stored) == "initial-secret"

    def test_get_config_returns_plaintext_in_memory(self) -> None:
        org = OrganizationFactory()
        self._seed(org)
        org.refresh_from_db()
        config = get_dynamics_config(organization=org)
        assert isinstance(config, DynamicsConfig)
        assert config.client_secret == "initial-secret"
        assert config.is_complete

    def test_update_without_secret_preserves_previous(self) -> None:
        org = OrganizationFactory()
        self._seed(org)
        # Edit only the dataverse URL — no new secret in the payload.
        set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            dataverse_url="https://different.crm.dynamics.com",
            tenant_id="t-1",
            client_id="c-1",
            client_secret=None,
        )
        org.refresh_from_db()
        config = get_dynamics_config(organization=org)
        assert config.dataverse_url == "https://different.crm.dynamics.com"
        # Secret was preserved from the prior set.
        assert config.client_secret == "initial-secret"

    def test_clear_wipes_config(self) -> None:
        org = OrganizationFactory()
        self._seed(org)
        payload = clear_dynamics_config(
            organization=org, actor=org.created_by
        )
        assert payload["enabled"] is False
        assert payload["has_secret"] is False
        org.refresh_from_db()
        assert org.dynamics_config == {}

    def test_clear_does_not_delete_imported_customers(self) -> None:
        org = OrganizationFactory()
        self._seed(org)
        contact = DynamicsContact(
            dynamics_id="11111111-1111-1111-1111-111111111111",
            name="James Brown",
            company="ACME",
            email="j@acme.example",
            phone="+44 20 0000 0000",
            address="London",
        )
        import_customer_from_dynamics(
            organization=org, actor=org.created_by, contact=contact
        )
        clear_dynamics_config(organization=org, actor=org.created_by)
        # The imported customer survives — historical proposals
        # referencing it keep working.
        assert Customer.objects.filter(
            organization=org, dynamics_id=contact.dynamics_id
        ).exists()

    def test_serialize_does_not_leak_ciphertext(self) -> None:
        org = OrganizationFactory()
        self._seed(org)
        org.refresh_from_db()
        wire = serialize_dynamics_config_for_api(org)
        assert "client_secret" not in wire
        assert "client_secret_ciphertext" not in wire
        assert wire["has_secret"] is True


# ---------------------------------------------------------------------------
# Mock client + factory
# ---------------------------------------------------------------------------


class TestMockDataverseClient:
    def test_search_substring_matches_name(self) -> None:
        client = MockDataverseClient()
        results = client.search_contacts("brown")
        assert any(c.name == "James Brown" for c in results)

    def test_search_substring_matches_company(self) -> None:
        client = MockDataverseClient()
        results = client.search_contacts("nutrivate")
        assert any(c.company == "Nutrivate GmbH" for c in results)

    def test_empty_query_returns_all(self) -> None:
        client = MockDataverseClient()
        results = client.search_contacts("")
        assert len(results) >= 1

    def test_limit_is_respected(self) -> None:
        client = MockDataverseClient()
        results = client.search_contacts("", limit=2)
        assert len(results) == 2

    def test_test_connection_silent(self) -> None:
        client = MockDataverseClient()
        # Should not raise.
        client.test_connection()

    def test_factory_returns_mock_when_env_set(
        self, monkeypatch
    ) -> None:
        monkeypatch.setenv("DATAVERSE_MOCK", "true")
        config = DynamicsConfig(
            enabled=True,
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="s",
        )
        client = get_client(config)
        assert isinstance(client, MockDataverseClient)

    def test_factory_returns_http_when_env_off(
        self, monkeypatch
    ) -> None:
        monkeypatch.delenv("DATAVERSE_MOCK", raising=False)
        config = DynamicsConfig(
            enabled=True,
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="s",
        )
        client = get_client(config)
        assert isinstance(client, HttpDataverseClient)

    def test_http_client_rejects_incomplete_config(
        self, monkeypatch
    ) -> None:
        monkeypatch.delenv("DATAVERSE_MOCK", raising=False)
        config = DynamicsConfig(
            enabled=False,  # disabled = incomplete
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="s",
        )
        with pytest.raises(DataverseInvalidConfig):
            HttpDataverseClient(config)


# ---------------------------------------------------------------------------
# Service: test_dynamics_connection
# ---------------------------------------------------------------------------


class TestTestConnection:
    def test_succeeds_with_mock_when_configured(
        self, monkeypatch
    ) -> None:
        monkeypatch.setenv("DATAVERSE_MOCK", "true")
        org = OrganizationFactory()
        set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="s",
        )
        run_dynamics_connection_test(
            organization=org, actor=org.created_by
        )
        # last_tested_at populated as a side-effect — the settings
        # UI uses it to render "Tested 2 minutes ago".
        org.refresh_from_db()
        assert org.dynamics_config["last_tested_at"]

    def test_raises_when_not_configured(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(DynamicsNotConfigured):
            run_dynamics_connection_test(
                organization=org, actor=org.created_by
            )

    def test_raises_when_secret_missing(self, monkeypatch) -> None:
        monkeypatch.setenv("DATAVERSE_MOCK", "true")
        org = OrganizationFactory()
        # Save without a secret — config is incomplete.
        set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="",
        )
        with pytest.raises(DynamicsNotConfigured):
            run_dynamics_connection_test(
                organization=org, actor=org.created_by
            )


# ---------------------------------------------------------------------------
# Service: search_dynamics_contacts
# ---------------------------------------------------------------------------


class TestSearchDynamicsContacts:
    def test_returns_mock_matches(self, monkeypatch) -> None:
        monkeypatch.setenv("DATAVERSE_MOCK", "true")
        org = OrganizationFactory()
        set_dynamics_config(
            organization=org,
            actor=org.created_by,
            enabled=True,
            dataverse_url="https://x.crm.dynamics.com",
            tenant_id="t",
            client_id="c",
            client_secret="s",
        )
        results = search_dynamics_contacts(
            organization=org, query="brown"
        )
        assert all(isinstance(r, DynamicsContact) for r in results)
        assert any(r.name == "James Brown" for r in results)

    def test_raises_when_not_configured(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(DynamicsNotConfigured):
            search_dynamics_contacts(organization=org, query="x")


# ---------------------------------------------------------------------------
# Service: import_customer_from_dynamics (idempotent)
# ---------------------------------------------------------------------------


class TestImportCustomerFromDynamics:
    def _contact(self) -> DynamicsContact:
        return DynamicsContact(
            dynamics_id="11111111-1111-1111-1111-111111111111",
            name="James Brown",
            company="ACME",
            email="j@acme.example",
            phone="+44 20 0000 0000",
            address="221B Baker St, London",
        )

    def test_first_import_creates_local_customer(self) -> None:
        org = OrganizationFactory()
        customer = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact(),
        )
        assert customer.organization_id == org.id
        assert str(customer.dynamics_id) == self._contact().dynamics_id
        assert customer.name == "James Brown"
        assert customer.company == "ACME"
        assert customer.dynamics_synced_at is not None

    def test_second_import_dedupes_to_same_row(self) -> None:
        org = OrganizationFactory()
        a = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact(),
        )
        b = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact(),
        )
        assert a.pk == b.pk
        assert Customer.objects.filter(
            organization=org,
            dynamics_id=self._contact().dynamics_id,
        ).count() == 1

    def test_reimport_refreshes_identity_fields(self) -> None:
        # New rule: ``name`` / ``company`` always refresh (identity
        # — Dataverse owns this); ``email`` refreshes only when no
        # activated portal account exists; ``phone`` / addresses
        # only fill when locally blank (manual fixes are protected).
        org = OrganizationFactory()
        first = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact(),
        )
        # Local user edits notes — must NOT be overwritten on
        # the next sync.
        first.notes = "Prefers email"
        first.save(update_fields=["notes"])

        renamed = DynamicsContact(
            dynamics_id=self._contact().dynamics_id,
            name="James Brown II",
            company="ACME Wellness",
            email="james.brown@acme.example",
            phone="+44 20 1111 1111",
            address="221B Baker St, London, UK",
        )
        second = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=renamed,
        )
        second.refresh_from_db()
        assert second.name == "James Brown II"
        assert second.company == "ACME Wellness"
        # Email refreshed because no portal account is bound to
        # this customer in this test.
        assert second.email == "james.brown@acme.example"
        # Phone + address were ALREADY populated by the first
        # import — the new fill-empty rule means the second import
        # leaves them alone. Locally-curated values stay sacred.
        assert second.phone == self._contact().phone
        assert second.invoice_address == self._contact().address
        # Notes survived — locally-edited fields are protected.
        assert second.notes == "Prefers email"

    def test_reimport_preserves_portal_locked_email(self) -> None:
        # New rule: when a ``ClientAccount`` is activated against
        # this Customer, Dataverse can't overwrite ``email``. The
        # portal login owns that field once a customer has set a
        # password.
        from apps.client_portal.models import ClientAccount
        from django.utils import timezone

        org = OrganizationFactory()
        first = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact(),
        )
        ClientAccount.objects.create(
            email="j@acme.example",
            customer=first,
            activated_at=timezone.now(),
        )

        renamed = DynamicsContact(
            dynamics_id=self._contact().dynamics_id,
            name="James Brown II",
            company="ACME Wellness",
            email="james.brown@acme.example",
            phone="+44 20 1111 1111",
            address="221B Baker St, London, UK",
        )
        second = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=renamed,
        )
        second.refresh_from_db()
        # Identity fields still refresh.
        assert second.name == "James Brown II"
        assert second.company == "ACME Wellness"
        # Email locked — the portal login is the canonical address.
        assert second.email == "j@acme.example"

    def test_dynamics_fills_blank_soft_fields(self) -> None:
        # If a local row was created manually with phone/address
        # blank, a subsequent Dynamics import does FILL those blanks
        # — the rule is "patch empties, never overwrite".
        from apps.accounts.tests.factories import UserFactory

        org = OrganizationFactory()
        actor = UserFactory()
        Customer.objects.create(
            organization=org,
            name="James Brown",
            company="ACME",
            email="j@acme.example",
            phone="",
            invoice_address="",
            delivery_address="",
            dynamics_id=None,
            created_by=actor,
            updated_by=actor,
        )

        customer = import_customer_from_dynamics(
            organization=org,
            actor=actor,
            contact=self._contact(),
        )

        customer.refresh_from_db()
        # Adopt path attached the dynamics_id to the existing row,
        # and the soft fields filled because they were blank.
        assert str(customer.dynamics_id) == self._contact().dynamics_id
        assert customer.phone == self._contact().phone
        assert customer.invoice_address == self._contact().address

    def test_adopt_existing_local_row_by_email(self) -> None:
        # Common real-world case: staff created the customer
        # manually before integration was wired up. Later Dynamics
        # imports the same person. The audit's adopt path attaches
        # the dynamics_id to the existing row instead of creating a
        # second one.
        from apps.accounts.tests.factories import UserFactory

        org = OrganizationFactory()
        actor = UserFactory()
        manual = Customer.objects.create(
            organization=org,
            name="James Brown",
            company="ACME",
            email="j@acme.example",
            dynamics_id=None,
            created_by=actor,
            updated_by=actor,
        )

        adopted = import_customer_from_dynamics(
            organization=org,
            actor=actor,
            contact=self._contact(),
        )

        # Same row, now linked to Dataverse.
        assert adopted.pk == manual.pk
        assert str(adopted.dynamics_id) == self._contact().dynamics_id
        # Single row in the org for this email — no duplicate.
        assert Customer.objects.filter(
            organization=org, email__iexact="j@acme.example",
        ).count() == 1

    def test_other_org_does_not_collide(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        import_customer_from_dynamics(
            organization=org_a,
            actor=org_a.created_by,
            contact=self._contact(),
        )
        # Same Dynamics id can exist in a different org because
        # each org connects to its own Dynamics tenant — the
        # unique constraint scopes per-org.
        import_customer_from_dynamics(
            organization=org_b,
            actor=org_b.created_by,
            contact=self._contact(),
        )
        assert Customer.objects.filter(
            dynamics_id=self._contact().dynamics_id
        ).count() == 2


# ---------------------------------------------------------------------------
# Service: account-first resolution + swap_primary_contact
# ---------------------------------------------------------------------------


class TestAccountAnchoredImport:
    """Picking the same Dataverse account from two different angles
    (the account row directly, or a contact under that account)
    must resolve to the same local Customer — never two rows.
    """

    ACCOUNT_GUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    CONTACT_GUID_A = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    CONTACT_GUID_B = "cccccccc-cccc-cccc-cccc-cccccccccccc"

    def _contact_a(self) -> DynamicsContact:
        return DynamicsContact(
            dynamics_id=self.CONTACT_GUID_A,
            name="Linda Brown",
            company="ACME",
            email="linda@acme.example",
            phone="+44 0",
            address="HQ",
            account_id=self.ACCOUNT_GUID,
            contact_id=self.CONTACT_GUID_A,
        )

    def _contact_b(self) -> DynamicsContact:
        return DynamicsContact(
            dynamics_id=self.CONTACT_GUID_B,
            name="Steve Smith",
            company="ACME",
            email="steve@acme.example",
            phone="+44 1",
            address="HQ",
            account_id=self.ACCOUNT_GUID,
            contact_id=self.CONTACT_GUID_B,
        )

    def test_first_import_creates_account_anchored_row(self) -> None:
        org = OrganizationFactory()
        customer = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )
        assert (
            str(customer.dynamics_account_id) == self.ACCOUNT_GUID
        )
        assert (
            str(customer.dynamics_contact_id) == self.CONTACT_GUID_A
        )
        # ``dynamics_id`` left NULL — new rows under the
        # account/contact split don't write the legacy column.
        assert customer.dynamics_id is None

    def test_picking_account_then_contact_dedupes_to_same_row(
        self,
    ) -> None:
        # Account row imports first (operator picked "ACME"). Then
        # the same operator picks a contact under that account
        # ("Linda"). Both must resolve to the same Customer row.
        from apps.customers.dynamics import DynamicsContact

        org = OrganizationFactory()
        account_pick = DynamicsContact(
            dynamics_id=self.ACCOUNT_GUID,
            name="",
            company="ACME",
            email="info@acme.example",
            phone="+44 100",
            address="HQ",
            account_id=self.ACCOUNT_GUID,
            contact_id=None,
        )
        first = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=account_pick,
        )
        # Account row sets account_id, leaves contact_id NULL —
        # the picker hasn't selected a person yet.
        assert first.dynamics_contact_id is None

        # Now pick Linda. Same account → same Customer row.
        second = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )
        assert second.pk == first.pk
        # Contact ID now landed on the row.
        second.refresh_from_db()
        assert (
            str(second.dynamics_contact_id) == self.CONTACT_GUID_A
        )

    def test_different_contact_same_account_refuses(
        self,
    ) -> None:
        from apps.customers.services import AccountAlreadyLinked

        org = OrganizationFactory()
        first = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )

        # Operator picks Steve (different contact, same account).
        # The resolver refuses — the right action is swap, not a
        # silent overwrite of Linda's snapshot.
        with pytest.raises(AccountAlreadyLinked) as excinfo:
            import_customer_from_dynamics(
                organization=org,
                actor=org.created_by,
                contact=self._contact_b(),
            )
        assert excinfo.value.existing_customer_id == first.id
        # Display info for the modal — current primary's name +
        # email so the FE can render "swap from Linda Brown
        # (linda@acme.example) to Steve Smith?"
        assert "Linda" in excinfo.value.current_contact_name

    def test_swap_primary_contact_repoints_row(self) -> None:
        from apps.customers.services import swap_primary_contact

        org = OrganizationFactory()
        customer = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )

        updated = swap_primary_contact(
            customer=customer,
            actor=org.created_by,
            contact=self._contact_b(),
        )
        updated.refresh_from_db()
        # Account stayed put; contact pointer + snapshot moved.
        assert (
            str(updated.dynamics_account_id) == self.ACCOUNT_GUID
        )
        assert (
            str(updated.dynamics_contact_id) == self.CONTACT_GUID_B
        )
        assert updated.name == "Steve Smith"
        assert updated.email == "steve@acme.example"

    def test_swap_to_different_account_refused(self) -> None:
        from apps.customers.services import (
            PrimaryContactAccountMismatch,
            swap_primary_contact,
        )

        org = OrganizationFactory()
        customer = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )

        # Try to swap to a contact under a different account —
        # service must refuse to keep the account anchor stable.
        wrong_account = DynamicsContact(
            dynamics_id="dddddddd-dddd-dddd-dddd-dddddddddddd",
            name="Wrong",
            company="Other Co",
            email="wrong@other.example",
            phone="",
            address="",
            account_id="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            contact_id="dddddddd-dddd-dddd-dddd-dddddddddddd",
        )
        with pytest.raises(PrimaryContactAccountMismatch):
            swap_primary_contact(
                customer=customer,
                actor=org.created_by,
                contact=wrong_account,
            )

    def test_swap_respects_portal_locked_email(self) -> None:
        # When the Customer has an activated portal account, the
        # email stays put even on a swap — same rule as the
        # canonical Dynamics refresh.
        from apps.client_portal.models import ClientAccount
        from apps.customers.services import swap_primary_contact
        from django.utils import timezone

        org = OrganizationFactory()
        customer = import_customer_from_dynamics(
            organization=org,
            actor=org.created_by,
            contact=self._contact_a(),
        )
        ClientAccount.objects.create(
            email=customer.email,
            customer=customer,
            activated_at=timezone.now(),
        )

        swap_primary_contact(
            customer=customer,
            actor=org.created_by,
            contact=self._contact_b(),
        )
        customer.refresh_from_db()
        # Name swapped, email locked.
        assert customer.name == "Steve Smith"
        assert customer.email == "linda@acme.example"
