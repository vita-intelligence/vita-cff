"""Parse ``@mention`` tokens out of a comment body.

The body is plain text (markdown-lite, phase 1). Mentions use the
``@email@example.com`` convention — the leading ``@`` is the mention
sigil, the rest is the raw email address of the mentioned member. We
chose email over short handles because:

* Every user in the system has a unique email; we do not yet have a
  display-handle field. Email is the stable primary reference.
* The frontend autocomplete resolves a fuzzy "name / email" query to
  a canonical email before it ever reaches the server, so the wire
  protocol stays dumb and unambiguous.

The parser is intentionally conservative — ambiguity resolves in
favour of "not a mention":

* A bare email inside a comment body ("email me at foo@bar.com") is
  **not** a mention. Only the ``@email`` form triggers one.
* Mentions inside fenced code blocks are ignored — scientists paste
  log snippets and we must not fire off notifications for lines that
  were never meant as chat.
* A trailing punctuation mark on the mention is stripped so
  ``Hi @foo@bar.com,`` recognises ``foo@bar.com`` without the comma.
"""

from __future__ import annotations

import re
from typing import Iterable

from django.contrib.auth import get_user_model


UserModel = get_user_model()


#: Matches the ``@<email>`` form. The address itself is the standard
#: RFC-5322 permissive regex trimmed to the shape the catalogue uses
#: (no quoted locals, no IP literals). Exact validation is handled by
#: Django's :class:`EmailField` on the ``User.email`` column — the
#: regex here only needs to *extract candidates*.
_MENTION_PATTERN = re.compile(
    r"(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})"
)

#: Fenced code block stripper. Removes ``` … ``` spans (including the
#: language tag on the opening fence) before mention extraction so
#: pasted log output does not trigger notifications.
_FENCED_CODE_PATTERN = re.compile(r"```.*?```", re.DOTALL)

#: Inline backtick span. Used for the ``@foo`` form appearing inside a
#: single-line code span; same rationale as fenced blocks.
_INLINE_CODE_PATTERN = re.compile(r"`[^`]*`")

#: Trailing punctuation we strip off a mention candidate before we
#: validate it. A mention is an email; anything after the final TLD
#: character that matches one of these is definitely not part of the
#: address.
_TRAILING_PUNCT = ".,;:!?)]}>\"'"


def extract_mention_emails(body: str) -> list[str]:
    """Return the distinct, lower-cased emails mentioned in ``body``.

    Returns at most one entry per distinct email — if a scientist
    ``@mentions`` the same person three times in one comment they
    still receive one notification. Order preserves first occurrence
    so the read-path serialisers render mentions in the order they
    appear in the body.
    """

    if not body:
        return []

    cleaned = _FENCED_CODE_PATTERN.sub(" ", body)
    cleaned = _INLINE_CODE_PATTERN.sub(" ", cleaned)

    seen: set[str] = set()
    result: list[str] = []
    for match in _MENTION_PATTERN.findall(cleaned):
        email = match.rstrip(_TRAILING_PUNCT).lower()
        if not email or email in seen:
            continue
        seen.add(email)
        result.append(email)
    return result


def resolve_mentions(
    body: str,
    *,
    organization_id,
    author_id=None,
) -> list:
    """Turn ``body`` mentions into the set of :class:`User` rows they
    reference within the caller's org.

    Only emails that belong to an **active** member of
    ``organization_id`` are returned — a mention targeting someone
    outside the workspace is silently dropped rather than raising so
    the writer gets a successful post even if they misspelled a
    colleague's address. The author mentioning themselves is also
    dropped here so no self-notification ever reaches the email
    dispatcher.
    """

    emails = extract_mention_emails(body)
    if not emails:
        return []

    # Django does not ship an ``__iexact_in``. Normalise the candidate
    # emails to lower-case (already done by :func:`extract_mention_
    # emails`) and build an ``OR`` of case-insensitive equality checks
    # — the ``User.email`` column is saved as the user registered it,
    # so we need a case-insensitive match to avoid missing a mention
    # for ``Foo@Bar.com`` when the DB row is ``foo@bar.com``.
    from django.db.models import Q

    q = Q()
    for email in emails:
        q |= Q(email__iexact=email)

    queryset = (
        UserModel.objects.filter(q, is_active=True)
        .filter(memberships__organization_id=organization_id)
    )
    if author_id is not None:
        queryset = queryset.exclude(id=author_id)

    # Preserve the body-order of mentions: map email → User, then
    # iterate ``emails`` in their original order.
    by_email = {user.email.lower(): user for user in queryset}
    return [by_email[email] for email in emails if email in by_email]
