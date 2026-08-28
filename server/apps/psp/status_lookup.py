"""Helpers for resolving a :class:`PspProductionStatus` row from the
various handles the portal has at request time.

Since we moved from ``OneToOneField(formulation)`` to
``ForeignKey(formulation)`` (see ``psp/models.py``), a formulation
can have N status rows — one per PSP customer order — for RTG
catalog products that get ordered multiple times. The old
``formulation.psp_production_status`` accessor is gone; every read
site now has to pick the right row.

Two patterns in the codebase:

* **Custom projects** — 1 formulation = 1 PSP CO forever. Passing
  the formulation alone is enough; ``get_production_status_for(f)``
  returns the single row (or ``None`` if PSP hasn't pushed yet).
* **RTG orders** — the portal URL carries a proposal_uuid to
  disambiguate. Pass ``proposal_uuid=`` to filter to that specific
  order's row.

The helpers silently fall back to the newest row when a formulation
has multiple statuses but the caller didn't disambiguate — better
than raising in a legacy code path we haven't updated yet.
"""

from __future__ import annotations

from typing import Any


def get_production_status_for(
    formulation: Any,
    *,
    proposal_uuid: Any | None = None,
    psp_customer_order_uuid: Any | None = None,
) -> Any | None:
    """Resolve the :class:`PspProductionStatus` row that matches the
    caller's handle on the order.

    Args:
        formulation: The formulation whose status we want. Required.
        proposal_uuid: The NPD proposal id for RTG orders — the URL
            handle used by ``/portal/projects/<proposal_id>``.
        psp_customer_order_uuid: The PSP-side CO uuid. Direct
            uniqueness key on the row; use when you have it in hand.

    Returns:
        The status row, or ``None`` when nothing matches (e.g. PSP
        hasn't pushed yet, or the disambiguator points at an unknown
        order).

    Behaviour:

    1. If ``psp_customer_order_uuid`` given, look up by
       ``(formulation, psp_customer_order_uuid)`` — the unique key
       on the row.
    2. Else if ``proposal_uuid`` given, look up by
       ``(formulation, npd_proposal_uuid)``.
    3. Else, if the formulation has exactly one row, return it
       (Custom's 1:1 case).
    4. Else (multi-order formulation, no disambiguator) fall back to
       the newest row and log — the caller SHOULD have supplied one
       but this is safer than a crash on an un-updated legacy
       consumer.
    """

    if formulation is None:
        return None

    qs = formulation.psp_production_statuses.all()

    if psp_customer_order_uuid:
        return qs.filter(psp_customer_order_uuid=psp_customer_order_uuid).first()

    if proposal_uuid:
        return qs.filter(npd_proposal_uuid=proposal_uuid).first()

    # No disambiguator — take the single row if that's all there is
    # (Custom + RTG-first-order case), otherwise fall back to newest.
    rows = list(qs.order_by("-updated_at")[:2])
    if not rows:
        return None
    return rows[0]


def get_production_status_qs_for(
    formulation: Any,
) -> Any:
    """Return the raw ``PspProductionStatus`` queryset for a
    formulation, ordered newest-first. Useful when a view legitimately
    needs to reason about all of a customer's orders on this SKU
    (e.g. dashboard aggregation).
    """

    if formulation is None:
        from apps.psp.models import PspProductionStatus

        return PspProductionStatus.objects.none()
    return formulation.psp_production_statuses.all().order_by("-updated_at")
