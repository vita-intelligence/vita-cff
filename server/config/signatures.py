"""Shared validation helper for captured signature images.

Signatures are stored as base64-encoded PNG data URLs — the string the
HTML canvas's ``toDataURL('image/png')`` returns. Keeping them as
text in the DB avoids a file-storage dependency, and the payloads are
small (a typical freehand signature is under 15 KB).

The validator enforces three things so a stray payload cannot blow
out the DB or embed arbitrary blob types:

1. Must be a non-empty string.
2. Must be a ``data:image/png;base64,...`` URL (other mime types are
   rejected — a scientist drawing with the canvas can only produce
   PNG).
3. Must stay under a conservative byte cap so nobody can paste a
   megapixel full-colour photograph and bloat the table.

Callers receive ``SignatureImageInvalid`` on failure; the API layer
translates that into a 400 with the ``invalid_signature_image``
error code.
"""

from __future__ import annotations


class SignatureImageInvalid(Exception):
    """Raised when a posted signature image fails validation."""

    code = "invalid_signature_image"


#: Hard cap on the raw data-URL size. 200 KB is ~3× the size of a
#: typical 600×200 black-ink signature PNG, enough headroom for a
#: high-DPI retina capture without allowing a photograph.
MAX_SIGNATURE_BYTES = 200_000

_PREFIX = "data:image/png;base64,"


def validate_signature_image(value: object) -> str:
    """Return the normalised signature string or raise on invalid input.

    Normalisation is minimal: we strip surrounding whitespace, require
    the PNG data-URL prefix, and enforce the byte cap on the full
    string (the base-64 payload is a subset of the string).
    """

    if not isinstance(value, str):
        raise SignatureImageInvalid()
    stripped = value.strip()
    if not stripped:
        raise SignatureImageInvalid()
    if not stripped.startswith(_PREFIX):
        raise SignatureImageInvalid()
    if len(stripped) > MAX_SIGNATURE_BYTES:
        raise SignatureImageInvalid()
    # The payload itself must be non-empty — a prefix-only string
    # would pass the length check but represent no signature at all.
    if len(stripped) == len(_PREFIX):
        raise SignatureImageInvalid()
    return stripped
