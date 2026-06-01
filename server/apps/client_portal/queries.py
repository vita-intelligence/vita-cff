"""Shared query helpers for the client portal.

The customer portal asks the same question across half a dozen
views: **"which formulations can THIS customer see?"** The naive
answer — "every Formulation directly anchored to a Proposal owned
by this customer" — misses an important real-world case:

A proposal can bundle multiple projects via its
:class:`apps.proposals.models.ProposalLine` rows. Each line points
at its own :class:`apps.specifications.models.SpecificationSheet`,
and each spec belongs to its own :class:`Formulation`. So one
proposal can legitimately cover N projects, but
``Proposal.formulation_version`` only pins it to ONE — the
"anchor" project. The other projects on the same proposal's lines
have no direct FK back from any Proposal column.

If the portal queries only walk ``Proposal.formulation_version``
those non-anchor projects vanish from the customer's view — they
don't appear in the "Your products" list, the dashboard never
emits an action for them, the per-product detail page 404s on
their formulation id. This module centralises the right answer so
every caller stays in sync.
"""

from __future__ import annotations

from typing import Iterable
from uuid import UUID

from django.db.models import Q

from apps.proposals.models import Proposal


def formulation_ids_for_customer(customer_id) -> set:
    """Return every formulation id this customer can see.

    Union of:

    1. ``Proposal.formulation_version.formulation_id`` — the anchor
       project on each proposal owned by ``customer_id``.
    2. ``ProposalLine.specification_sheet.formulation_version.
       formulation_id`` — every project pulled in via a proposal
       line. Captures multi-project bundles where the proposal is
       anchored on one project but covers others through its
       lines.

    Returns a ``set`` so callers can pass it straight into an
    ``__in`` lookup without worrying about duplicates.
    """

    anchor_ids = Proposal.objects.filter(
        customer_id=customer_id
    ).values_list("formulation_version__formulation_id", flat=True)

    line_ids = Proposal.objects.filter(
        customer_id=customer_id
    ).values_list(
        "lines__specification_sheet__formulation_version__formulation_id",
        flat=True,
    )

    ids: set = set()
    for fid in anchor_ids:
        if fid is not None:
            ids.add(fid)
    for fid in line_ids:
        if fid is not None:
            ids.add(fid)
    return ids


def proposals_covering_formulation(*, customer_id, formulation_id):
    """Return a queryset of every proposal the customer owns that
    covers ``formulation_id`` — whether as the anchor project or
    via any of its lines. Distinct, newest-first.
    """

    return (
        Proposal.objects.filter(customer_id=customer_id)
        .filter(
            Q(formulation_version__formulation_id=formulation_id)
            | Q(
                lines__specification_sheet__formulation_version__formulation_id=formulation_id
            )
        )
        .distinct()
        .order_by("-updated_at")
    )


def customer_owns_formulation(*, customer_id, formulation_id) -> bool:
    """Cheap ownership check — does this customer have at least
    one proposal covering this formulation (anchor or via lines)?
    """

    return proposals_covering_formulation(
        customer_id=customer_id, formulation_id=formulation_id
    ).exists()


def customer_proposals_for_formulations(
    *, customer_id, formulation_ids: Iterable[UUID]
):
    """Return proposals that cover ANY of ``formulation_ids``,
    grouped client-side by the caller. Used by the dashboard's
    "Your products" list to attach proposals back to each project
    row in one trip.
    """

    fids = list(formulation_ids)
    if not fids:
        return Proposal.objects.none()
    return (
        Proposal.objects.filter(customer_id=customer_id)
        .filter(
            Q(formulation_version__formulation_id__in=fids)
            | Q(
                lines__specification_sheet__formulation_version__formulation_id__in=fids
            )
        )
        .distinct()
        .select_related("formulation_version")
        .prefetch_related(
            "lines__specification_sheet__formulation_version"
        )
        .order_by("-updated_at")
    )
