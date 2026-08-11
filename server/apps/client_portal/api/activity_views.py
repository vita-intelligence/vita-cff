"""Unified portal activity feed.

``GET /api/portal/activity/`` — one endpoint that returns every
customer-facing thing the caller has in flight, normalized into a
single card shape. Powers the marketing-site portal hub (the
``/portal`` landing page on the web-site repo) which lists
Custom projects, RTG proposals, and paid sample requests side-by-
side under one filter/search/pagination surface.

Contract (query params):

* ``kind`` — ``all|project|rtg|sample``, default ``all``.
* ``q`` — free-text search, matches code / title (case-insensitive).
* ``limit`` — page size, default 20, max 100.
* ``offset`` — page start, default 0. Hard cap ``offset + limit <=
  500`` — beyond that the FE should push the user to filter/search
  instead of paging, since the per-kind fetch cost grows linearly
  and a scan-then-merge past 500 rows is a footgun.

Response shape:

.. code-block:: json

   {
     "items": [ { … normalized item … } ],
     "next_offset": 20 | null,
     "total": 42,
     "counts": {"all": 42, "project": 5, "rtg": 30, "sample": 7}
   }

Where each item is::

    {
      "kind": "project" | "rtg" | "sample",
      "id": "<uuid>",
      "code": "MA22222" | "PROP-0011" | "…",
      "title": "Ultimate Fat Burner Drink",
      "subtitle": "Bottle 60ct · 3000 units",
      "status_key": "draft" | "sent" | "in_development" | …,
      "status_label": "Awaiting your signature",
      "status_tone": "attention" | "in_progress" | "success"
                     | "muted" | "danger",
      "href": "/portal/projects/<id>" | "/portal/orders/<id>",
      "amount": "77370.00" | null,
      "currency": "GBP",
      "quantity": 3000 | null,
      "updated_at": "2026-08-11T06:20:00Z",
      "needs_attention": true | false
    }

Aggregation strategy: fetch up to ``offset + limit`` rows of each
kind (capped at 500 across the request), merge in Python, sort by
``updated_at`` desc, slice. This is fine for hundreds of items per
kind — a customer with tens of thousands of RTG orders will need
either cursor pagination or a materialised activity table; both
are follow-ups called out in the module docstring on purpose.

Ownership traversal reuses :func:`client_portal.queries
.customer_ids_for_account` so duplicate ``Customer`` rows sharing
an email all contribute to the same feed (matches the dashboard's
"survives dupes" behaviour).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable

from django.db.models import Q
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import (
    customer_ids_for_account,
    formulation_ids_for_customer,
)
from apps.formulations.models import Formulation, ProjectStatus
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.proposals.models import Proposal, ProposalStatus, ProposalTemplateType


DEFAULT_LIMIT = 20
MAX_LIMIT = 100
#: Hard ceiling on offset+limit so the merge-in-python step doesn't
#: fan out unbounded on customers with tens of thousands of rows.
#: Past this ceiling the FE surfaces a "narrow with filters/search"
#: hint instead of continuing to page.
PAGE_HARD_CAP = 500


class PortalActivityView(PortalAPIView):
    """GET the caller's unified activity feed. See module docstring."""

    def get(self, request: Request) -> Response:
        kind = _normalize_kind(request.query_params.get("kind"))
        search = (request.query_params.get("q") or "").strip()
        limit, offset, ceiling_error = _parse_paging(request)
        if ceiling_error is not None:
            return ceiling_error

        customer_ids = customer_ids_for_account(request.user)
        if not customer_ids:
            return Response(
                {
                    "items": [],
                    "next_offset": None,
                    "total": 0,
                    "counts": {"all": 0, "project": 0, "rtg": 0, "sample": 0},
                }
            )

        # Per-kind counts drive the tab badges. Cheap COUNT queries
        # even at scale; whether the current search / active kind is
        # applied is a UX call — we scope counts to ``q`` so a search
        # that empties a bucket shows a "(0)" on that tab instead of
        # a stale "42".
        counts = _compute_counts(customer_ids, search)

        # Cap the per-kind fetch so a customer with millions of RTG
        # rows doesn't stream them all into memory on page 1. We
        # over-fetch by ``limit`` per kind so the merged order is
        # stable across pages (the last item on page N is greater
        # than the first item on page N+1 after sort).
        per_kind_cap = min(offset + limit, PAGE_HARD_CAP)

        items: list[dict] = []
        if kind in ("all", "project"):
            items.extend(_collect_projects(customer_ids, search, per_kind_cap))
        if kind in ("all", "rtg"):
            items.extend(_collect_rtg(customer_ids, search, per_kind_cap))
        if kind in ("all", "sample"):
            items.extend(_collect_samples(customer_ids, search, per_kind_cap))

        items.sort(key=_sort_key, reverse=True)
        total = len(items)
        page = items[offset : offset + limit]
        next_offset = (
            offset + limit if (offset + limit) < total and offset + limit < PAGE_HARD_CAP
            else None
        )

        return Response(
            {
                "items": [_serialize_item(item) for item in page],
                "next_offset": next_offset,
                "total": total,
                "counts": counts,
            }
        )


# ---------------------------------------------------------------------------
# Paging + query helpers
# ---------------------------------------------------------------------------


def _normalize_kind(raw: str | None) -> str:
    """Coerce ``kind`` query param to a known value; unknowns fall
    through to ``all`` rather than 400 so a stale FE build doesn't
    hard-fail on a typo."""

    value = (raw or "all").lower().strip()
    return value if value in ("all", "project", "rtg", "sample") else "all"


def _parse_paging(request: Request) -> tuple[int, int, Response | None]:
    """Read + validate ``limit`` / ``offset``.

    Returns ``(limit, offset, error_response_or_None)``. A non-None
    error is a fully-formed 400 the view can return unchanged.
    """

    try:
        limit = int(request.query_params.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT
    limit = max(1, min(MAX_LIMIT, limit))

    try:
        offset = int(request.query_params.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)

    if offset + limit > PAGE_HARD_CAP:
        return (
            limit,
            offset,
            Response(
                {
                    "detail": "offset_out_of_range",
                    "message": (
                        "Please refine with a filter or search — this feed "
                        "only pages the first "
                        f"{PAGE_HARD_CAP} items."
                    ),
                },
                status=status.HTTP_400_BAD_REQUEST,
            ),
        )

    return limit, offset, None


# ---------------------------------------------------------------------------
# Kind counts — tab badges
# ---------------------------------------------------------------------------


def _compute_counts(customer_ids: list, search: str) -> dict[str, int]:
    """Cheap per-kind COUNT queries for the tab strip. Scoped by
    ``search`` so an empty search shows the true total per kind
    but a narrowing query updates the badges too."""

    project_qs = _projects_queryset(customer_ids, search)
    rtg_qs = _rtg_queryset(customer_ids, search)
    sample_qs = _samples_queryset(customer_ids, search)

    project_count = project_qs.count()
    rtg_count = rtg_qs.count()
    sample_count = sample_qs.count()

    return {
        "all": project_count + rtg_count + sample_count,
        "project": project_count,
        "rtg": rtg_count,
        "sample": sample_count,
    }


# ---------------------------------------------------------------------------
# Custom project rows
# ---------------------------------------------------------------------------


#: Human-readable status labels + tones for Formulation.project_status.
#: The dashboard endpoint has its own richer stage resolver (walks
#: proposal / spec / label state) — for the activity feed we settle
#: for the top-level project_status. Detail navigation to the project
#: page carries the full story.
_PROJECT_STATUS_MAP: dict[str, tuple[str, str, bool]] = {
    # status_key: (label, tone, needs_attention)
    ProjectStatus.CONCEPT: ("Concept", "in_progress", False),
    ProjectStatus.IN_DEVELOPMENT: ("In development", "in_progress", False),
    ProjectStatus.PILOT: ("Pilot batches", "in_progress", False),
    ProjectStatus.APPROVED: ("Approved", "success", False),
    ProjectStatus.DISCONTINUED: ("Discontinued", "muted", False),
}


def _projects_queryset(customer_ids: list, search: str):
    """Custom Formulations visible to the customer."""

    formulation_ids = formulation_ids_for_customer(customer_ids)
    if not formulation_ids:
        return Formulation.objects.none()
    qs = Formulation.objects.filter(
        id__in=formulation_ids,
        project_type="custom",
    ).select_related()
    if search:
        qs = qs.filter(Q(code__icontains=search) | Q(name__icontains=search))
    return qs


def _collect_projects(customer_ids: list, search: str, cap: int) -> list[dict]:
    rows = list(_projects_queryset(customer_ids, search).order_by("-updated_at")[:cap])
    items: list[dict] = []
    for row in rows:
        status_label, tone, needs = _PROJECT_STATUS_MAP.get(
            row.project_status, ("In progress", "in_progress", False),
        )
        items.append(
            {
                "kind": "project",
                "id": str(row.id),
                "code": row.code or "",
                "title": row.name or row.code or "Untitled project",
                "subtitle": "Custom formulation",
                "status_key": row.project_status,
                "status_label": status_label,
                "status_tone": tone,
                "href": f"/portal/projects/{row.id}",
                "amount": None,
                "currency": "",
                "quantity": None,
                "updated_at": row.updated_at,
                "needs_attention": needs,
            }
        )
    return items


# ---------------------------------------------------------------------------
# RTG proposal rows (storefront cart orders)
# ---------------------------------------------------------------------------


#: RTG proposal status → (label, tone, needs_attention). Only
#: proposals in ``sent`` demand a signature from the customer — the
#: rest are informational from the customer's angle. ``draft`` reads
#: as "we're drafting your quote" because portal-created quotes stay
#: in DRAFT until sales hits Send.
_RTG_STATUS_MAP: dict[str, tuple[str, str, bool]] = {
    ProposalStatus.DRAFT: ("We're drafting your quote", "in_progress", False),
    ProposalStatus.IN_REVIEW: ("Under review", "in_progress", False),
    ProposalStatus.APPROVED: ("Quote approved — awaiting send", "in_progress", False),
    ProposalStatus.SENT: ("Awaiting your signature", "attention", True),
    ProposalStatus.ACCEPTED: ("Signed", "success", False),
    ProposalStatus.REJECTED: ("Declined", "danger", False),
}


def _rtg_queryset(customer_ids: list, search: str):
    qs = Proposal.objects.filter(
        customer_id__in=customer_ids,
        template_type=ProposalTemplateType.READY_TO_GO,
    ).select_related("formulation_version__formulation")
    if search:
        qs = qs.filter(
            Q(code__icontains=search)
            | Q(formulation_version__formulation__name__icontains=search)
            | Q(formulation_version__formulation__rtg_display_name__icontains=search)
            | Q(formulation_version__formulation__code__icontains=search)
        )
    return qs


def _collect_rtg(customer_ids: list, search: str, cap: int) -> list[dict]:
    rows = list(_rtg_queryset(customer_ids, search).order_by("-updated_at")[:cap])
    items: list[dict] = []
    for row in rows:
        formulation = getattr(row.formulation_version, "formulation", None)
        title = _formulation_display_name(formulation) or row.code or "Order"
        status_label, tone, needs = _RTG_STATUS_MAP.get(
            row.status, ("In flight", "in_progress", False),
        )
        items.append(
            {
                "kind": "rtg",
                "id": str(row.id),
                "code": row.code or "",
                "title": title,
                "subtitle": _rtg_subtitle(row, formulation),
                "status_key": row.status,
                "status_label": status_label,
                "status_tone": tone,
                "href": f"/portal/orders/{row.id}",
                "amount": _decimal_str(_rtg_total(row)),
                "currency": row.currency or "GBP",
                "quantity": row.quantity,
                "updated_at": row.updated_at,
                "needs_attention": needs,
            }
        )
    return items


def _rtg_subtitle(proposal: Proposal, formulation: Any) -> str:
    """One-liner under the RTG title — qty + code for scan."""

    parts: list[str] = []
    if proposal.quantity:
        parts.append(f"{proposal.quantity:,} units")
    code = getattr(formulation, "code", "") or ""
    if code and code != proposal.code:
        parts.append(code)
    return " · ".join(parts) if parts else "Ready-to-Go order"


def _rtg_total(proposal: Proposal) -> Decimal | None:
    total = getattr(proposal, "total_excl_vat", None) or getattr(
        proposal, "subtotal", None
    )
    if total is None:
        return None
    try:
        return Decimal(total)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Sample payment rows (storefront paid samples)
# ---------------------------------------------------------------------------


#: Sample payment status → (label, tone, needs_attention). Samples
#: are always customer-initiated so "needs_attention" is finance-
#: side; from the customer's angle every state is informational.
_SAMPLE_STATUS_MAP: dict[str, tuple[str, str, bool]] = {
    PaymentStatus.PENDING: ("Awaiting confirmation", "in_progress", False),
    PaymentStatus.APPROVED: ("Confirmed — kit shipping soon", "success", False),
    PaymentStatus.VOIDED: ("Cancelled", "danger", False),
}


def _samples_queryset(customer_ids: list, search: str):
    """Payments the customer sees as sample-kit orders.

    Storefront sample checkouts (see :func:`apps.client_portal
    .checkout_services._create_sample_payment`) create Payment rows
    with ``kind=FINAL`` against an RTG-tagged formulation. That
    combination is the semantic signal — Custom projects' FINAL
    payments run against ``project_type=custom`` formulations, so
    the RTG filter cleanly separates the two flows without a
    ``source`` column.
    """

    qs = Payment.objects.filter(
        customer_id__in=customer_ids,
        kind=PaymentKind.FINAL,
        formulation__project_type="ready_to_go",
    ).select_related("formulation")
    if search:
        qs = qs.filter(
            Q(formulation__name__icontains=search)
            | Q(formulation__rtg_display_name__icontains=search)
            | Q(formulation__code__icontains=search)
            | Q(external_reference__icontains=search)
        )
    return qs


def _collect_samples(customer_ids: list, search: str, cap: int) -> list[dict]:
    rows = list(_samples_queryset(customer_ids, search).order_by("-updated_at")[:cap])
    items: list[dict] = []
    for row in rows:
        formulation = row.formulation
        title = _formulation_display_name(formulation) or "Sample kit"
        status_label, tone, needs = _SAMPLE_STATUS_MAP.get(
            row.status, ("Processing", "in_progress", False),
        )
        items.append(
            {
                "kind": "sample",
                "id": str(row.id),
                "code": getattr(formulation, "code", "") or "",
                "title": f"Sample · {title}",
                "subtitle": "Paid sample request",
                "status_key": row.status,
                "status_label": status_label,
                "status_tone": tone,
                "href": f"/portal/orders/{row.id}",
                "amount": _decimal_str(row.amount),
                "currency": row.currency or "GBP",
                "quantity": 1,
                "updated_at": row.updated_at,
                "needs_attention": needs,
            }
        )
    return items


# ---------------------------------------------------------------------------
# Formatting utilities
# ---------------------------------------------------------------------------


def _formulation_display_name(formulation: Any) -> str:
    """Storefront-facing name — prefer ``rtg_display_name`` on RTG
    rows so the customer sees "Ultimate Fat Burner Drink" instead of
    the internal SKU code."""

    if formulation is None:
        return ""
    if (
        getattr(formulation, "project_type", "") == "ready_to_go"
        and (getattr(formulation, "rtg_display_name", "") or "").strip()
    ):
        return formulation.rtg_display_name.strip()
    return getattr(formulation, "name", "") or ""


def _decimal_str(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return str(Decimal(value))
    except Exception:  # noqa: BLE001
        return None


def _sort_key(item: dict) -> Any:
    """Merged sort — newest updated first, needs-attention as
    tie-breaker so the "Awaiting signature" row edges out the same-
    timestamp informational row on page 1."""

    ts = item.get("updated_at")
    return (ts, 1 if item.get("needs_attention") else 0)


def _serialize_item(item: dict) -> dict:
    """Convert internal item dict → wire dict (ISO datetimes)."""

    out = dict(item)
    ts = out.get("updated_at")
    if ts is not None and hasattr(ts, "isoformat"):
        out["updated_at"] = ts.isoformat()
    return out


__all__ = ["PortalActivityView"]
