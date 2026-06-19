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

**Duplicate-customer survivability.** Some orgs carry duplicate
:class:`apps.customers.models.Customer` rows that share an email
(historical Dataverse imports + the early portal self-registration
flow had paths that could land a second row before the auto-merge
guard existed). Every helper here takes a list of customer ids
rather than a single ``customer_id`` so the read path naturally
unions across duplicates — a customer whose ``ClientAccount``
points at one row still sees proposals attached to any sibling
row sharing the same email. :func:`customer_ids_for_account`
computes that set once per request.
"""

from __future__ import annotations

from typing import Iterable, Sequence
from uuid import UUID

from django.db.models import Q

from apps.customers.models import Customer
from apps.proposals.models import Proposal


def customer_ids_for_account(account) -> list:
    """Return every Customer id the portal session should read from.

    Always includes ``account.customer_id`` (the row the login row
    is FK'd to) as the floor — if anything below blanks out, the
    caller still sees the same data they saw before this helper
    existed. Then unions in every other Customer row in the SAME
    organization sharing the account's email (case-insensitive).

    Why both: ``ClientAccount.customer_id`` is a single FK by
    schema; duplicate rows that share an email but were created
    before the auto-merger landed only see their proposals if we
    look them up by email here too. This is the "survives existing
    dupes" guard. Once Phase 4's sweep merges every (org, email)
    cluster, this helper collapses to a single id in practice.

    Always scopes by ``organization`` — never returns a Customer
    id from a different tenant, even if two distinct orgs happen
    to use the same generic email (info@…, hello@…). The portal
    surface is single-org per request, so any cross-org leak here
    would be a data-isolation bug.
    """

    canonical_id = getattr(account, "customer_id", None)
    if canonical_id is None:
        return []

    # The account row anchors the org we read from. Walking through
    # ``account.customer.organization_id`` would pay an extra fetch
    # on every request — pin the org once via the canonical Customer.
    canonical = (
        Customer.objects
        .filter(pk=canonical_id)
        .only("id", "organization_id")
        .first()
    )
    if canonical is None:
        return []

    email = (getattr(account, "email", "") or "").strip()
    if not email:
        return [canonical_id]

    sibling_ids = list(
        Customer.objects
        .filter(
            organization_id=canonical.organization_id,
            email__iexact=email,
        )
        .exclude(pk=canonical_id)
        .values_list("id", flat=True)
    )
    return [canonical_id, *sibling_ids]


def formulation_ids_for_customer(customer_ids: Iterable[UUID]) -> set:
    """Return every formulation id the customer rows can see.

    Union of:

    1. ``Proposal.formulation_version.formulation_id`` — the anchor
       project on each proposal owned by any of ``customer_ids``.
    2. ``ProposalLine.specification_sheet.formulation_version.
       formulation_id`` — every project pulled in via a proposal
       line. Captures multi-project bundles where the proposal is
       anchored on one project but covers others through its
       lines.

    Returns a ``set`` so callers can pass it straight into an
    ``__in`` lookup without worrying about duplicates.
    """

    ids_list = list(customer_ids)
    if not ids_list:
        return set()

    anchor_ids = Proposal.objects.filter(
        customer_id__in=ids_list,
    ).values_list("formulation_version__formulation_id", flat=True)

    line_ids = Proposal.objects.filter(
        customer_id__in=ids_list,
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


def proposals_covering_formulation(
    *, customer_ids: Iterable[UUID], formulation_id,
):
    """Return a queryset of every proposal across ``customer_ids``
    that covers ``formulation_id`` — whether as the anchor project
    or via any of its lines. Distinct, newest-first.
    """

    ids_list = list(customer_ids)
    if not ids_list:
        return Proposal.objects.none()
    return (
        Proposal.objects.filter(customer_id__in=ids_list)
        .filter(
            Q(formulation_version__formulation_id=formulation_id)
            | Q(
                lines__specification_sheet__formulation_version__formulation_id=formulation_id
            )
        )
        .distinct()
        .order_by("-updated_at")
    )


def customer_owns_formulation(
    *, customer_ids: Iterable[UUID], formulation_id,
) -> bool:
    """Cheap ownership check — do any of the customer rows have at
    least one proposal covering this formulation (anchor or via lines)?
    """

    return proposals_covering_formulation(
        customer_ids=customer_ids, formulation_id=formulation_id,
    ).exists()


def customer_proposals_for_formulations(
    *, customer_ids: Iterable[UUID], formulation_ids: Iterable[UUID],
):
    """Return proposals across ``customer_ids`` that cover ANY of
    ``formulation_ids``, grouped client-side by the caller. Used by
    the dashboard's "Your products" list to attach proposals back
    to each project row in one trip.
    """

    cids = list(customer_ids)
    fids = list(formulation_ids)
    if not cids or not fids:
        return Proposal.objects.none()
    return (
        Proposal.objects.filter(customer_id__in=cids)
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
