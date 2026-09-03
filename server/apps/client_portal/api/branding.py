"""Per-request brand voice for portal API responses.

Two customer-facing portals hit these endpoints:

* **NPD portal** (``vita-cff/client``) — Vita Manufacture brand.
  Calls Django directly from the browser; no proxy in between.
* **web-site portal** (``web-site/src``) — Supplement Manufacture UK
  brand. Calls go through a Next.js Route Handler proxy which
  attaches ``X-Portal-Brand: supplement-manufacture-uk`` on every
  forwarded request (see ``web-site/src/lib/npd/auth-proxy.ts``).

Any string that renders in the browser AND embeds the brand name
must run through :func:`brand_short` / :func:`staff_team_name` so it
lands with the right voice for whichever portal is calling. The
default (no header, unknown origin) keeps the Vita voice — safer
than accidentally rebranding the NPD portal to SMK.
"""

from typing import Any


_SMK_HEADER_VALUE = "supplement-manufacture-uk"


#: Stable string identifiers, used anywhere the brand needs to be
#: persisted (e.g. ``Proposal.brand_key``). Keep in lockstep with the
#: ``BRAND_*`` choices exposed by :class:`apps.proposals.models.ProposalBrand`.
BRAND_KEY_VITA = "vita"
BRAND_KEY_SMK = "supplement_manufacture_uk"


def is_supplement_manufacture_uk(request: Any) -> bool:
    """True when the portal call originated on the Supplement
    Manufacture UK web-site. Detected via the ``X-Portal-Brand``
    header set by the web-site's Next.js proxy layer."""

    if request is None:
        return False
    header = request.META.get("HTTP_X_PORTAL_BRAND", "")
    return (header or "").strip().lower() == _SMK_HEADER_VALUE


def brand_short(request: Any) -> str:
    """The short brand name used inline in narrative copy.

    Examples: "Started by <brand> directly", "Pick <brand>'s team".
    """

    return (
        "Supplement Manufacture UK"
        if is_supplement_manufacture_uk(request)
        else "Vita"
    )


def brand_possessive(request: Any) -> str:
    """Possessive form for phrases like "<brand>'s team". SMK doesn't
    take an apostrophe-s cleanly ("Supplement Manufacture UK's team"
    reads oddly) so the two brands render differently."""

    if is_supplement_manufacture_uk(request):
        # "our team" reads better than "Supplement Manufacture UK's
        # team" — the customer is already on our site and knows who
        # "we" are.
        return "our"
    return "Vita's"


def brand_key(request: Any) -> str:
    """Stable string identifier for the brand — safe to persist on
    a row (e.g. ``Proposal.brand_key``) so the choice made at
    creation time survives future renders even if the header
    detection logic changes."""

    return (
        BRAND_KEY_SMK
        if is_supplement_manufacture_uk(request)
        else BRAND_KEY_VITA
    )


def staff_team_name(request: Any) -> str:
    """Display name for staff-authored portal messages / inbox rows.

    Both brands treat the ops team as a single collective voice — no
    individual operator names leak to the customer — so this doubles
    as both the message-author name and the inbox sender name."""

    return (
        "Supplement Manufacture UK"
        if is_supplement_manufacture_uk(request)
        else "Vita team"
    )
