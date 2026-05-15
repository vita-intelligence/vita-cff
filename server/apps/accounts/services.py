"""Domain services for the accounts app.

This module owns the password-reset escape hatch: the
*request → email → confirm* flow that lets users recover access to
their account without an operator in the loop. The contract here is
deliberately narrow — three pure functions that the API layer
composes — so the security-sensitive bits (token hashing, expiry,
single-use enforcement, password rotation) stay in one auditable
file.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass
from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import PASSWORD_RESET_TOKEN_TTL, PasswordResetToken

logger = logging.getLogger(__name__)
UserModel = get_user_model()


# Plaintext entropy budget — 32 bytes of os.urandom encoded as
# URL-safe base64 ≈ 43 characters, ~256 bits of entropy. Brute-forcing
# this even at 1B guesses/sec would still take longer than the
# expiry window by many orders of magnitude.
_TOKEN_BYTES = 32


class PasswordResetTokenInvalid(Exception):
    """Raised when a reset attempt presents a token the system does
    not recognise (never issued, or already deleted)."""

    code = "password_reset_token_invalid"


class PasswordResetTokenExpired(Exception):
    """Raised when the presented token has past its ``expires_at``."""

    code = "password_reset_token_expired"


class PasswordResetTokenUsed(Exception):
    """Raised when the presented token was already consumed."""

    code = "password_reset_token_used"


class PasswordResetTokenInvalidated(Exception):
    """Raised when a fresher request superseded this token before
    the user clicked through."""

    code = "password_reset_token_invalidated"


class PasswordResetPasswordInvalid(Exception):
    """Wraps a Django ``validate_password`` failure with the
    validator codes (e.g. ``password_too_short``) so the API layer
    can surface them per-field without losing the machine-readable
    handles the frontend uses for i18n."""

    code = "password_reset_password_invalid"

    def __init__(self, codes: list[str]):
        super().__init__("invalid password")
        self.codes = codes


@dataclass(frozen=True)
class IssuedToken:
    """Plaintext token returned to the caller exactly once, alongside
    the persisted ``PasswordResetToken`` row.

    The caller is responsible for getting the plaintext into the
    email body and then dropping it on the floor — we never want a
    second copy living in a log line or an audit row.
    """

    plaintext: str
    record: PasswordResetToken


def _hash_token(plaintext: str) -> str:
    """Return the canonical SHA-256 hex digest used as the DB key.

    SHA-256 is overkill for an already high-entropy 32-byte secret
    (no need for a slow KDF — we are not protecting against offline
    brute force of low-entropy inputs), but it is the de-facto
    standard for opaque-token storage and keeps a stable column
    width for indexing.
    """

    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def _normalise_email(value: str) -> str:
    return UserModel.objects.normalize_email((value or "").strip())


@transaction.atomic
def request_password_reset(
    *, email: str, requested_ip: str = ""
) -> IssuedToken | None:
    """Issue a fresh reset token for ``email`` if a user with that
    address exists.

    Always returns ``None`` to the caller when the email is unknown,
    inactive, or the user could not be located — *the API layer must
    not branch on the return value*. This is the enumeration safety
    contract: an attacker probing the endpoint with a list of emails
    must see exactly the same response shape for hits and misses, so
    the only side effect that differs is the (asynchronous) email
    send.

    When a user does match, every prior unused token is marked
    ``invalidated_at`` so only the freshest link in the user's inbox
    can succeed — older mails become decorative.
    """

    normalised = _normalise_email(email)
    if not normalised:
        return None

    user = UserModel.objects.filter(email__iexact=normalised).first()
    if user is None or not user.is_active:
        return None

    # Invalidate every still-consumable prior token first. This is
    # what makes the "most recent link wins" promise hold: if a user
    # clicks the panic button twice, only the second mail's link
    # works.
    now = timezone.now()
    PasswordResetToken.objects.filter(
        user=user,
        used_at__isnull=True,
        invalidated_at__isnull=True,
        expires_at__gt=now,
    ).update(invalidated_at=now)

    plaintext = secrets.token_urlsafe(_TOKEN_BYTES)
    record = PasswordResetToken.objects.create(
        user=user,
        token_hash=_hash_token(plaintext),
        expires_at=now + PASSWORD_RESET_TOKEN_TTL,
        requested_ip=requested_ip[:45],
    )
    return IssuedToken(plaintext=plaintext, record=record)


def _load_token(plaintext: str) -> PasswordResetToken:
    """Resolve the plaintext to its persisted row, mapping each
    failure mode to a distinct exception so the API can emit
    user-friendly codes instead of a single opaque 400.

    Order matters: we check ``used`` before ``expired`` so a user
    re-clicking a recently used link gets a clear "already used"
    rather than a confusing "expired" once the original window
    rolls over.
    """

    if not isinstance(plaintext, str) or not plaintext:
        raise PasswordResetTokenInvalid()
    try:
        record = PasswordResetToken.objects.select_related("user").get(
            token_hash=_hash_token(plaintext)
        )
    except PasswordResetToken.DoesNotExist as exc:
        raise PasswordResetTokenInvalid() from exc
    if record.used_at is not None:
        raise PasswordResetTokenUsed()
    if record.invalidated_at is not None:
        raise PasswordResetTokenInvalidated()
    if record.expires_at <= timezone.now():
        raise PasswordResetTokenExpired()
    return record


def validate_password_reset_token(*, token: str) -> PasswordResetToken:
    """Peek at a token's validity without consuming it.

    The frontend calls this on the reset-page mount so it can show
    "this link has expired" before the user has typed a password.
    Raises the same exceptions as :func:`consume_password_reset_token`
    so the API surface is consistent.
    """

    return _load_token(token)


@transaction.atomic
def consume_password_reset_token(
    *, token: str, new_password: str
) -> Any:
    """Validate the token, rotate the user's password, and atomically
    mark this row used + every sibling row invalidated.

    Returns the freshly-saved ``User``. The caller does *not* receive
    new auth cookies — successful reset still requires an explicit
    login so the user can confirm they have the password they just
    set.

    Raises:
      * ``PasswordResetTokenInvalid`` / ``Expired`` / ``Used`` /
        ``Invalidated`` — single source of truth via :func:`_load_token`.
      * ``PasswordResetPasswordInvalid`` — Django's password validators
        rejected ``new_password``; ``.codes`` carries the validator
        identifiers for i18n.
    """

    record = _load_token(token)
    user = record.user

    try:
        validate_password(new_password, user=user)
    except DjangoValidationError as exc:
        codes = [e.code for e in exc.error_list if getattr(e, "code", None)]
        raise PasswordResetPasswordInvalid(codes or ["invalid_password"]) from exc

    user.set_password(new_password)
    user.save(update_fields=["password"])

    now = timezone.now()
    record.used_at = now
    record.save(update_fields=["used_at"])

    # Burn every still-live sibling token. This closes the window
    # where a user with two outstanding reset emails could replay the
    # second one after using the first.
    PasswordResetToken.objects.filter(
        user=user,
        used_at__isnull=True,
        invalidated_at__isnull=True,
    ).exclude(pk=record.pk).update(invalidated_at=now)

    logger.info(
        "Password reset completed for user_id=%s token_id=%s",
        user.id,
        record.id,
    )
    return user
