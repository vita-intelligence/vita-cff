"""Validation helper for uploaded avatar image data URLs.

Avatars ride through the API as base64-encoded PNG or JPEG data URLs
captured by the client after a canvas / cropper reduces the source
image to a small thumbnail. Storing the string in the DB keeps the
deployment free of media-storage plumbing — when we migrate to blob
storage the column type changes and every consumer that currently
treats ``avatar_image`` as an opaque URL continues to work.

The validator is stricter than :mod:`config.signatures`:

* Accepts both PNG and JPEG (crop UIs default to JPEG for photos).
* Larger size cap (500 KB) so a reasonably-compressed headshot fits
  without bumping into the guardrail, while still rejecting
  uncompressed multi-megapixel photos.
"""

from __future__ import annotations


class AvatarImageInvalid(Exception):
    """Raised when a posted avatar fails validation."""

    code = "invalid_avatar_image"


MAX_AVATAR_BYTES = 500_000
_ALLOWED_PREFIXES = (
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
)


def validate_avatar_image(value: object) -> str:
    """Return the normalised avatar data URL or raise on invalid input."""

    if not isinstance(value, str):
        raise AvatarImageInvalid()
    stripped = value.strip()
    if not stripped:
        raise AvatarImageInvalid()
    prefix_match = next(
        (p for p in _ALLOWED_PREFIXES if stripped.startswith(p)), None
    )
    if prefix_match is None:
        raise AvatarImageInvalid()
    if len(stripped) > MAX_AVATAR_BYTES:
        raise AvatarImageInvalid()
    # Guard against a prefix-only string with no payload.
    if len(stripped) == len(prefix_match):
        raise AvatarImageInvalid()
    return stripped
