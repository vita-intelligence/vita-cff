"""WebsiteAccessToken service layer.

Mint / list / revoke / verify — same shape as
:mod:`apps.psp.token_services` but scoped to the website integration.
Two separate token surfaces exist on purpose: rotating (or
compromising) one shouldn't force us to rotate the other.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from django.contrib.auth.hashers import check_password, make_password
from django.db import transaction
from django.utils import timezone

from apps.website.models import TOKEN_PREFIX_LENGTH, WebsiteAccessToken


class WebsiteAccessTokenNameConflict(Exception):
    """A token with that name already exists for this organization.
    Enforced by the DB unique index; caught here so the API surface
    can return a friendly 409."""

    code = "website_access_token_name_conflict"


@dataclass(frozen=True)
class MintResult:
    """Return value from :func:`mint_website_access_token`. Carries the
    freshly-minted raw string exactly once — the caller MUST render it
    to the operator immediately and drop the reference; there is no
    server-side pathway to recover it."""

    token: WebsiteAccessToken
    raw_token: str


@transaction.atomic
def mint_website_access_token(
    *, organization: Any, actor: Any, name: str
) -> MintResult:
    """Create a new website-facing token for ``organization``.

    Generates the raw bearer string, hashes it, and persists the row.
    The raw is returned in the :class:`MintResult` and never touched
    again — subsequent reads only ever return the prefix.

    Raises :class:`WebsiteAccessTokenNameConflict` when the name
    clashes with an existing (active or revoked) token on the same
    org.
    """

    name = (name or "").strip()
    if not name:
        raise ValueError("website_access_token_name_required")
    if len(name) > 100:
        raise ValueError("website_access_token_name_too_long")

    if WebsiteAccessToken.objects.filter(
        organization=organization, name=name
    ).exists():
        raise WebsiteAccessTokenNameConflict()

    raw = WebsiteAccessToken.mint_raw()

    row = WebsiteAccessToken.objects.create(
        organization=organization,
        name=name,
        token_hash=make_password(raw),
        token_prefix=raw[:TOKEN_PREFIX_LENGTH],
        created_by=actor if getattr(actor, "is_authenticated", False) else None,
    )

    _audit(
        organization=organization,
        actor=actor,
        action="website_access_token.created",
        target=row,
        after={"id": str(row.id), "name": row.name, "prefix": row.token_prefix},
    )
    return MintResult(token=row, raw_token=raw)


def list_website_access_tokens(
    *, organization: Any
) -> list[WebsiteAccessToken]:
    """Every token (active + revoked) on the org, most-recently-created
    first."""

    return list(
        WebsiteAccessToken.objects.filter(organization=organization)
        .select_related("created_by", "revoked_by")
        .order_by("-created_at")
    )


@transaction.atomic
def revoke_website_access_token(
    *,
    organization: Any,
    actor: Any,
    token_id: Any,
    reason: str = "",
) -> WebsiteAccessToken:
    """Soft-revoke ``token_id``. Subsequent verify attempts silently
    return ``None`` from :func:`verify_website_access_token`."""

    row = WebsiteAccessToken.objects.select_for_update().get(
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
        action="website_access_token.revoked",
        target=row,
        after={"id": str(row.id), "reason": row.revoke_reason},
    )
    return row


def verify_website_access_token(
    *, raw_token: str
) -> WebsiteAccessToken | None:
    """Look up + bcrypt-verify an incoming raw token.

    Returns the matching active :class:`WebsiteAccessToken` on success
    and ``None`` otherwise. Prefix-indexed so the scan stays cheap.
    """

    if not isinstance(raw_token, str) or not raw_token.strip():
        return None
    raw = raw_token.strip()

    candidates = WebsiteAccessToken.objects.filter(
        revoked_at__isnull=True,
        token_prefix=raw[:TOKEN_PREFIX_LENGTH],
    ).select_related("organization")

    for candidate in candidates:
        if check_password(raw, candidate.token_hash):
            try:
                candidate.touch_last_used()
            except Exception:
                # Best-effort — auth decision is what matters.
                pass
            return candidate

    return None


def _audit(*, organization, actor, action, target, after):
    """Best-effort audit log entry. Swallows any error so a
    misconfigured audit backend can't block a token mint / revoke."""

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
