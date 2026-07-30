"""PSP-facing access tokens.

Machine-to-machine bearer tokens the PSP side presents when it calls
NPD's ``/api/psp-integration/*`` surface. Mirrors the shape PSP itself
uses for its own outbound tokens (``Backend.Accounts.IntegrationToken``
in Elixir), scoped down to the single use case we currently expose:
reading the R&D in-development formulation list for PSP's kanban.

**Design**:

* ``token_hash`` — bcrypt hash of the raw token. The plaintext leaves
  the boundary exactly once on ``mint_psp_access_token`` and is never
  persisted or returned by any subsequent endpoint.
* ``token_prefix`` — first few chars of the raw token, stored plaintext
  for display so admins can distinguish tokens on the settings page
  without decrypting anything. Length matches PSP's convention.
* ``revoked_at`` / ``revoked_by`` — soft-delete. The row stays in the
  table so historical audit references keep resolving.
* Per-organization scoping — a token authenticates a call and scopes
  its response to that organization's formulations only. No cross-
  tenant reads.
"""

from __future__ import annotations

import secrets
import uuid
from typing import ClassVar

from django.conf import settings
from django.db import models
from django.utils import timezone


#: Length (bytes) of the random seed we hex-encode into a token. 32
#: bytes → 64 hex chars, which comfortably matches "opaque bearer
#: token" convention and stays under HTTP header limits.
_TOKEN_ENTROPY_BYTES: int = 32

#: How many leading chars of the raw token we retain as a prefix for
#: display. Enough to disambiguate tokens ("6d3f…") without leaking
#: enough entropy to compromise the secret.
TOKEN_PREFIX_LENGTH: int = 8


def _mint_raw_token() -> str:
    """Generate a fresh opaque bearer string. Hex-encoded so it
    survives copy/paste through terminals, emails, Slack, etc.
    without newline / whitespace mangling."""

    return secrets.token_hex(_TOKEN_ENTROPY_BYTES)


class PspAccessToken(models.Model):
    """One PSP-facing access token.

    Created by an admin via ``/settings/integrations``; presented by
    PSP as ``Authorization: Bearer <raw>`` on every call to NPD's
    ``/api/psp-integration/*`` endpoints. On verify we bcrypt-check
    the incoming raw against every active row for the org, so token
    hashes stay opaque and rotation is a mint-new-then-revoke-old
    flow — tokens can't be edited in place.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="psp_access_tokens",
    )

    #: Human-readable name so admins can tell tokens apart on the
    #: settings page ("Production", "Staging", "Alex's laptop"). Unique
    #: per org so a fresh mint can't silently collide with an existing
    #: entry.
    name = models.CharField(max_length=100)

    #: bcrypt hash of the raw token. Django's ``make_password`` +
    #: ``check_password`` from ``django.contrib.auth.hashers`` handle
    #: the format; kept in a plain CharField (rather than the auth
    #: user's ``password`` field) so the token surface has no accidental
    #: overlap with real user credentials.
    token_hash = models.CharField(max_length=255)

    #: First TOKEN_PREFIX_LENGTH chars of the raw token. Rendered
    #: verbatim on the settings page so admins can tell "6d3f… (mine)"
    #: from "e91a… (staging)" at a glance.
    token_prefix = models.CharField(max_length=TOKEN_PREFIX_LENGTH)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    revoke_reason = models.CharField(max_length=200, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "name"),
                name="psp_access_token_unique_name_per_org",
            ),
        ]
        indexes = [
            #: Verify path scans by prefix across active rows for the
            #: org — index on ``(revoked_at, token_prefix)`` keeps that
            #: cheap even with many revoked rows sticking around.
            models.Index(fields=("revoked_at", "token_prefix")),
        ]

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None

    def touch_last_used(self) -> None:
        self.last_used_at = timezone.now()
        self.save(update_fields=["last_used_at"])

    # Convenience for the mint pathway — the raw token is generated in
    # the service layer, not on the model, so callers can't accidentally
    # log the plaintext by casting a model instance.
    mint_raw: ClassVar = staticmethod(_mint_raw_token)
