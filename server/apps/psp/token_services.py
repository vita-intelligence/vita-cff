"""PspAccessToken service layer.

Kept in a dedicated module (rather than folded into
``apps.psp.services``) because the outbound-client side of that module
is already ~3k lines. The token surface is small and self-contained;
splitting keeps both readable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone

from apps.psp.models import PspAccessToken, TOKEN_PREFIX_LENGTH


class PspAccessTokenNameConflict(Exception):
    """A token with that name already exists for this organization.
    Enforced by the DB unique index; caught here so the API surface
    can return a friendly 409."""

    code = "psp_access_token_name_conflict"


@dataclass(frozen=True)
class MintResult:
    """Return value from :func:`mint_psp_access_token`. Carries the
    freshly-minted raw string exactly once — the caller MUST render it
    to the operator immediately and drop the reference; there is no
    server-side pathway to recover it."""

    token: PspAccessToken
    raw_token: str


@transaction.atomic
def mint_psp_access_token(
    *, organization: Any, actor: Any, name: str
) -> MintResult:
    """Create a new PSP-facing token for ``organization``.

    Generates the raw bearer string, hashes it, and persists the row.
    The raw is returned in the :class:`MintResult` and never touched
    again — subsequent reads only ever return the prefix.

    Raises :class:`PspAccessTokenNameConflict` when the name clashes
    with an existing (active or revoked) token on the same org.
    """

    name = (name or "").strip()
    if not name:
        raise ValueError("psp_access_token_name_required")
    if len(name) > 100:
        raise ValueError("psp_access_token_name_too_long")

    if PspAccessToken.objects.filter(
        organization=organization, name=name
    ).exists():
        raise PspAccessTokenNameConflict()

    raw = PspAccessToken.mint_raw()

    row = PspAccessToken.objects.create(
        organization=organization,
        name=name,
        token_hash=make_password(raw),
        token_prefix=raw[:TOKEN_PREFIX_LENGTH],
        created_by=actor if getattr(actor, "is_authenticated", False) else None,
    )

    _audit(
        organization=organization,
        actor=actor,
        action="psp_access_token.created",
        target=row,
        after={"id": str(row.id), "name": row.name, "prefix": row.token_prefix},
    )
    return MintResult(token=row, raw_token=raw)


def list_psp_access_tokens(
    *, organization: Any
) -> list[PspAccessToken]:
    """Every token (active + revoked) on the org, most-recently-created
    first. Revoked rows are kept so the settings page can render a
    history / attribute audit lines back to a name."""

    return list(
        PspAccessToken.objects.filter(organization=organization)
        .select_related("created_by", "revoked_by")
        .order_by("-created_at")
    )


@transaction.atomic
def revoke_psp_access_token(
    *,
    organization: Any,
    actor: Any,
    token_id: Any,
    reason: str = "",
) -> PspAccessToken:
    """Soft-revoke ``token_id`` — sets ``revoked_at`` and records who
    did it and why. Subsequent verify attempts against the token
    silently return ``None`` from :func:`verify_psp_access_token`."""

    row = PspAccessToken.objects.select_for_update().get(
        id=token_id, organization=organization
    )
    if row.revoked_at is not None:
        return row

    row.revoked_at = timezone.now()
    row.revoked_by = (
        actor if getattr(actor, "is_authenticated", False) else None
    )
    row.revoke_reason = (reason or "")[:200]
    row.save(update_fields=["revoked_at", "revoked_by", "revoke_reason"])

    _audit(
        organization=organization,
        actor=actor,
        action="psp_access_token.revoked",
        target=row,
        after={"id": str(row.id), "reason": row.revoke_reason},
    )
    return row


def verify_psp_access_token(
    *, raw_token: str
) -> PspAccessToken | None:
    """Look up + bcrypt-verify an incoming raw token.

    Returns the matching active :class:`PspAccessToken` on success and
    ``None`` otherwise. Prefix-indexed so the scan stays cheap even
    with hundreds of tokens in the table — bcrypt itself only runs on
    the small number of candidates that share a prefix. Non-atomic
    ``touch_last_used`` at the end so audit-style timestamps land
    without gating the auth path on a write lock.
    """

    if not isinstance(raw_token, str) or not raw_token.strip():
        return None
    raw = raw_token.strip()

    candidates = PspAccessToken.objects.filter(
        revoked_at__isnull=True,
        token_prefix=raw[:TOKEN_PREFIX_LENGTH],
    ).select_related("organization")

    for candidate in candidates:
        if check_password(raw, candidate.token_hash):
            try:
                candidate.touch_last_used()
            except Exception:
                # Best-effort — the auth decision is what matters; a
                # transient DB blip on the touch write shouldn't 500 the
                # caller. The next successful verify will refresh it.
                pass
            return candidate

    return None


# ----- Audit ---------------------------------------------------------


def _audit(*, organization, actor, action, target, after):
    """Best-effort audit log entry. Swallows any error so a
    misconfigured audit backend can't block a token mint / revoke —
    the DB rows themselves carry created_by / revoked_by which is the
    primary attribution surface."""

    try:
        from apps.audit.services import record

        record(
            organization=organization,
            actor=actor,
            action=action,
            target=target,
            after=after,
        )
    except Exception:
        pass
