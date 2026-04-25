"""Kiosk identity + comment-auth helpers.

The public spec-sheet URL (``/p/<token>``) has no login — anyone with
the signed link is an unauthenticated visitor. Commit 6 gives those
visitors a lightweight identity so they can post comments that
org-side members can reply to.

Flow:

1. The client's first visit pops an identity modal that collects a
   display name, email, and optional company label.
2. ``POST /api/public/specifications/<token>/identify/`` validates
   the share token, writes a :class:`KioskSession`, and returns a
   signed cookie keyed by the session's SHA-256.
3. Every subsequent kiosk call reads the cookie, validates it
   against the session row, bumps ``last_seen_at``, and treats the
   session as the comment's identity.

Revocation is a single field flip on :class:`KioskSession` —
rotating the share token also marks every session attached to the
old token as revoked.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from apps.comments.models import KioskSession


def _resolve_token_uuid(public_token: Any) -> uuid.UUID:
    """Resolve a kiosk share token to its canonical UUID.

    The same cookie / session machinery backs two share surfaces —
    spec sheets (``/p/<token>``) and proposals
    (``/p/proposal/<token>``) — and :class:`KioskSession` stores only
    the raw UUID, not an FK, so a single session row is agnostic to
    which document type issued it. We try the spec resolver first
    because that surface shipped earlier and is the hot path; fall
    back to the proposal resolver for tokens rotated onto the
    proposal kiosk. Raises :class:`KioskTokenInvalid` if neither
    owns the token (or if the value isn't a valid UUID).

    Imports are lazy so the comments app stays independent of the
    specifications / proposals app load order.
    """

    # Quick malformed-UUID rejection — both resolvers would raise on
    # this path anyway, but doing it once here avoids two pointless
    # DB queries and gives a consistent error code.
    try:
        canonical = uuid.UUID(str(public_token))
    except (ValueError, TypeError) as exc:
        raise KioskTokenInvalid() from exc

    from apps.specifications.services import (
        PublicLinkNotEnabled,
        get_by_public_token,
    )

    try:
        sheet = get_by_public_token(canonical)
    except PublicLinkNotEnabled:
        sheet = None
    if sheet is not None:
        return sheet.public_token

    from apps.proposals.services import (
        ProposalPublicLinkNotEnabled,
        get_proposal_by_public_token,
    )

    try:
        proposal = get_proposal_by_public_token(canonical)
    except ProposalPublicLinkNotEnabled as exc:
        raise KioskTokenInvalid() from exc
    return proposal.public_token


#: Cookie name for the signed session id. Scoped per-token so one
#: browser viewing two different shares does not cross-wire their
#: identities.
KIOSK_SESSION_COOKIE_PREFIX = "vita_kiosk_"

#: Salt used by :class:`django.core.signing.TimestampSigner`. Keyed
#: separately from the JWT secret so rotating the auth key doesn't
#: need to invalidate every kiosk session.
_SIGNING_SALT = "apps.comments.kiosk.v1"

#: Max age of a signed session cookie. Sessions older than this
#: auto-expire and the modal re-prompts for identity. Thirty days
#: matches the share-link's typical validity window.
_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

#: Per-session comment rate limit — 30 comments per hour. Blocks
#: accidental flood-posts from a broken keyboard / autoclicker
#: without getting in the way of a normal review session.
KIOSK_RATE_LIMIT_WINDOW_SECONDS = 60 * 60
KIOSK_RATE_LIMIT_MAX_COMMENTS = 30


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class KioskTokenInvalid(Exception):
    api_code = "kiosk_token_invalid"


class KioskSessionInvalid(Exception):
    api_code = "kiosk_session_invalid"


class KioskSessionRevoked(Exception):
    api_code = "kiosk_session_revoked"


class KioskRateLimited(Exception):
    api_code = "kiosk_rate_limited"


# ---------------------------------------------------------------------------
# Signing helpers
# ---------------------------------------------------------------------------


def _cookie_name(public_token: uuid.UUID) -> str:
    """Return the cookie name for the given share token.

    Each share token gets its own cookie so the browser can hold
    simultaneous sessions on distinct shares without clobbering.
    """

    return f"{KIOSK_SESSION_COOKIE_PREFIX}{public_token.hex[:16]}"


def _sign_session_id(session_id: uuid.UUID) -> str:
    return signing.TimestampSigner(salt=_SIGNING_SALT).sign(str(session_id))


def _unsign_session_id(signed: str) -> uuid.UUID | None:
    try:
        raw = signing.TimestampSigner(salt=_SIGNING_SALT).unsign(
            signed, max_age=_COOKIE_MAX_AGE_SECONDS
        )
        return uuid.UUID(raw)
    except (signing.BadSignature, signing.SignatureExpired, ValueError):
        return None


def _hash_cookie_value(cookie_value: str) -> str:
    return hashlib.sha256(cookie_value.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class KioskIdentity:
    """Caller's parsed identity for a public comment request."""

    session: KioskSession
    public_token: uuid.UUID
    cookie_name: str


def attach_cookie(response, session: KioskSession) -> None:
    """Stamp the signed session cookie onto ``response``.

    The cookie's SHA-256 must equal :attr:`KioskSession.session_hash`
    so subsequent requests can validate by fetching the row with
    ``session_hash=<sha>`` rather than trusting the raw signed
    payload alone. This double guard means that even if the signing
    key leaked, a stolen cookie can be revoked by deleting the
    matching row.
    """

    cookie_value = _sign_session_id(session.id)
    response.set_cookie(
        key=_cookie_name(session.public_token),
        value=cookie_value,
        max_age=_COOKIE_MAX_AGE_SECONDS,
        secure=getattr(settings, "AUTH_COOKIE_SECURE", False),
        httponly=True,
        samesite="Lax",
    )


def clear_cookie(response, public_token: uuid.UUID) -> None:
    response.delete_cookie(_cookie_name(public_token), samesite="Lax")


@transaction.atomic
def identify_visitor(
    *,
    public_token: str,
    guest_name: str,
    guest_email: str,
    guest_org_label: str = "",
) -> tuple[KioskSession, uuid.UUID]:
    """Create or refresh a kiosk session for the given share token.

    The target document's token is validated against
    :func:`_resolve_token_uuid`, which probes both the spec-sheet
    and proposal share surfaces, encapsulating the "revoked /
    missing / never shared" disambiguation — we never leak
    existence of a deleted document.
    """

    token_uuid = _resolve_token_uuid(public_token)
    name = (guest_name or "").strip()
    email = (guest_email or "").strip().lower()
    company = (guest_org_label or "").strip()
    if not name or not email:
        raise KioskTokenInvalid()

    # Fresh session row. We deliberately do **not** dedupe by email
    # + token: a returning visitor from a new browser needs a fresh
    # cookie, and the old session rotting to ``revoked_at`` is
    # unavoidable. The storage hit is tiny (kilobytes per visitor).
    session = KioskSession.objects.create(
        public_token=token_uuid,
        guest_name=name[:120],
        guest_email=email[:254],
        guest_org_label=company[:120],
        # ``session_hash`` is filled after we know the signed cookie
        # value — we hash it below rather than generating twice.
        session_hash=secrets.token_urlsafe(40),
    )
    cookie_value = _sign_session_id(session.id)
    session.session_hash = _hash_cookie_value(cookie_value)
    session.save(update_fields=["session_hash"])
    return session, token_uuid


def resolve_from_request(request, public_token: str) -> KioskIdentity:
    """Validate the request's cookie for the given share token.

    Raises :class:`KioskSessionInvalid` when the cookie is missing,
    unsignable, or expired; :class:`KioskSessionRevoked` when the
    row was revoked (share-link rotation). The view layer turns
    each of these into a ``403`` with the corresponding
    ``api_code``.
    """

    token_uuid = _resolve_token_uuid(public_token)

    cookie_name = _cookie_name(token_uuid)
    signed_value = request.COOKIES.get(cookie_name)
    if not signed_value:
        raise KioskSessionInvalid()

    session_id = _unsign_session_id(signed_value)
    if session_id is None:
        raise KioskSessionInvalid()

    session_hash = _hash_cookie_value(signed_value)
    session = (
        KioskSession.objects.filter(
            id=session_id, session_hash=session_hash
        )
        .first()
    )
    if session is None:
        raise KioskSessionInvalid()
    if session.revoked_at is not None:
        raise KioskSessionRevoked()
    if session.public_token != token_uuid:
        # Cookie was issued for a different share token — happens
        # when the owner revokes one link and reuses the slot.
        raise KioskSessionInvalid()

    # Best-effort heartbeat. Don't blow up the request if the
    # ``last_seen_at`` write fails.
    try:
        session.last_seen_at = timezone.now()
        session.save(update_fields=["last_seen_at"])
    except Exception:  # noqa: BLE001
        pass

    return KioskIdentity(
        session=session, public_token=token_uuid, cookie_name=cookie_name
    )


def revoke_sessions_for_token(public_token: uuid.UUID) -> int:
    """Mark every active session for ``public_token`` as revoked.

    Called when the spec-sheet owner rotates or revokes the share
    link. Returns the row count for the caller's audit trail.
    """

    now = timezone.now()
    return KioskSession.objects.filter(
        public_token=public_token, revoked_at__isnull=True
    ).update(revoked_at=now)


def enforce_rate_limit(session: KioskSession) -> None:
    """Reject a comment write when the session is over the hour cap.

    Implemented via a direct DB count instead of Redis so the gate
    works on the in-memory dev / test stack without extra infra.
    The cap is small enough that the count is cheap.
    """

    from apps.comments.models import Comment

    window_start = timezone.now() - timedelta(
        seconds=KIOSK_RATE_LIMIT_WINDOW_SECONDS
    )
    count = Comment.objects.filter(
        guest_session_hash=session.session_hash,
        created_at__gte=window_start,
    ).count()
    if count >= KIOSK_RATE_LIMIT_MAX_COMMENTS:
        raise KioskRateLimited()
