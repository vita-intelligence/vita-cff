"""Service layer for :class:`CustomerPortalInvite`.

Three operations:

1. :func:`create_invite` — staff-side. Generates a fresh
   ``(token, code, expires_at)`` triple, supersedes any prior open
   invite for the same customer, persists, and mails the code to the
   customer's address. Returns the persisted row plus the plaintext
   link the staff member will share by hand.
2. :func:`preview_invite` — public. Read-only peek at an invite
   token so the activate page can render a "Welcome, <Company>"
   header before the customer types anything.
3. :func:`activate_via_invite` — public. Validates token + code,
   creates / activates the bound :class:`ClientAccount`, and marks
   the invite consumed.

Same hashing + lifecycle conventions as the email-change and
password-reset flows in :mod:`apps.client_portal.profile_services`
and :mod:`apps.client_portal.services` — keep the patterns aligned
so a future audit can reason about one shape across all three.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.contrib.auth.password_validation import validate_password
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone

from apps.customers.models import Customer

from .email import send_portal_invite_email
from .models import ClientAccount, CustomerPortalInvite
from .services import (
    AccountAlreadyActivated,
    ActivationError,
    InvalidActivationCode,
    _mask_email,
)

logger = logging.getLogger(__name__)


#: 7-day expiry window. A staff-issued invite that goes unactioned
#: for a week is almost certainly stale (customer didn't see the
#: email, or has lost interest) — re-issuing is a single click on
#: the customers page so we don't pay much for the conservative
#: window.
INVITE_TTL = timedelta(days=7)


class InviteError(ActivationError):
    """Base class for any invite-time failure surface.

    Subclasses inherit :class:`ActivationError` so the API layer
    can map every invite + kiosk failure through a single ``except``
    chain. Each carries its own ``code`` for the wire response.
    """

    code: str = "invite_failed"


class InvalidInviteToken(InviteError):
    code = "invalid_invite_token"


class InviteExpired(InviteError):
    code = "invite_expired"


class InviteAlreadyUsed(InviteError):
    code = "invite_already_used"


class InviteEmailMissing(InviteError):
    code = "invite_email_missing"


@dataclass(frozen=True)
class IssuedInvite:
    """Returned by :func:`create_invite` — what the API hands back
    to the staff caller so the UI can render a copy-link button +
    the expiry hint."""

    invite: CustomerPortalInvite
    activation_url: str


@dataclass(frozen=True)
class InviteActivationResult:
    """Returned by :func:`activate_via_invite`. Mirrors the kiosk
    :class:`apps.client_portal.services.ActivationResult` shape so
    the API layer can serialise both through one path."""

    account: ClientAccount
    customer_id: str
    customer_company: str


def _hash_code(plaintext: str) -> str:
    """SHA-256 of the plaintext code. Same primitive used by
    :func:`apps.client_portal.profile_services._hash_code` — kept
    duplicated rather than imported to avoid the cross-module
    coupling, since the two callsites are independent lifecycles."""

    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _build_activation_url(token: uuid.UUID) -> str:
    """Compose the URL the staff member will share with the customer.

    Lives in this module so the staff-side endpoint can return the
    fully-qualified link in its response payload without re-deriving
    the frontend base on its own. Mirrors
    :func:`apps.client_portal.email._app_base_url` so SMTP-side
    links and clipboard-side links always agree.
    """

    from django.conf import settings

    base = (getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")
    if not base:
        base = "https://npd.vitaintelligent.com"
    return f"{base}/portal/activate-invite/{token}"


@transaction.atomic
def create_invite(
    *,
    customer: Customer,
    actor: Any,
) -> IssuedInvite:
    """Mint a fresh invite for ``customer`` and email the code.

    Side effects (run inside the atomic block so a mid-flight
    failure rolls everything back):

    * Any prior unused + unexpired invite for the same customer is
      stamped ``invalidated_at`` — only the freshest code in the
      customer's inbox can be redeemed. Matches the email-change /
      password-reset enumeration policy.
    * A new row is created with a freshly minted token + hashed
      code + 7-day expiry.
    * The code (plaintext) is mailed to ``customer.email``.

    Raises :class:`InviteEmailMissing` when the customer has no
    email on file — without that we can't deliver the verification
    code and the activate page would never complete. The customers
    page should hide the invite CTA in that case but we still guard
    defensively here.
    """

    email = (customer.email or "").strip()
    if not email:
        raise InviteEmailMissing(
            "The customer has no email on file; add one before issuing "
            "a portal invite."
        )

    now = timezone.now()
    CustomerPortalInvite.objects.filter(
        customer=customer,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).update(invalidated_at=now)

    plaintext_code = f"{secrets.randbelow(1_000_000):06d}"
    invite = CustomerPortalInvite.objects.create(
        customer=customer,
        code_hash=_hash_code(plaintext_code),
        email_snapshot=email.lower(),
        created_by=actor,
        expires_at=now + INVITE_TTL,
    )

    # Send the email *after* the row commits so a delivery failure
    # never leaves a usable invite the staff member doesn't realise
    # is unreachable. Wire the call through Django's ``send_mail``
    # path so a console-backend in dev still prints the code into
    # the runserver log.
    transaction.on_commit(
        lambda: send_portal_invite_email(
            to_email=email,
            code=plaintext_code,
            customer_company=customer.company or customer.name or "",
        )
    )

    return IssuedInvite(
        invite=invite,
        activation_url=_build_activation_url(invite.token),
    )


def preview_invite(*, token: uuid.UUID) -> dict[str, Any]:
    """Read-only summary the activate page paints on mount.

    Returns just enough for the page to render its header without
    asking the customer to submit a blank form first. Never leaks
    the full email — only the masked shape — so a stranger who
    happens to have the URL can't confirm the inbox it points at.

    Surfaces ``already_activated`` so a returning customer is
    routed to the sign-in form instead of seeing the password
    setup. ``expired`` distinguishes a too-late link (operator can
    re-issue) from a bad token (something more sinister).
    """

    invite = (
        CustomerPortalInvite.objects
        .select_related("customer")
        .filter(token=token)
        .first()
    )
    if invite is None:
        raise InvalidInviteToken("No invite matches this link.")

    customer = invite.customer
    email = invite.email_snapshot or (customer.email or "").strip().lower()
    if not email:
        # An invite that lost its email post-creation (because the
        # snapshot was empty and the customer's email got deleted)
        # is dead — surface the error so the operator re-issues.
        raise InviteEmailMissing(
            "This invite has no email on file; ask the team to re-issue it."
        )

    account = ClientAccount.objects.filter(email__iexact=email).first()
    already_activated = account is not None and account.has_usable_password()

    return {
        "customer_company": customer.company or customer.name or "",
        "email_masked": _mask_email(email),
        "already_activated": already_activated,
        "expired": (
            invite.used_at is not None
            or invite.invalidated_at is not None
            or invite.expires_at <= timezone.now()
        ),
    }


@transaction.atomic
def activate_via_invite(
    *,
    token: uuid.UUID,
    password: str,
    code: str,
) -> InviteActivationResult:
    """Consume an invite — set the customer's password, mark the
    invite used, and return the activated account.

    Mirrors the kiosk :func:`apps.client_portal.services.activate_via_token`
    contract:

    * Returners (account already has a usable password) raise
      :class:`AccountAlreadyActivated` *before* the code is even
      checked, so a stale code can't shadow the real next action
      ("sign in").
    * Code comparison is constant-time.
    * The plaintext password is validated against Django's
      password validators before any mutation lands.

    On success the invite row is stamped ``used_at`` and the bound
    :class:`ClientAccount` is created (if first time) or
    reactivated (if it existed without a usable password).
    """

    invite = (
        CustomerPortalInvite.objects
        .select_for_update()
        .select_related("customer")
        .filter(token=token)
        .first()
    )
    if invite is None:
        raise InvalidInviteToken("No invite matches this link.")

    customer = invite.customer
    email = invite.email_snapshot or (customer.email or "").strip().lower()
    if not email:
        raise InviteEmailMissing(
            "This invite has no email on file; ask the team to re-issue it."
        )

    # Lifecycle guards — order matters. ``already_activated`` wins
    # so a returner sees the "sign in" path even when the invite
    # itself is stale.
    account = ClientAccount.objects.filter(email__iexact=email).first()
    if account is not None and account.has_usable_password():
        raise AccountAlreadyActivated(
            "This email already has a portal account. Sign in instead.",
        )

    now = timezone.now()
    if invite.used_at is not None:
        raise InviteAlreadyUsed("This invite has already been used.")
    if invite.invalidated_at is not None:
        raise InviteAlreadyUsed(
            "A newer invite was issued for this customer; use that one.",
        )
    if invite.expires_at <= now:
        raise InviteExpired(
            "This invite link has expired. Ask the team to re-issue it.",
        )

    supplied = (code or "").strip()
    if not supplied or len(supplied) != 6 or not supplied.isdigit():
        raise InvalidActivationCode("Confirmation code must be 6 digits.")
    if not hmac.compare_digest(invite.code_hash, _hash_code(supplied)):
        raise InvalidActivationCode("Confirmation code is incorrect.")

    if account is None:
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

    account.activated_at = now
    account.customer = customer
    account.save(
        update_fields=[
            "password", "is_active", "activated_at", "customer", "updated_at",
        ],
    )

    invite.used_at = now
    invite.save(update_fields=["used_at"])

    return InviteActivationResult(
        account=account,
        customer_id=str(customer.id),
        customer_company=customer.company or customer.name or "",
    )


__all__ = [
    "INVITE_TTL",
    "InvalidInviteToken",
    "InviteAlreadyUsed",
    "InviteEmailMissing",
    "InviteError",
    "InviteExpired",
    "IssuedInvite",
    "InviteActivationResult",
    "activate_via_invite",
    "create_invite",
    "preview_invite",
]
