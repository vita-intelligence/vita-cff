"""Service layer for the client portal.

Three responsibilities:

1. **Activation** — turn a kiosk-email click into an authenticated
   :class:`ClientAccount`. The proposal's ``public_token`` is the
   one-shot credential; we resolve token → proposal → customer →
   email and create / activate the account against that exact
   email. Clients never supply the email themselves.
2. **Login / logout** — email + password against the activated
   account. Issues a JWT pair, returned by the API layer in
   httpOnly portal cookies.
3. **Password reset** — request + confirm flow that mirrors the
   staff side (:mod:`apps.accounts.services`) field-for-field so a
   future shared abstraction can fold the two together without
   semantic drift. Enumeration-safe: callers can't tell unknown
   emails apart from known ones based on response shape.

Everything that mutates is wrapped in ``transaction.atomic`` so a
half-applied state never persists.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from typing import Any

from django.contrib.auth.hashers import make_password
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from apps.client_portal.models import (
    PORTAL_PASSWORD_RESET_TOKEN_TTL,
    ClientAccount,
    ClientPasswordResetToken,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ActivationError(Exception):
    """Base class for any activation-time failure surface."""

    code: str = "activation_failed"


class InvalidActivationToken(ActivationError):
    """The token didn't resolve to any proposal."""

    code = "invalid_activation_token"


class CustomerEmailMissing(ActivationError):
    """The proposal's customer has no email on file, so we have
    nothing to bind a portal account to. Staff has to add an email
    on the customer record before the kiosk email can be resent."""

    code = "customer_email_missing"


class AccountAlreadyActivated(ActivationError):
    """The account exists and already has a usable password. The
    client should log in normally instead of re-activating."""

    code = "account_already_activated"


class InvalidCredentials(Exception):
    code = "invalid_credentials"


# ---------------------------------------------------------------------------
# Activation
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ActivationResult:
    """Wire-shape-friendly summary of a successful activation."""

    account: ClientAccount
    customer_id: str
    customer_company: str
    proposal_id: str


def _resolve_proposal_by_token(token: uuid.UUID):
    """Look up the proposal that owns this kiosk token.

    Imported lazily to avoid a top-level import loop with
    ``apps.proposals.models``.
    """

    from apps.proposals.models import Proposal

    return (
        Proposal.objects
        .select_related("customer")
        .filter(public_token=token)
        .first()
    )


def _resolve_kiosk_email(proposal) -> str:
    """Decide which email a ``public_token`` should activate against.

    The compose modal that sends the kiosk email lets staff type any
    recipient — not necessarily ``Customer.email``. We snapshot the
    used address on ``Proposal.kiosk_recipient_email`` at send time
    so the portal activates the EXACT inbox the kiosk email reached.
    Falls back to ``Customer.email`` when no send has happened yet
    (e.g. an operator clicks Test Activate in dev before any real
    send) so the helper never returns empty for a proposal that
    has at least one valid email on either side.
    """

    sent_to = (getattr(proposal, "kiosk_recipient_email", "") or "").strip().lower()
    if sent_to:
        return sent_to
    customer = proposal.customer
    if customer is None:
        return ""
    return (customer.email or "").strip().lower()


@transaction.atomic
def activate_via_token(
    *,
    token: uuid.UUID,
    password: str,
) -> ActivationResult:
    """Activate the portal account for the customer this token
    points at, setting their password to ``password``.

    Raises:
        InvalidActivationToken — token isn't on any proposal.
        CustomerEmailMissing — customer has no email; can't bind an
            account.
        AccountAlreadyActivated — an account for this email already
            has a usable password. The client must use the login
            page (or password-reset) from here on.

    Note that we never disclose the customer email back to the
    caller during activation — the API layer accepts the password
    and stamps the cookies, but the page renders only what's safe
    to surface ("Welcome, <Customer company>"). The actual email
    address never round-trips through the activation form.
    """

    proposal = _resolve_proposal_by_token(token)
    if proposal is None:
        raise InvalidActivationToken(
            "No proposal matches this activation link."
        )

    customer = proposal.customer
    if customer is None:
        # ``Proposal.customer`` is nullable on the schema — a draft
        # without a CRM record can exist. The kiosk email flow only
        # runs against proposals with a customer attached, but we
        # guard defensively here so a stray activation link on an
        # unbound proposal returns a meaningful error instead of a
        # 500.
        raise CustomerEmailMissing(
            "This proposal has no customer attached; ask the team to "
            "link a customer record before resending the kiosk link.",
        )
    email = _resolve_kiosk_email(proposal)
    if not email:
        raise CustomerEmailMissing(
            "The customer attached to this proposal has no email on file; "
            "ask the team to add one before resending the kiosk link.",
        )

    account = ClientAccount.objects.filter(email__iexact=email).first()

    if account is not None and account.has_usable_password():
        # Already activated. The portal login page is the right
        # next step; the activation page will redirect on this.
        raise AccountAlreadyActivated(
            "This email already has a portal account. Sign in instead.",
        )

    # Validate first, before we mutate anything — Django's validator
    # raises ``ValidationError`` which the API layer surfaces as 400.
    if account is None:
        # Build an unsaved account so ``validate_password`` can run
        # its user-context similarity checks against the email.
        scratch = ClientAccount(email=email, customer=customer)
        validate_password(password, user=scratch)
        account = ClientAccount.objects.create_account(
            email=email,
            customer=customer,
            password=password,
        )
    else:
        validate_password(password, user=account)
        account.password = make_password(password)
        account.is_active = True

    account.activated_at = timezone.now()
    account.customer = customer  # ensure stays current even if reused
    account.save(
        update_fields=["password", "is_active", "activated_at", "customer", "updated_at"],
    )

    return ActivationResult(
        account=account,
        customer_id=str(customer.id),
        customer_company=customer.company or customer.name or "",
        proposal_id=str(proposal.id),
    )


def preview_activation(*, token: uuid.UUID) -> dict[str, Any]:
    """Read-only peek at the activation target.

    The landing page calls this on mount so it can render either
    "set your password" (first-time) or "you already have an
    account — sign in" (returner) without making the user submit a
    blank form just to learn which side of the fence they're on.

    Returns a small dict — never the full proposal — so an actor
    sweeping random UUIDs gets only the masked email shape they'd
    have learned anyway from clicking the link in their inbox.
    """

    proposal = _resolve_proposal_by_token(token)
    if proposal is None:
        raise InvalidActivationToken(
            "No proposal matches this activation link."
        )

    customer = proposal.customer
    if customer is None:
        raise CustomerEmailMissing(
            "This proposal has no customer attached.",
        )
    email = _resolve_kiosk_email(proposal)
    if not email:
        raise CustomerEmailMissing(
            "The customer attached to this proposal has no email on file.",
        )

    account = ClientAccount.objects.filter(email__iexact=email).first()
    return {
        "customer_company": customer.company or customer.name or "",
        "email_masked": _mask_email(email),
        "already_activated": account is not None and account.has_usable_password(),
        "proposal_code": proposal.code or "",
    }


def _mask_email(email: str) -> str:
    """Return ``j****@example.com`` so the activation page can echo
    the recipient without exposing the full address to anyone who
    happens to have the URL but not the email itself.
    """

    if "@" not in email:
        return ""
    local, _, domain = email.partition("@")
    if len(local) <= 1:
        return f"*@{domain}"
    return f"{local[0]}{'*' * (len(local) - 1)}@{domain}"


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


def authenticate_client(
    *,
    email: str,
    password: str,
    request_ip: str = "",
) -> ClientAccount:
    """Return the authenticated :class:`ClientAccount`, or raise.

    Note ``django.contrib.auth.authenticate`` is wired through
    ``ModelBackend`` against ``AUTH_USER_MODEL`` (the staff users
    table) — that backend WILL NOT find a ``ClientAccount`` row.
    So we resolve manually here. The hash check still goes through
    Django's ``check_password`` so the timing characteristics match
    the staff login (no enumeration leak via response latency).
    """

    if not email or not password:
        raise InvalidCredentials("Email and password are required.")

    normalised = email.strip().lower()
    account = ClientAccount.objects.filter(email__iexact=normalised).first()
    if account is None or not account.is_active:
        # Always run a no-op check_password so the response timing
        # for "no such account" matches "wrong password". An
        # attacker probing the endpoint can't distinguish.
        ClientAccount().check_password(password)
        raise InvalidCredentials("Email or password is incorrect.")

    if not account.check_password(password):
        raise InvalidCredentials("Email or password is incorrect.")

    if not account.has_usable_password():
        # Edge case: account exists (pre-created on send) but never
        # activated. Treat the same as wrong password from the
        # client's POV; the activation link is the way through.
        raise InvalidCredentials("Email or password is incorrect.")

    if request_ip:
        account.last_login_ip = request_ip
        account.save(update_fields=["last_login_ip", "updated_at"])
    return account


# ---------------------------------------------------------------------------
# Password reset
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedPortalResetToken:
    """Returned by :func:`request_password_reset` on a hit so the
    caller can hand the plaintext to the email task."""

    account: ClientAccount
    plaintext_token: str


def _normalise_email(email: str) -> str:
    return (email or "").strip().lower()


def _hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


@transaction.atomic
def request_password_reset(
    *,
    email: str,
    requested_ip: str = "",
) -> IssuedPortalResetToken | None:
    """Issue a fresh reset token for ``email`` if a ClientAccount
    with that address exists.

    Always returns ``None`` to the caller on a miss. Enumeration
    contract identical to :func:`apps.accounts.services.request_password_reset`.
    """

    normalised = _normalise_email(email)
    if not normalised:
        return None

    account = ClientAccount.objects.filter(email__iexact=normalised).first()
    if account is None or not account.is_active:
        return None
    if not account.has_usable_password():
        # Not yet activated — the right path is the activation link
        # from their kiosk email, not a password reset. Treat as a
        # miss so we don't disclose the in-between state.
        return None

    now = timezone.now()
    # Invalidate every older in-flight token for this account so
    # only the freshest mail can succeed.
    ClientPasswordResetToken.objects.filter(
        account=account,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).update(invalidated_at=now)

    plaintext = secrets.token_urlsafe(48)
    ClientPasswordResetToken.objects.create(
        account=account,
        token_hash=_hash_token(plaintext),
        expires_at=now + PORTAL_PASSWORD_RESET_TOKEN_TTL,
        requested_ip=requested_ip,
    )
    return IssuedPortalResetToken(
        account=account,
        plaintext_token=plaintext,
    )


@transaction.atomic
def confirm_password_reset(*, token: str, new_password: str) -> ClientAccount:
    """Consume ``token`` and set the account's password.

    Raises ``ValueError`` for an invalid / expired / consumed token
    and ``django.core.exceptions.ValidationError`` for a weak
    password. The API layer maps both to 400 with a codified body.
    """

    if not token:
        raise ValueError("Reset token is required.")

    digest = _hash_token(token)
    row = ClientPasswordResetToken.objects.select_for_update().filter(
        token_hash=digest,
    ).first()
    if row is None or not row.is_consumable:
        raise ValueError("This reset link is no longer valid.")

    account = row.account
    validate_password(new_password, user=account)
    account.password = make_password(new_password)
    account.save(update_fields=["password", "updated_at"])

    row.used_at = timezone.now()
    row.save(update_fields=["used_at"])
    return account


# ---------------------------------------------------------------------------
# Pre-creation hook (called by the kiosk email send path)
# ---------------------------------------------------------------------------


@transaction.atomic
def ensure_pending_account(*, customer) -> ClientAccount | None:
    """Pre-create an inactive :class:`ClientAccount` row for a
    customer at email-send time.

    Why pre-create: the FK to Customer is durable from the moment
    the kiosk email goes out, so audit / link-back / future
    messaging features can attach against a stable account_id even
    before the customer clicks the link. The row has an unusable
    password until activation flips it.

    Returns ``None`` when the customer has no email — the caller
    should refuse to send the kiosk email in that case.
    """

    email = (customer.email or "").strip().lower()
    if not email:
        return None

    existing = ClientAccount.objects.filter(email__iexact=email).first()
    if existing is not None:
        return existing

    return ClientAccount.objects.create_account(
        email=email,
        customer=customer,
        password=None,
    )
