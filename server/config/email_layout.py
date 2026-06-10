"""Shared email layout helper.

Every transactional email in vita-cff renders through this module so
the wrapper HTML, brand strip, footer, and Outlook-safe markup live in
exactly one place. The base template (``templates/email/base.html``) is
a bulletproof table layout with MSO conditionals + bgcolor attributes
so the same source produces ≥96% supported rendering across the
caniemail-tracked clients (Mailpit's html-check yardstick).

Two callers:

* **Inline senders** (e.g. :mod:`apps.client_portal.email`) call
  :func:`render_email` directly, passing the dynamic fields, and get
  back a ``(html, text)`` pair ready for ``EmailMultiAlternatives``.
* **Template-based senders** (e.g. ``proposals/email/send_to_client.html``)
  use ``{% extends "email/base.html" %}`` and fill the blocks
  (``heading``, ``intro``, ``cta_block``, ``body``, ``footer``). The
  Python helper is only one of two entry points into the same shell.

Why not CSS classes or a `<style>` block? Because broad email-client
support (notably Outlook 2007–2019, which renders mail through Word)
ignores stylesheets that aren't inlined. Every visible element here
carries inline styles AND attribute fallbacks (``bgcolor``, ``width``,
``align``) so the markup survives both Outlook's CSS strip and modern
webmail's stylesheet sandboxing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from django.template.loader import render_to_string


@dataclass(frozen=True)
class EmailCTA:
    """Primary call-to-action button.

    Renders as a VML rectangle in Outlook and a styled anchor
    elsewhere. ``label`` is shown inside the button; ``url`` is the
    target. Both are mandatory — the button is the customer's one
    next step in most of our emails (open portal, reset password,
    review proposal).
    """

    label: str
    url: str


@dataclass(frozen=True)
class EmailCode:
    """One-time verification code (the OTP emails).

    ``code`` is the digits the customer must type back. We render it
    inside a bordered box, with single spaces between each digit so
    legibility doesn't depend on CSS ``letter-spacing`` (partial in
    Outlook). The plain-text version emits the bare ``code`` so the
    customer can copy without the spaces.
    """

    code: str

    @property
    def formatted(self) -> str:
        """Return the digits separated by a hair-space-like single
        space — readable in inboxes that strip CSS ``letter-spacing``
        without breaking copy-paste (the receiving end still parses
        a contiguous string after we strip whitespace)."""

        return " ".join(self.code)


def render_email(
    *,
    subject: str,
    preheader: str = "",
    heading: str,
    intro_html: str,
    body_html: str = "",
    cta: Optional[EmailCTA] = None,
    code: Optional[EmailCode] = None,
    outro: str = "",
    footer_html: str = "&mdash; Vita Manufacture",
) -> tuple[str, str]:
    """Render one transactional email through ``email/base.html``.

    Returns ``(html, text)`` — the HTML for the rich alternative and a
    plain-text fallback for clients that prefer (or are forced to)
    text-only mode. The text version is derived from the same inputs
    rather than rendered from a separate template so the two halves of
    the multipart message can never drift.

    ``intro_html`` and ``body_html`` are passed through verbatim — they
    must be Outlook-safe (table-based, no CSS shorthand, no
    inline-block) when the caller hand-rolls them. Use the
    :class:`EmailCTA` and :class:`EmailCode` helpers for the two pieces
    of chrome we know are sensitive (buttons, code boxes) so a sender
    can't accidentally regress them.
    """

    cta_block = ""
    if cta is not None:
        cta_block = render_to_string(
            "email/_cta_button.html",
            {"cta_url": cta.url, "cta_label": cta.label},
        )

    code_block = ""
    if code is not None:
        code_block = render_to_string(
            "email/_code_box.html",
            {"code_display": code.formatted},
        )

    html = render_to_string(
        "email/_shell.html",
        {
            "subject": subject,
            "preheader": preheader,
            "heading": heading,
            "intro_html": intro_html,
            "body_html": body_html,
            "cta_block": cta_block,
            "code_block": code_block,
            "outro": outro,
            "footer_html": footer_html,
        },
    )

    text_lines: list[str] = []
    if heading:
        text_lines.append(heading)
        text_lines.append("")
    # ``intro_html`` and ``body_html`` are HTML — strip tags for the
    # plain-text version. A lazy but adequate stripper is fine here
    # because we author the HTML on the sending side; we don't try to
    # parse arbitrary input.
    text_lines.append(_strip_tags(intro_html))
    if code is not None:
        text_lines.append("")
        text_lines.append(f"  {code.code}")
    if cta is not None:
        text_lines.append("")
        text_lines.append(f"{cta.label}: {cta.url}")
    if body_html:
        text_lines.append("")
        text_lines.append(_strip_tags(body_html))
    if outro:
        text_lines.append("")
        text_lines.append(outro)
    text_lines.append("")
    text_lines.append(_strip_tags(footer_html))
    text_lines.append("")

    return html, "\n".join(text_lines)


def _strip_tags(html: str) -> str:
    """Minimal HTML→text stripper.

    We control the HTML that flows through here (helpers in this module
    or hand-rolled by trusted senders) so we don't need a real parser.
    Replace ``<br>`` with newlines, collapse other tags, and decode the
    handful of entities we actually emit (``&mdash;`` / ``&nbsp;``).
    """

    import re

    text = re.sub(r"<\s*br\s*/?\s*>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</\s*p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = (
        text.replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    # Collapse runs of blank lines so the plain-text rendering doesn't
    # look mangled when the HTML happened to nest several block
    # elements.
    return re.sub(r"\n{3,}", "\n\n", text).strip()


__all__ = [
    "EmailCTA",
    "EmailCode",
    "render_email",
]
