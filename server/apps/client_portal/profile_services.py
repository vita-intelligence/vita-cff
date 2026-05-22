"""Service layer for the customer-portal Settings page.

Three surfaces:

1. **Profile** — read + write the Customer fields the client is
   allowed to manage: contact name, company, phone, invoice +
   delivery address. The portal never touches Dynamics here; the
   edit overrides the local DB row and the next Dynamics sync may
   overwrite it (acknowledged trade-off, documented in the UI).
2. **Email change** — two-step verification flow. The customer
   types a new address, we mail a 6-digit code to that NEW
   address (proves they own it), the customer types the code,
   we flip both ``Customer.email`` (the on-file address) and
   ``ClientAccount.email`` (the login identity).
3. **Password change** — standard ``current + new`` form. The
   customer is already authenticated, so no second-channel
   verification is needed.

Every write path is wrapped in ``transaction.atomic`` so a
mid-mutation failure never leaves the DB in a partial state. The
email-change path additionally invalidates every prior in-flight
request for the account on each new submission, mirroring the
password-reset enumeration policy.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import validate_password
from django.db import transaction
from django.utils import timezone

from apps.client_portal.models import ClientAccount, EmailChangeRequest

logger = logging.getLogger(__name__)


# Email-change codes match the password-reset cadence (30 min).
EMAIL_CHANGE_TTL = timedelta(minutes=30)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ProfileError(Exception):
    code: str = "profile_error"


class EmailAlreadyInUse(ProfileError):
    code = "email_already_in_use"


class InvalidEmailChangeCode(ProfileError):
    code = "invalid_email_change_code"


class CurrentPasswordIncorrect(ProfileError):
    code = "current_password_incorrect"


# ---------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CustomerProfile:
    """Wire-shape projection of the editable Customer surface."""

    customer_id: str
    email: str
    name: str
    company: str
    phone: str
    invoice_address: str
    delivery_address: str


def get_customer_profile(*, account: ClientAccount) -> CustomerProfile:
    customer = account.customer
    return CustomerProfile(
        customer_id=str(customer.id),
        email=account.email,
        name=customer.name or "",
        company=customer.company or "",
        phone=customer.phone or "",
        invoice_address=customer.invoice_address or "",
        delivery_address=customer.delivery_address or "",
    )


# ---------------------------------------------------------------------------
# Profile write (non-email fields)
# ---------------------------------------------------------------------------


@transaction.atomic
def update_customer_profile(
    *,
    account: ClientAccount,
    name: str | None = None,
    company: str | None = None,
    phone: str | None = None,
    invoice_address: str | None = None,
    delivery_address: str | None = None,
) -> CustomerProfile:
    """Patch the Customer row with the supplied fields.

    ``None`` means "don't touch this field" — callers send only
    what changed. Empty strings are accepted (the customer cleared
    a field intentionally).

    Dynamics sync may overwrite these values on its next run. That
    is the documented trade-off for the MVP — the portal does not
    push edits upstream.
    """

    from apps.customers.models import Customer

    # Re-fetch under a row lock so two concurrent saves serialise.
    customer = Customer.objects.select_for_update().get(
        pk=account.customer_id,
    )

    if name is not None:
        customer.name = name.strip()
    if company is not None:
        customer.company = company.strip()
    if phone is not None:
        customer.phone = phone.strip()
    if invoice_address is not None:
        customer.invoice_address = invoice_address.strip()
    if delivery_address is not None:
        customer.delivery_address = delivery_address.strip()

    # ``updated_by`` is a PROTECT FK to the staff users table; the
    # portal client is not in that table, so we leave the column
    # alone (Django keeps the previous value). A future audit pass
    # can introduce a polymorphic ``updated_by`` if we want to
    # attribute portal-side edits.
    customer.save()
    account.refresh_from_db(fields=["email"])
    return get_customer_profile(account=account)


# ---------------------------------------------------------------------------
# Email change (request + confirm)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedEmailChange:
    """What ``request_email_change`` hands to the API layer."""

    request: EmailChangeRequest
    plaintext_code: str


def _hash_code(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


@transaction.atomic
def request_email_change(
    *,
    account: ClientAccount,
    new_email: str,
) -> IssuedEmailChange:
    """Issue a 6-digit code against ``new_email`` and persist it.

    Refuses if another ``ClientAccount`` (not the caller) already
    owns the address — keeps logins unique. If the caller's
    current email is being re-submitted, we still issue a code
    (it's harmless, lets the flow self-correct on typos).

    Every prior unused request for this account is invalidated so
    only the freshest code in the customer's inbox can be redeemed.
    """

    normalised = (new_email or "").strip().lower()
    if not normalised:
        raise ProfileError("New email is required.")

    if normalised != account.email:
        collision = (
            ClientAccount.objects
            .filter(email__iexact=normalised)
            .exclude(pk=account.pk)
            .exists()
        )
        if collision:
            raise EmailAlreadyInUse(
                "This email is already linked to another portal account."
            )

    now = timezone.now()
    EmailChangeRequest.objects.filter(
        account=account,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).update(invalidated_at=now)

    plaintext_code = f"{secrets.randbelow(1_000_000):06d}"
    row = EmailChangeRequest.objects.create(
        account=account,
        new_email=normalised,
        code_hash=_hash_code(plaintext_code),
        expires_at=now + EMAIL_CHANGE_TTL,
    )
    return IssuedEmailChange(request=row, plaintext_code=plaintext_code)


@transaction.atomic
def confirm_email_change(
    *,
    account: ClientAccount,
    code: str,
) -> ClientAccount:
    """Consume the latest in-flight request and flip both emails.

    Looks up the most recent consumable request for the account,
    constant-time-compares the supplied code against its hash, and
    on a match updates both ``ClientAccount.email`` (the login)
    and ``Customer.email`` (the on-file address) atomically.

    Raises :class:`InvalidEmailChangeCode` on a missing / expired
    / wrong code. The same error code covers all three cases so a
    timing attacker can't distinguish them.
    """

    import hmac

    cleaned_code = (code or "").strip()
    if not cleaned_code:
        raise InvalidEmailChangeCode("Verification code is required.")

    pending = (
        EmailChangeRequest.objects
        .select_for_update()
        .filter(account=account)
        .order_by("-created_at")
        .first()
    )
    if pending is None or not pending.is_consumable:
        raise InvalidEmailChangeCode("This code is no longer valid.")

    if not hmac.compare_digest(
        pending.code_hash, _hash_code(cleaned_code),
    ):
        raise InvalidEmailChangeCode("Verification code is incorrect.")

    # Double-check the address didn't get claimed between request
    # and confirm — rare but possible (two portal accounts on the
    # same email, the other one was activated after we issued).
    collision = (
        ClientAccount.objects
        .filter(email__iexact=pending.new_email)
        .exclude(pk=account.pk)
        .exists()
    )
    if collision:
        pending.invalidated_at = timezone.now()
        pending.save(update_fields=["invalidated_at"])
        raise EmailAlreadyInUse(
            "This email is now linked to another portal account."
        )

    account.email = pending.new_email
    account.save(update_fields=["email", "updated_at"])

    from apps.customers.models import (
        Customer,
        CustomerEmailAlias,
        CustomerEmailAliasSource,
    )

    customer = Customer.objects.select_for_update().get(pk=account.customer_id)
    # Archive the *previous* address into the alias table before
    # overwriting. The portal-side CFF query unions across the
    # canonical email + every alias, so a customer rotating their
    # login email never loses visibility of CFFs they submitted
    # under prior addresses. ``get_or_create`` keeps the writer
    # idempotent — if a customer flips back to an old address and
    # then changes again, we get one alias per past address rather
    # than one per flip.
    #
    # Skip when:
    #   * The new email IS the customer's current canonical email
    #     (no-op rotation, defensive).
    #   * The "old" address was empty — there's nothing to
    #     archive (a freshly-imported customer who set their email
    #     for the first time via the portal).
    prior_email = (customer.email or "").strip()
    new_email_normalised = (pending.new_email or "").strip()
    if prior_email and prior_email.lower() != new_email_normalised.lower():
        # ``get_or_create`` lookups can't use ``__iexact``, so we
        # split: look up case-insensitively first, only create when
        # nothing matches. The unique constraint on
        # ``(lower(email), customer)`` would catch any race anyway.
        prior_email_lower = prior_email.lower()
        existing_alias = (
            CustomerEmailAlias.objects
            .filter(customer=customer, email__iexact=prior_email_lower)
            .first()
        )
        if existing_alias is None:
            CustomerEmailAlias.objects.create(
                customer=customer,
                email=prior_email_lower,
                source=CustomerEmailAliasSource.PORTAL_EMAIL_CHANGE,
            )

    customer.email = pending.new_email
    customer.save(update_fields=["email", "updated_at"])

    # Invalidate any open staff-issued portal invites for this
    # customer. They were minted against the *previous* address
    # (their ``email_snapshot`` is frozen at create time) and would
    # let anyone holding the old code activate against the stale
    # email if a fresh invite were never issued. Mirrors the same
    # invalidation block the staff-side ``update_customer`` runs on
    # email change so both paths converge on one rule.
    from apps.client_portal.models import CustomerPortalInvite

    CustomerPortalInvite.objects.filter(
        customer=customer,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).update(invalidated_at=timezone.now())

    pending.used_at = timezone.now()
    pending.save(update_fields=["used_at"])
    return account


# ---------------------------------------------------------------------------
# Password change
# ---------------------------------------------------------------------------


@transaction.atomic
def change_password(
    *,
    account: ClientAccount,
    current_password: str,
    new_password: str,
) -> ClientAccount:
    """Replace the password on the account.

    Verifies the current password first so a stolen session cookie
    alone (without the password) can't quietly take over the
    account — the same pattern every consumer SaaS uses.
    """

    if not account.check_password(current_password or ""):
        raise CurrentPasswordIncorrect("Current password is incorrect.")

    # Django's standard validators (length, common-passwords list,
    # similarity to email).
    validate_password(new_password, user=account)

    account.password = make_password(new_password)
    account.save(update_fields=["password", "updated_at"])
    return account
