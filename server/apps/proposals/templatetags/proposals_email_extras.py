"""Template filters used only by the proposal email HTML templates."""

from __future__ import annotations

from django import template
from django.utils.html import escape
from django.utils.safestring import mark_safe


register = template.Library()


@register.filter(name="email_linebreaks")
def email_linebreaks(value: str) -> str:
    """Render a plain-text email body as inline-styled HTML paragraphs.

    Django's built-in ``linebreaks`` filter wraps paragraphs in
    ``<p>`` and converts single newlines to ``<br>`` — same idea here,
    but with inline ``style`` attributes so the output renders the
    same in Gmail / Outlook / Apple Mail without needing any CSS in
    the surrounding template. Email clients strip ``<style>`` blocks
    aggressively and inline styles are the only portable styling.

    Empty input returns an empty string so the template can skip the
    section entirely on a blank body.
    """

    if not value:
        return ""

    # Split on blank lines (paragraphs); each paragraph keeps its
    # single newlines as ``<br>``s so a list-style enumeration the
    # sales person typed stays visually separated.
    paragraphs = [p.strip() for p in value.replace("\r\n", "\n").split("\n\n")]
    rendered = []
    for paragraph in paragraphs:
        if not paragraph:
            continue
        escaped = escape(paragraph).replace("\n", "<br/>")
        rendered.append(
            f'<p style="margin:0 0 14px 0;line-height:1.6;">{escaped}</p>'
        )
    return mark_safe("\n".join(rendered))
