"""Symmetric encryption for org-level integration secrets.

Used by the Microsoft Dynamics integration (and any future
third-party integration) to keep customer-supplied API secrets
out of plaintext at rest. The org admin pastes their Dynamics
client secret into a settings form; the service layer calls
:func:`encrypt_secret` before persisting and :func:`decrypt_secret`
right before issuing an OAuth token request.

Key resolution
--------------
The Fernet key is read from ``DYNAMICS_SECRET_KEY``. If that env
var is missing we fall back to a deterministic derivation from
``DJANGO_SECRET_KEY`` so dev environments work out of the box —
production deployments should set ``DYNAMICS_SECRET_KEY`` to a
dedicated 32-byte url-safe base64 string (``Fernet.generate_key()``)
so a leaked Django secret key does not also compromise stored
CRM credentials.
"""

from __future__ import annotations

import base64
import hashlib
import os
from typing import Final

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


_KEY_ENV: Final[str] = "DYNAMICS_SECRET_KEY"


class DecryptionFailed(Exception):
    """Raised when an encrypted blob can't be decrypted.

    Surfaces as a 500 to the caller — happens when the secret-key env
    var was rotated without re-encrypting stored blobs, which means
    the secrets need to be re-entered by the org admin.
    """


def _resolve_key() -> bytes:
    explicit = os.environ.get(_KEY_ENV, "").strip()
    if explicit:
        return explicit.encode("ascii")
    # Dev fallback: derive a Fernet-shaped key from the Django secret
    # key so local development doesn't require setting a second env
    # var. SHA-256 → 32 bytes → base64-urlsafe is exactly what Fernet
    # expects.
    secret_key = getattr(settings, "SECRET_KEY", "") or ""
    if not secret_key:
        raise RuntimeError(
            "Cannot derive an integration encryption key — neither "
            f"{_KEY_ENV} nor DJANGO_SECRET_KEY is set."
        )
    digest = hashlib.sha256(secret_key.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _fernet() -> Fernet:
    return Fernet(_resolve_key())


def encrypt_secret(plaintext: str) -> str:
    """Encrypt ``plaintext`` and return a string safe to put in a
    JSON column / DB row. Empty input returns an empty string so
    callers can treat "no secret stored" as a falsy condition."""

    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_secret(ciphertext: str) -> str:
    """Reverse of :func:`encrypt_secret`. Empty input returns empty
    so an unconfigured integration is harmless to read.

    Raises :class:`DecryptionFailed` when the ciphertext can't be
    parsed — usually because the encryption key was rotated. The
    integration code should treat that as "the org needs to re-enter
    their secret" and surface a clear setup prompt rather than
    crashing the whole request.
    """

    if not ciphertext:
        return ""
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise DecryptionFailed(
            "Could not decrypt stored integration secret. Re-enter "
            "the credentials in Settings → Integrations."
        ) from exc
