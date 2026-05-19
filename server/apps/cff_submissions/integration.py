"""Per-org Wix CFF integration config — CRUD + live-test helpers.

Mirror of :mod:`apps.proposals.mrpeasy` and the Dynamics counterpart
in :mod:`apps.customers.services`. The Wix API key (one credential,
no separate id/secret pair) is stored Fernet-encrypted on the
``Organization.wix_cff_config`` JSONField; everything else (site
id, form id, namespace) is plaintext because it's not a secret.

Public surface:

* :func:`is_wix_cff_live` — single source of truth for "should the
  poller and the UI act as if Wix is connected?".
* :func:`get_wix_cff_config` — typed config with the plaintext key,
  decrypted on demand. Never return this directly from an API
  endpoint — use :func:`serialize_wix_cff_config_for_api`.
* :func:`set_wix_cff_config` / :func:`clear_wix_cff_config` — write
  paths. Both audit; both invalidate any cached connectivity flag.
* :func:`verify_wix_cff_connection` — fires one cheap HTTP probe
  (`count` endpoint) and stamps ``last_tested_at`` on success.

Errors:

* :class:`WixCFFNotConfigured` — config absent or disabled. API maps
  to 400 so the settings page surfaces "set up Wix CFF first".
* :class:`WixCFFDecryptionFailed` — stored ciphertext can't be
  decrypted (typically because :envvar:`DYNAMICS_SECRET_KEY` was
  rotated without re-encrypting). API maps to 500; the operator
  re-enters the API key to recover.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class WixCFFNotConfigured(Exception):
    """The org has no usable Wix CFF config (missing fields, or
    integration disabled). The API layer maps this to a 400."""

    code = "wix_cff_not_configured"


class WixCFFDecryptionFailed(Exception):
    """Stored ciphertext could not be decrypted — the operator must
    re-enter the API key."""

    code = "wix_cff_decryption_failed"


# ---------------------------------------------------------------------------
# Dataclass — typed view of the stored config (plaintext key)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WixCFFConfig:
    """In-memory shape of an org's Wix CFF integration config.

    Lives behind :func:`get_wix_cff_config` so callers never see
    the raw JSONField shape and never reach for the encrypted blob
    directly.
    """

    enabled: bool
    api_key: str
    site_id: str
    form_id: str
    namespace: str

    @property
    def is_complete(self) -> bool:
        """All four required fields filled in. ``last_tested_at`` is
        not part of completeness — a fresh-rotated key is "complete"
        before the operator clicks Test."""

        return bool(
            self.api_key
            and self.site_id
            and self.form_id
            and self.namespace
        )


# ---------------------------------------------------------------------------
# Read paths
# ---------------------------------------------------------------------------


def is_wix_cff_live(organization: Any) -> bool:
    """Return True when the org has a usable Wix CFF integration
    (``enabled`` and all required fields set). Used by the Celery
    task to decide whether to poll this org."""

    raw = (organization.wix_cff_config or {}) if organization else {}
    return bool(
        raw.get("enabled")
        and raw.get("api_key_ciphertext")
        and raw.get("site_id")
        and raw.get("form_id")
    )


def get_wix_cff_config(*, organization: Any) -> WixCFFConfig:
    """Decode the stored config and return it with the plaintext API
    key. The Celery task and the verify endpoint call this; never
    expose the result on the wire — use
    :func:`serialize_wix_cff_config_for_api`.
    """

    raw = (organization.wix_cff_config or {}) if organization else {}
    if not raw.get("enabled"):
        raise WixCFFNotConfigured(
            "Wix CFF integration is disabled for this organisation."
        )
    return WixCFFConfig(
        enabled=True,
        api_key=_decrypt_api_key(raw),
        site_id=str(raw.get("site_id") or "").strip(),
        form_id=str(raw.get("form_id") or "").strip(),
        namespace=str(raw.get("namespace") or "wix.form_app.form").strip(),
    )


def _decrypt_api_key(raw: dict[str, Any]) -> str:
    """Decrypt the stored ciphertext into the plaintext API key.

    Lazy-imports the encryption module so tests that mock the
    integration entirely don't pay the cost of loading
    ``cryptography``.
    """

    from apps.organizations.encryption import (
        DecryptionFailed,
        decrypt_secret,
    )

    ciphertext = str(raw.get("api_key_ciphertext") or "")
    if not ciphertext:
        return ""
    try:
        return decrypt_secret(ciphertext)
    except DecryptionFailed as exc:
        raise WixCFFDecryptionFailed(str(exc)) from exc


def serialize_wix_cff_config_for_api(organization: Any) -> dict[str, Any]:
    """Public wire shape — never includes the plaintext API key.

    The frontend uses ``has_api_key`` to render a "●●●●●●" placeholder
    instead of the empty field, so an admin who just wants to flip
    ``enabled`` doesn't have to re-paste the credential.
    """

    raw = (organization.wix_cff_config or {}) if organization else {}
    return {
        "enabled": bool(raw.get("enabled")),
        "has_api_key": bool(raw.get("api_key_ciphertext")),
        "site_id": str(raw.get("site_id") or ""),
        "form_id": str(raw.get("form_id") or ""),
        "namespace": str(raw.get("namespace") or "wix.form_app.form"),
        "last_tested_at": raw.get("last_tested_at"),
    }


# ---------------------------------------------------------------------------
# Write paths — all audited, all atomic
# ---------------------------------------------------------------------------


def set_wix_cff_config(
    *,
    organization: Any,
    actor: Any,
    enabled: bool,
    site_id: str,
    form_id: str,
    namespace: str,
    api_key: str | None,
) -> dict[str, Any]:
    """Persist the org's Wix CFF config.

    ``api_key=None`` (or empty string) is the "keep existing secret"
    sentinel — same UX as the MRPEasy and Dynamics settings cards.
    Rotating the secret clears ``last_tested_at`` so the green
    "Connected" badge can't survive a credential change without a
    fresh Test click.

    Returns the API wire shape so the caller can hand it straight
    back to the frontend.
    """

    from apps.audit.services import record as record_audit, snapshot
    from apps.organizations.encryption import encrypt_secret

    with transaction.atomic():
        before = snapshot(organization)
        existing = organization.wix_cff_config or {}

        if api_key is None or api_key == "":
            ciphertext = str(existing.get("api_key_ciphertext") or "")
            last_tested_at = existing.get("last_tested_at")
        else:
            ciphertext = encrypt_secret(api_key)
            # Fresh secret => any prior "Connected" state is stale.
            last_tested_at = None

        organization.wix_cff_config = {
            "enabled": bool(enabled),
            "api_key_ciphertext": ciphertext,
            "site_id": (site_id or "").strip(),
            "form_id": (form_id or "").strip(),
            "namespace": (namespace or "wix.form_app.form").strip(),
            "last_tested_at": last_tested_at,
        }
        organization.save(update_fields=["wix_cff_config", "updated_at"])
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.wix_cff.configure",
            target=organization,
            before=before,
            after=snapshot(organization),
        )

    return serialize_wix_cff_config_for_api(organization)


def clear_wix_cff_config(*, organization: Any, actor: Any) -> dict[str, Any]:
    """Wipe the org's Wix CFF config (DELETE endpoint).

    Imported CFF rows are NOT cascade-deleted — they live in their
    own table and stay browseable as a historical record. Future
    polls just stop adding to the pile.
    """

    from apps.audit.services import record as record_audit, snapshot

    with transaction.atomic():
        before = snapshot(organization)
        organization.wix_cff_config = {}
        organization.save(update_fields=["wix_cff_config", "updated_at"])
        record_audit(
            organization=organization,
            actor=actor,
            action="integration.wix_cff.clear",
            target=organization,
            before=before,
            after=snapshot(organization),
        )
    return serialize_wix_cff_config_for_api(organization)


def stamp_last_tested(*, organization: Any) -> None:
    """Mark the integration as just-verified.

    Called from :func:`verify_wix_cff_connection` after a successful
    probe. Kept as a tiny helper so the verify-then-stamp flow stays
    atomic and we never write ``last_tested_at`` on a failed probe.
    """

    raw = dict(organization.wix_cff_config or {})
    raw["last_tested_at"] = timezone.now().isoformat()
    organization.wix_cff_config = raw
    organization.save(update_fields=["wix_cff_config", "updated_at"])


def stamp_last_poll(*, organization: Any) -> None:
    """Mark a successful poll cycle.

    Called at the end of every :func:`import_cff_submissions_for_org`
    run, *whether or not anything changed*. The inbox UI reads this
    stamp to render "last sync: X ago" so users can see the system
    is healthy even during quiet periods.
    """

    raw = dict(organization.wix_cff_config or {})
    raw["last_poll_at"] = timezone.now().isoformat()
    organization.wix_cff_config = raw
    organization.save(update_fields=["wix_cff_config", "updated_at"])


__all__ = [
    "WixCFFConfig",
    "WixCFFDecryptionFailed",
    "WixCFFNotConfigured",
    "clear_wix_cff_config",
    "get_wix_cff_config",
    "is_wix_cff_live",
    "serialize_wix_cff_config_for_api",
    "set_wix_cff_config",
    "stamp_last_poll",
    "stamp_last_tested",
]
