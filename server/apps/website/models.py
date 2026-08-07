"""Website-facing access tokens.

Machine-to-machine bearer tokens the marketing website (``web-site``)
presents when calling NPD's ``/api/website/*`` surface — currently
just the published RTG catalogue read. Mirrors
:class:`apps.psp.models.PspAccessToken` exactly, kept as its own
model so the two integration surfaces stay independently revocable
and auditable — a website-token rotation shouldn't disturb the PSP
side and vice versa.

Design (same as PSP):

* ``token_hash`` — bcrypt hash of the raw token. The plaintext leaves
  the boundary exactly once on ``mint_website_access_token`` and is
  never persisted or returned by any subsequent endpoint.
* ``token_prefix`` — first few chars of the raw token, stored
  plaintext for display so admins can distinguish tokens on the
  settings page without decrypting anything.
* ``revoked_at`` / ``revoked_by`` — soft-delete. The row stays in
  the table so historical audit references keep resolving.
* Per-organization scoping — the website only ever sees rows tagged
  to the token's organization.
"""

from __future__ import annotations

import secrets
import uuid
from typing import ClassVar

from django.conf import settings
from django.db import models
from django.utils import timezone


#: Length (bytes) of the random seed we hex-encode into a token.
#: 32 bytes → 64 hex chars, same convention as PspAccessToken.
_TOKEN_ENTROPY_BYTES: int = 32

#: How many leading chars of the raw token we retain as a prefix
#: for display. Enough to disambiguate tokens without leaking enough
#: entropy to compromise the secret.
TOKEN_PREFIX_LENGTH: int = 8


def _mint_raw_token() -> str:
    """Generate a fresh opaque bearer string. Hex-encoded so it
    survives copy/paste through terminals, emails, environment-file
    editors, etc. without newline / whitespace mangling."""

    return secrets.token_hex(_TOKEN_ENTROPY_BYTES)


class WebsiteAccessToken(models.Model):
    """One website-facing access token.

    Created by an admin via ``/settings/integrations`` on NPD;
    pasted into the marketing website's ``NPD_WEBSITE_TOKEN`` env
    var. The website then presents it as
    ``Authorization: Bearer <raw>`` on every call to NPD's
    ``/api/website/*`` endpoints.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="website_access_tokens",
    )

    #: Human-readable name so admins can tell tokens apart on the
    #: settings page ("Production", "Staging", "Preview branch").
    #: Unique per org so a fresh mint can't silently collide with
    #: an existing entry.
    name = models.CharField(max_length=100)

    #: bcrypt hash of the raw token. Django's ``make_password`` +
    #: ``check_password`` handle the format.
    token_hash = models.CharField(max_length=255)

    #: First TOKEN_PREFIX_LENGTH chars of the raw token. Rendered
    #: verbatim on the settings page so admins can tell "6d3f… (prod)"
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
                name="website_access_token_unique_name_per_org",
            ),
        ]
        indexes = [
            #: Verify path scans by prefix across active rows for the
            #: org — index on ``(revoked_at, token_prefix)`` keeps
            #: that cheap even with many revoked rows sticking around.
            models.Index(fields=("revoked_at", "token_prefix")),
        ]

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None

    def touch_last_used(self) -> None:
        self.last_used_at = timezone.now()
        self.save(update_fields=["last_used_at"])

    # Convenience for the mint pathway — the raw token is generated
    # in the service layer, not on the model, so callers can't
    # accidentally log the plaintext by casting a model instance.
    mint_raw: ClassVar = staticmethod(_mint_raw_token)
