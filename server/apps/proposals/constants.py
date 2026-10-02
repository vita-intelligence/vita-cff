"""Shared constants for the proposals domain.

Keep enums that cross the API boundary here so Python + TypeScript
mirror from one place. If you add a key, add the matching entry to
``client/src/services/proposals/rejection-categories.ts`` so the
two surfaces stay aligned.
"""

#: Structured rejection categories a customer can tick when
#: declining a proposal on the portal. Multi-select by design — a
#: customer declining a quote often has more than one objection
#: (e.g. "too expensive" AND "lead time too long"). Required on the
#: portal reject flow (at least one must be ticked); the free-text
#: reason stays optional.
#:
#: Scoped to supplement contract manufacturing. Add categories here
#: when a repeat free-text pattern emerges — don't let scientists
#: or operators pick from a different list.
PROPOSAL_REJECTION_CATEGORIES: tuple[tuple[str, str], ...] = (
    ("price", "Price is too high"),
    ("moq", "Minimum order quantity doesn't work"),
    ("lead_time", "Lead time is too long"),
    ("formulation", "Want to change the formulation"),
    ("packaging", "Need different packaging options"),
    ("payment_terms", "Payment terms don't work"),
    ("certifications", "Missing certifications we need"),
    ("logistics", "Shipping / logistics issue"),
    ("timing", "Not ready to commit right now"),
    ("other_supplier", "Going with another manufacturer"),
    ("other", "Something else"),
)

PROPOSAL_REJECTION_CATEGORY_KEYS: frozenset[str] = frozenset(
    key for key, _label in PROPOSAL_REJECTION_CATEGORIES
)


def rejection_category_label(key: str) -> str:
    """Return the display label for a category key, or the key
    itself when the registry doesn't recognise it (defensive — a
    legacy row might carry a key we've since renamed)."""

    for registered_key, label in PROPOSAL_REJECTION_CATEGORIES:
        if registered_key == key:
            return label
    return key
