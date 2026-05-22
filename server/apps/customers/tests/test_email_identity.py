"""Forward-only customer-identity safeguards.

Covers the four rules introduced by the audit:

* ``create_customer`` refuses to add a new row at an email another
  row in the same org already uses.
* ``confirm_email_change`` archives the prior email into
  :class:`CustomerEmailAlias` and invalidates open
  :class:`CustomerPortalInvite` rows.
* ``list_customer_cffs`` unions across the canonical email + every
  alias, so a customer's historical CFFs surface after a portal
  email change.
* Dynamics adopt-by-email + portal-locked email (covered in
  :mod:`apps.customers.tests.test_dynamics`).
"""

from __future__ import annotations

import uuid

import pytest
from django.utils import timezone

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.models import CFFSubmission
from apps.cff_submissions.services import list_customer_cffs
from apps.client_portal.models import (
    ClientAccount,
    CustomerPortalInvite,
    EmailChangeRequest,
)
from apps.client_portal.profile_services import (
    confirm_email_change,
)
from apps.customers.models import (
    Customer,
    CustomerEmailAlias,
    CustomerEmailAliasSource,
)
from apps.customers.services import (
    CustomerEmailAlreadyExists,
    create_customer,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _make_customer(*, org, email: str, **extra) -> Customer:
    actor = extra.pop("actor", None) or UserFactory()
    return Customer.objects.create(
        organization=org,
        name=extra.pop("name", "Test Buyer"),
        company=extra.pop("company", "Test Co"),
        email=email,
        created_by=actor,
        updated_by=actor,
        **extra,
    )


class TestCreateCustomerDuplicateGuard:
    def test_refuses_new_row_at_existing_email(self) -> None:
        org = OrganizationFactory()
        actor = org.created_by
        first = _make_customer(
            org=org, email="alex@buyer.test", actor=actor,
        )

        with pytest.raises(CustomerEmailAlreadyExists) as excinfo:
            create_customer(
                organization=org,
                actor=actor,
                name="Different Person",
                company="Different Co",
                email="alex@buyer.test",
            )
        assert excinfo.value.existing_customer_id == first.id

    def test_case_insensitive(self) -> None:
        org = OrganizationFactory()
        actor = org.created_by
        _make_customer(org=org, email="alex@buyer.test", actor=actor)

        with pytest.raises(CustomerEmailAlreadyExists):
            create_customer(
                organization=org,
                actor=actor,
                name="Alt",
                company="Alt Co",
                email="ALEX@BUYER.TEST",
            )

    def test_blank_email_does_not_trigger_guard(self) -> None:
        # A blank email is the explicit "we don't know it yet"
        # signal — multiple blank-email customers can coexist
        # without tripping the dup guard.
        org = OrganizationFactory()
        actor = org.created_by
        a = create_customer(
            organization=org,
            actor=actor,
            name="Anon A",
            company="A Co",
            email="",
        )
        b = create_customer(
            organization=org,
            actor=actor,
            name="Anon B",
            company="B Co",
            email="",
        )
        assert a.pk != b.pk

    def test_other_org_not_blocked(self) -> None:
        # Scoping is per-org — a different tenant can have the same
        # email locally without triggering the guard.
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        _make_customer(
            org=org_a, email="alex@buyer.test",
            actor=org_a.created_by,
        )
        # Different org — no conflict.
        create_customer(
            organization=org_b,
            actor=org_b.created_by,
            name="Alex",
            company="A Co",
            email="alex@buyer.test",
        )


# ---------------------------------------------------------------------------
# Portal email change → alias + invite invalidation
# ---------------------------------------------------------------------------


def _ensure_account(*, customer: Customer) -> ClientAccount:
    """Get-or-create one activated portal account for this customer.

    Reused across cycles in the same test — the production rule is
    one account per customer, so the scaffolding never doubles up
    (which would trip the global ``ClientAccount.email`` unique
    constraint on the second call).
    """

    account = ClientAccount.objects.filter(customer=customer).first()
    if account is not None:
        return account
    account = ClientAccount.objects.create(
        email=customer.email,
        customer=customer,
        activated_at=timezone.now(),
    )
    account.set_password("V3ryStr0ngPass!xyz")
    account.save(update_fields=["password"])
    return account


def _seed_email_change_request(
    *, account: ClientAccount, new_email: str, plaintext_code: str,
) -> EmailChangeRequest:
    from apps.client_portal.profile_services import _hash_code

    return EmailChangeRequest.objects.create(
        account=account,
        new_email=new_email.lower(),
        code_hash=_hash_code(plaintext_code),
        expires_at=timezone.now() + timezone.timedelta(minutes=30),
    )


def _seed_portal_email_change(
    *, customer: Customer, new_email: str, plaintext_code: str,
):
    """Composite helper used by the simple tests below — combines
    ``_ensure_account`` + ``_seed_email_change_request`` so the
    test reads cleanly without leaking the test-setup mechanics."""

    account = _ensure_account(customer=customer)
    request = _seed_email_change_request(
        account=account,
        new_email=new_email,
        plaintext_code=plaintext_code,
    )
    return account, request


class TestConfirmEmailChangeAliases:
    def test_alias_row_written_for_prior_address(self) -> None:
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, email="old@buyer.test",
            actor=org.created_by,
        )
        account, _ = _seed_portal_email_change(
            customer=customer,
            new_email="new@buyer.test",
            plaintext_code="123456",
        )

        confirm_email_change(account=account, code="123456")

        customer.refresh_from_db()
        assert customer.email == "new@buyer.test"
        alias = CustomerEmailAlias.objects.get(customer=customer)
        assert alias.email == "old@buyer.test"
        assert alias.source == (
            CustomerEmailAliasSource.PORTAL_EMAIL_CHANGE
        )

    def test_open_invites_invalidated_on_change(self) -> None:
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, email="old@buyer.test",
            actor=org.created_by,
        )
        # Issue an open invite, then change email — invite must
        # auto-expire so the stale code can't activate against the
        # new address.
        invite = CustomerPortalInvite.objects.create(
            customer=customer,
            code_hash="x" * 64,
            email_snapshot="old@buyer.test",
            created_by=org.created_by,
            expires_at=timezone.now() + timezone.timedelta(days=7),
        )
        account, _ = _seed_portal_email_change(
            customer=customer,
            new_email="new@buyer.test",
            plaintext_code="123456",
        )

        confirm_email_change(account=account, code="123456")

        invite.refresh_from_db()
        assert invite.invalidated_at is not None

    def test_alias_row_is_idempotent_across_cycles(self) -> None:
        # Customer rotates old@ → new@ → back to old@. We re-use the
        # same ``ClientAccount`` because production has one per
        # customer; the global unique on ``ClientAccount.email``
        # would refuse a second row anyway.
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, email="old@buyer.test",
            actor=org.created_by,
        )
        account = _ensure_account(customer=customer)

        # Cycle 1: old → new
        _seed_email_change_request(
            account=account,
            new_email="new@buyer.test",
            plaintext_code="111111",
        )
        confirm_email_change(account=account, code="111111")

        # Cycle 2: new → back to old
        account.refresh_from_db()
        _seed_email_change_request(
            account=account,
            new_email="old@buyer.test",
            plaintext_code="222222",
        )
        confirm_email_change(account=account, code="222222")

        # Two cycles, two aliases (old@ and new@ each got archived
        # once when they were the *prior* address). Idempotency
        # here means there's no THIRD row when the customer flips
        # back — only one alias per distinct prior address.
        aliases = sorted(
            CustomerEmailAlias.objects
            .filter(customer=customer)
            .values_list("email", flat=True)
        )
        assert aliases == ["new@buyer.test", "old@buyer.test"]


# ---------------------------------------------------------------------------
# CFF visibility via alias union
# ---------------------------------------------------------------------------


class TestCFFAliasUnion:
    def test_cffs_under_prior_email_visible_after_alias(self) -> None:
        # Customer submitted a CFF under their old email, then
        # changed via portal. The CFF query must surface that
        # historical CFF in the new portal session.
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, email="old@buyer.test",
            actor=org.created_by,
        )
        # CFF submitted long ago under the prior address.
        cff = CFFSubmission.objects.create(
            organization=org,
            wix_submission_id=str(uuid.uuid4()),
            submitter_email="old@buyer.test",
            wix_form_id=str(uuid.uuid4()),
            wix_created_date=timezone.now(),
            wix_updated_date=timezone.now(),
            raw_payload={},
        )
        # Customer changes email.
        account, _ = _seed_portal_email_change(
            customer=customer,
            new_email="new@buyer.test",
            plaintext_code="123456",
        )
        confirm_email_change(account=account, code="123456")
        account.refresh_from_db()

        # New session, canonical email is now "new@…", but the
        # alias union should surface the historical CFF.
        visible = list(list_customer_cffs(client_account=account))
        assert cff in visible

    def test_canonical_match_still_works_without_aliases(
        self,
    ) -> None:
        # A customer who hasn't changed their email shouldn't
        # regress: the existing email-match leg must keep working
        # against ``Customer.email`` alone.
        org = OrganizationFactory()
        customer = _make_customer(
            org=org, email="stable@buyer.test",
            actor=org.created_by,
        )
        account = ClientAccount.objects.create(
            email="stable@buyer.test",
            customer=customer,
            activated_at=timezone.now(),
        )
        cff = CFFSubmission.objects.create(
            organization=org,
            wix_submission_id=str(uuid.uuid4()),
            submitter_email="stable@buyer.test",
            wix_form_id=str(uuid.uuid4()),
            wix_created_date=timezone.now(),
            wix_updated_date=timezone.now(),
            raw_payload={},
        )

        visible = list(list_customer_cffs(client_account=account))
        assert cff in visible
