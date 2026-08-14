"""Unified portal activity feed.

``GET /api/portal/activity/`` — one endpoint that returns every
customer-facing thing the caller has in flight, normalized into a
single card shape. Powers the marketing-site portal hub (the
``/portal`` landing page on the web-site repo) which lists
Custom formulations, RTG proposals, and paid sample requests
side-by-side under one filter/search/pagination surface.

Contract (query params):

* ``kind`` — ``all|project|rtg|sample``, default ``all``.
* ``q`` — free-text search, matches code / title (case-insensitive).
* ``limit`` — page size, default 20, max 100.
* ``cursor`` — opaque base64 payload returned in the previous
  page's ``next_cursor``. Omit / empty on the first page.

Response shape::

   {
     "items": [ { … normalized item … } ],
     "next_cursor": "<base64>" | null,
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

Pagination strategy — **keyset (aka cursor) over ``(updated_at,
id)``**. Each per-kind fetch runs::

    qs.filter(Q(updated_at__lt=ts) | Q(updated_at=ts, id__lt=id))
      .order_by("-updated_at", "-id")[:limit + 1]

so the SQL cost stays ``O(log N + limit)`` regardless of dataset
size — a customer with a million RTG orders pages just as fast on
row 999,000 as on row 20. The FE walks ``next_cursor`` opaquely;
no client-visible offset arithmetic to blow up.

The merge itself is unchanged: fetch ``limit + 1`` per kind, sort
in Python by ``(updated_at, id)`` desc, slice to ``limit`` items,
compute the next cursor from the last surviving item. Overhead is
bounded at ``O(kinds * limit)`` per page.

Ownership traversal reuses :func:`client_portal.queries
.customer_ids_for_account` so duplicate ``Customer`` rows sharing
an email all contribute to the same feed (matches the dashboard's
"survives dupes" behaviour).
"""

from __future__ import annotations

import base64
import json
from decimal import Decimal
from typing import Any
from uuid import UUID

from django.db.models import Q, QuerySet
from django.utils.dateparse import parse_datetime
from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.cff_submissions.models import CFFSubmission, CFFSubmissionKind
from apps.client_portal.api.project_stage import (
    STAGE_LABELS,
    STAGE_TONES,
    resolve_stage,
)
from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import (
    customer_ids_for_account,
    formulation_ids_for_customer,
)
from apps.formulations.models import Formulation
from apps.label_design.models import LabelDesign
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.proposals.models import Proposal, ProposalStatus, ProposalTemplateType
from apps.specifications.models import SpecificationSheet


DEFAULT_LIMIT = 20
MAX_LIMIT = 100


# ---------------------------------------------------------------------------
# Cursor encoding
# ---------------------------------------------------------------------------


def _encode_cursor(updated_at, item_id: str) -> str:
    """Opaque base64 payload — clients don't parse it, they just
    hand the previous ``next_cursor`` back verbatim on the next
    request. Base64 keeps it URL-safe without a bespoke escape."""

    payload = json.dumps(
        {"ts": updated_at.isoformat(), "id": str(item_id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(raw: str | None) -> tuple[Any, str] | None:
    """Return ``(datetime, id_str)`` or ``None`` for a malformed /
    missing cursor. A malformed cursor silently degrades to "start
    from page 1" rather than 400ing — a stale link should still
    load something usable for the customer."""

    if not raw:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
    except Exception:  # noqa: BLE001
        return None
    ts_raw = payload.get("ts")
    id_raw = payload.get("id")
    if not ts_raw or not id_raw:
        return None
    ts = parse_datetime(ts_raw)
    if ts is None:
        return None
    return ts, str(id_raw)


def _cursor_filter(cursor: tuple[Any, str] | None) -> Q:
    """Compile the cursor into a Django Q. Keyset comparison
    ``(updated_at, id) < (cursor_ts, cursor_id)`` under
    ``ORDER BY -updated_at, -id``."""

    if cursor is None:
        return Q()
    ts, item_id = cursor
    return Q(updated_at__lt=ts) | Q(updated_at=ts, id__lt=item_id)


# ---------------------------------------------------------------------------
# View
# ---------------------------------------------------------------------------


class PortalActivityView(PortalAPIView):
    """GET the caller's unified activity feed. See module docstring."""

    def get(self, request: Request) -> Response:
        kind = _normalize_kind(request.query_params.get("kind"))
        search = (request.query_params.get("q") or "").strip()
        limit = _parse_limit(request)
        cursor = _decode_cursor(request.query_params.get("cursor"))

        account = request.user
        customer_ids = customer_ids_for_account(account)
        if not customer_ids:
            return Response(
                {
                    "items": [],
                    "next_cursor": None,
                    "counts": {"all": 0, "project": 0, "rtg": 0, "sample": 0},
                }
            )

        # Per-kind counts drive the tab badges. Cheap COUNT queries
        # even at scale (the SELECT hits the (updated_at) index). We
        # scope counts to ``q`` so a search that empties a bucket
        # shows a "(0)" on that tab instead of a stale "42". Counts
        # deliberately ignore the cursor — "3 of your samples" means
        # 3 in total, not 3 remaining on the current page.
        counts = _compute_counts(customer_ids, account, search)

        # Over-fetch by one per kind so we can tell whether the
        # merged page has more rows behind it without a second
        # count query. The extras get sliced off after the merge.
        cap = limit + 1

        items: list[dict] = []
        if kind in ("all", "project"):
            # CFF submissions the customer has raised but that triage
            # hasn't converted into a real Formulation yet. Once a
            # project is linked the row surfaces via the Formulation
            # bucket below, so we skip already-linked CFFs to avoid
            # showing the same brief twice under different statuses.
            items.extend(_collect_cffs(account, search, cap, cursor))
            items.extend(_collect_projects(customer_ids, search, cap, cursor))
        if kind in ("all", "rtg"):
            items.extend(_collect_rtg(customer_ids, search, cap, cursor))
        if kind in ("all", "sample"):
            items.extend(_collect_samples(customer_ids, search, cap, cursor))

        items.sort(key=_sort_key, reverse=True)
        page = items[:limit]
        # If the merged list holds strictly more than ``limit`` we
        # know there's a next page. The next cursor is the LAST
        # item on the current page — that becomes the exclusive
        # upper bound for the next fetch. No cursor means we've
        # walked to the end.
        next_cursor: str | None = None
        if page and len(items) > limit:
            last = page[-1]
            next_cursor = _encode_cursor(last["updated_at"], last["id"])

        return Response(
            {
                "items": [_serialize_item(item) for item in page],
                "next_cursor": next_cursor,
                "counts": counts,
            }
        )


# ---------------------------------------------------------------------------
# Paging + query helpers
# ---------------------------------------------------------------------------


def _normalize_kind(raw: str | None) -> str:
    value = (raw or "all").lower().strip()
    return value if value in ("all", "project", "rtg", "sample") else "all"


def _parse_limit(request: Request) -> int:
    try:
        value = int(request.query_params.get("limit") or DEFAULT_LIMIT)
    except (TypeError, ValueError):
        value = DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, value))


# ---------------------------------------------------------------------------
# Kind counts — tab badges
# ---------------------------------------------------------------------------


def _compute_counts(customer_ids: list, account, search: str) -> dict[str, int]:
    project_qs = _projects_queryset(customer_ids, search)
    cff_qs = _cff_queryset(account, search)
    rtg_qs = _rtg_queryset(customer_ids, search)
    sample_qs = _samples_queryset(customer_ids, search)

    # CFFs count towards the "project" (Custom formulations) tab —
    # a customer thinks of "the brief I submitted" and "the project
    # it turns into" as the same thing at different stages.
    project_count = project_qs.count() + cff_qs.count()
    rtg_count = rtg_qs.count()
    sample_count = sample_qs.count()

    return {
        "all": project_count + rtg_count + sample_count,
        "project": project_count,
        "rtg": rtg_count,
        "sample": sample_count,
    }


# ---------------------------------------------------------------------------
# Custom formulation rows
# ---------------------------------------------------------------------------


# Status derivation for custom-formulation cards was retired here —
# the naive ``Formulation.project_status`` map (concept /
# in_development / pilot / approved / discontinued) collapsed every
# stage of the customer's lifecycle to one of five words and left
# the card reading "In development" for weeks even after the
# customer had been asked to sign a proposal or approve a label.
# The NPD portal's dashboard endpoint already walked
# proposal / spec / label state to compute a rich stage; that walk
# now lives in :mod:`apps.client_portal.api.project_stage` and is
# reused by :func:`_collect_projects` below. Same stage keys, same
# labels, same tones — the two portals speak one language.


def _projects_queryset(customer_ids: list, search: str) -> QuerySet:
    formulation_ids = formulation_ids_for_customer(customer_ids)
    if not formulation_ids:
        return Formulation.objects.none()
    qs = Formulation.objects.filter(
        id__in=formulation_ids,
        project_type="custom",
    )
    if search:
        qs = qs.filter(Q(code__icontains=search) | Q(name__icontains=search))
    return qs


def _collect_projects(
    customer_ids: list,
    search: str,
    cap: int,
    cursor: tuple[Any, str] | None,
) -> list[dict]:
    rows = list(
        _projects_queryset(customer_ids, search)
        .filter(_cursor_filter(cursor))
        .order_by("-updated_at", "-id")[:cap]
    )
    if not rows:
        return []

    # Batch-load the three lifecycle signals ``resolve_stage`` needs
    # (proposals + spec sheets + label design) for every formulation
    # on this page in ONE query each — mirrors the ``_build_products``
    # pattern in dashboard_views.py so the activity feed doesn't
    # devolve into N+3 queries per row at scale.
    formulation_ids = [row.id for row in rows]

    from apps.client_portal.queries import customer_proposals_for_formulations

    proposals_by_form: dict = {}
    for p in customer_proposals_for_formulations(
        customer_ids=customer_ids, formulation_ids=formulation_ids
    ):
        # Anchor project — pin the proposal here.
        if p.formulation_version is not None:
            proposals_by_form.setdefault(
                p.formulation_version.formulation_id, []
            ).append(p)
        # Line-derived projects — pin the same proposal to each other
        # project it touches. Dedup-aware so an anchor project doesn't
        # get pinned twice when a line happens to repeat the anchor.
        seen = {
            p.formulation_version.formulation_id
            if p.formulation_version
            else None
        }
        for line in p.lines.all():
            sheet = line.specification_sheet
            if sheet is None or sheet.formulation_version is None:
                continue
            fid = sheet.formulation_version.formulation_id
            if fid in seen:
                continue
            seen.add(fid)
            proposals_by_form.setdefault(fid, []).append(p)

    sheets_by_form: dict = {}
    for s in (
        SpecificationSheet.objects.filter(
            formulation_version__formulation_id__in=formulation_ids,
        )
        .select_related("formulation_version")
        .order_by("-updated_at")
    ):
        sheets_by_form.setdefault(
            s.formulation_version.formulation_id, []
        ).append(s)

    labels_by_form: dict = {}
    for ld in LabelDesign.objects.filter(formulation_id__in=formulation_ids):
        labels_by_form[ld.formulation_id] = ld

    items: list[dict] = []
    for row in rows:
        stage_key, _action_url = resolve_stage(
            formulation=row,
            proposals=proposals_by_form.get(row.id, []),
            sheets=sheets_by_form.get(row.id, []),
            label_design=labels_by_form.get(row.id),
        )
        status_label = STAGE_LABELS.get(stage_key, STAGE_LABELS["unknown"])
        tone, needs = STAGE_TONES.get(stage_key, ("in_progress", False))
        items.append(
            {
                "kind": "project",
                "id": str(row.id),
                # The card's ``code`` follows the project's ``code``
                # so a CFF that was triaged into project "MA22222"
                # now renders as ``MA22222`` instead of the old
                # brief title — matches the operator's stated
                # mental model ("the CFF became a project called X").
                "code": row.code or "",
                "title": row.name or row.code or "Untitled formulation",
                "subtitle": "Custom formulation",
                "status_key": stage_key,
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
# Pending CFF submissions (bespoke briefs awaiting triage)
# ---------------------------------------------------------------------------


def _cff_cursor_filter(cursor: tuple[Any, str] | None) -> Q:
    """Same keyset shape as :func:`_cursor_filter` but keyed on
    ``wix_created_date`` — CFFSubmission carries no ``updated_at``
    column of its own. Portal rows stamp ``wix_created_date=now()``
    at creation so the ordering is monotonic per customer regardless
    of provenance."""

    if cursor is None:
        return Q()
    ts, item_id = cursor
    return Q(wix_created_date__lt=ts) | Q(wix_created_date=ts, id__lt=item_id)


def _cff_queryset(account, search: str) -> QuerySet:
    """CFFSubmissions owned by the caller, still pending triage.

    Ownership: the ``submitted_by_client_account`` FK OR the
    denormalised ``submitter_email`` (case-insensitive) — a portal
    account created after a Wix submission can still claim its own
    email-matched rows without a manual link step.

    Filters out ready-to-go CFFs (those already carry a drafted
    Proposal that shows up under the RTG tab) and any custom CFF
    that triage has already linked to a Formulation (the linked
    project shows up under the projects query, so surfacing the
    CFF here too would duplicate the same brief).
    """

    email = (getattr(account, "email", "") or "").strip()
    ownership = Q(submitted_by_client_account_id=account.pk)
    if email:
        ownership |= Q(submitter_email__iexact=email)

    qs = CFFSubmission.objects.filter(
        ownership,
        submission_kind=CFFSubmissionKind.CUSTOM,
        projects__isnull=True,
    ).distinct()
    if search:
        qs = qs.filter(
            Q(submitter_name__icontains=search)
            | Q(submitter_email__icontains=search)
        )
    return qs


def _collect_cffs(
    account,
    search: str,
    cap: int,
    cursor: tuple[Any, str] | None,
) -> list[dict]:
    rows = list(
        _cff_queryset(account, search)
        .filter(_cff_cursor_filter(cursor))
        .order_by("-wix_created_date", "-id")[:cap]
    )
    items: list[dict] = []
    for row in rows:
        # ``raw_payload`` carries the wizard's answers keyed by slug.
        # We fish a best-effort title out of the product-format /
        # market-segment / actives text so the card reads better
        # than "Submitted brief" alone. Falls back gracefully — the
        # payload shape is intentionally not schema-locked so
        # importer drift doesn't 500 the feed.
        title = _cff_title(row)
        subtitle = "Submitted brief · awaiting triage"
        # ``wix_updated_date`` may be null on portal rows that
        # haven't been touched since creation; fall through to
        # ``wix_created_date`` so the sort/cursor timestamp is
        # always populated.
        ts = row.wix_updated_date or row.wix_created_date
        items.append(
            {
                "kind": "project",
                "id": str(row.id),
                "code": "",
                "title": title,
                "subtitle": subtitle,
                "status_key": "under_review",
                "status_label": "Under review",
                "status_tone": "in_progress",
                # No dedicated per-CFF detail page on the marketing
                # site yet — link back to the hub for now. Swap for
                # /portal/requests/<id> when the detail view lands.
                "href": "/portal",
                "amount": None,
                "currency": "",
                "quantity": None,
                "updated_at": ts,
                "needs_attention": False,
            }
        )
    return items


def _cff_title(row: CFFSubmission) -> str:
    """Best-effort human title for a pending CFF row.

    Walks ``raw_payload["submissions"]`` for the slug-prefixed keys
    the wizard writes — the marketing-site wizard mirrors the NPD
    portal's payload shape so both provenances read cleanly. Falls
    back through submitter name → generic label."""

    payload = row.raw_payload or {}
    submissions = payload.get("submissions") if isinstance(payload, dict) else None
    if isinstance(submissions, dict):
        for key, value in submissions.items():
            if not isinstance(value, str) or not value.strip():
                continue
            k = key.lower()
            # Product name > market segment > format is the priority
            # order the customer would recognise first.
            if k.startswith("actives_requirements") or k.startswith("dose"):
                return f"Custom brief · {value.strip()[:80]}"
            if k.startswith("market_segment"):
                return f"Custom brief · {value.strip()[:80]}"
    if row.submitter_name:
        return f"Custom brief · {row.submitter_name}"
    return "Custom brief · submitted"


# ---------------------------------------------------------------------------
# RTG proposal rows (storefront cart orders)
# ---------------------------------------------------------------------------


_RTG_STATUS_MAP: dict[str, tuple[str, str, bool]] = {
    ProposalStatus.DRAFT: ("We're drafting your quote", "in_progress", False),
    ProposalStatus.IN_REVIEW: ("Under review", "in_progress", False),
    ProposalStatus.APPROVED: ("Quote approved — awaiting send", "in_progress", False),
    ProposalStatus.SENT: ("Awaiting your signature", "attention", True),
    ProposalStatus.ACCEPTED: ("Signed", "success", False),
    ProposalStatus.REJECTED: ("Declined", "danger", False),
}


def _rtg_queryset(customer_ids: list, search: str) -> QuerySet:
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


def _collect_rtg(
    customer_ids: list,
    search: str,
    cap: int,
    cursor: tuple[Any, str] | None,
) -> list[dict]:
    rows = list(
        _rtg_queryset(customer_ids, search)
        .filter(_cursor_filter(cursor))
        .order_by("-updated_at", "-id")[:cap]
    )
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


# Fallback status map, used only when we don't have a PSP snapshot
# for the sample (payment still pending, PSP off, sync not yet
# reached). Once the payment is confirmed and PSP has a CO, we
# derive from ``_PSP_PHASE_TO_ACTIVITY_STATUS`` below so the portal
# reflects actual production progress instead of freezing at
# "Confirmed — kit shipping soon" forever.
_SAMPLE_STATUS_MAP: dict[str, tuple[str, str, bool]] = {
    PaymentStatus.PENDING: ("Awaiting confirmation", "in_progress", False),
    PaymentStatus.APPROVED: ("Confirmed — kit shipping soon", "success", False),
    PaymentStatus.VOIDED: ("Cancelled", "danger", False),
}

# PSP OrderWizard phase → activity-feed ``(label, tone,
# needs_attention)``. Matches the copy on
# :file:`apps/client_portal/api/sample_detail_views.py` so the
# activity feed and the sample-detail page speak the same language.
# ``dispatched`` / ``delivered`` land as ``success``; every mid-
# production state stays ``in_progress`` so the tone doesn't
# prematurely turn green.
_PSP_PHASE_TO_ACTIVITY_STATUS: dict[str, tuple[str, str, bool]] = {
    "setup": ("Setting up your order", "in_progress", False),
    "approval": ("Awaiting internal approval", "in_progress", False),
    "production_planning": ("Being scheduled", "in_progress", False),
    "awaiting_ingredients": ("Sourcing ingredients", "in_progress", False),
    "in_production": ("In production", "in_progress", False),
    "closeout": ("Wrapping up production", "in_progress", False),
    "final_release": ("Final quality release", "in_progress", False),
    "awaiting_routing": ("Preparing shipment", "in_progress", False),
    "ready_to_dispatch": ("Ready to ship", "in_progress", False),
    "awaiting_pickup": ("Awaiting courier", "in_progress", False),
    "dispatched": ("On the way", "success", False),
    "delivered": ("Delivered", "success", False),
}


def _sample_status_from_psp(payment) -> tuple[str, str, str, bool] | None:
    """``(status_key, status_label, tone, needs_attention)`` derived
    from PSP's OrderWizard snapshot for this sample payment's CO, or
    ``None`` when we should fall back to :data:`_SAMPLE_STATUS_MAP`.

    Fallback triggers: payment isn't APPROVED yet (nothing on PSP to
    snapshot); PSP unreachable / decrypt failure (silent-degrade
    contract); CO hasn't synced yet (rare — retry cycle covers it);
    snapshot phase key isn't in our mapping (unknown phase, don't
    render a wrong label).

    Cost: one HTTP round-trip to PSP per sample. The activity feed
    is bounded by ``cap`` (default 20) so this adds ~20 calls per
    page load. A follow-up should batch or denormalise
    ``current_phase`` onto the Payment row via PSP webhooks.
    """

    if payment.status != PaymentStatus.APPROVED:
        return None

    from apps.psp.services import get_psp_customer_order_snapshot

    try:
        payload = get_psp_customer_order_snapshot(
            organization=payment.organization, co_uuid=payment.id
        )
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict):
        return None

    phase = snapshot.get("phase")
    if not isinstance(phase, dict):
        return None

    phase_key = phase.get("key")
    if not isinstance(phase_key, str):
        return None

    mapped = _PSP_PHASE_TO_ACTIVITY_STATUS.get(phase_key)
    if mapped is None:
        return None

    label, tone, needs = mapped
    return (phase_key, label, tone, needs)


def _samples_queryset(customer_ids: list, search: str) -> QuerySet:
    """Payments the customer sees as sample-kit orders.

    Storefront sample checkouts (see :func:`apps.client_portal
    .checkout_services._create_sample_payment`) create Payment rows
    with ``kind=FINAL`` against an RTG-tagged formulation. That
    combination is the semantic signal — Custom formulations'
    FINAL payments run against ``project_type=custom`` formulations,
    so the RTG filter cleanly separates the two flows without a
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


def _collect_samples(
    customer_ids: list,
    search: str,
    cap: int,
    cursor: tuple[Any, str] | None,
) -> list[dict]:
    rows = list(
        _samples_queryset(customer_ids, search)
        .filter(_cursor_filter(cursor))
        .order_by("-updated_at", "-id")[:cap]
    )
    items: list[dict] = []
    for row in rows:
        formulation = row.formulation
        title = _formulation_display_name(formulation) or "Sample kit"

        # Prefer the PSP-derived status once the payment is confirmed
        # AND PSP has a snapshot to hand back. Falls back to the
        # payment-status map when PSP is off, the CO hasn't synced,
        # or the phase key is unknown — keeps the card populated
        # without leaking a wrong status.
        psp_status = _sample_status_from_psp(row)
        if psp_status is not None:
            status_key, status_label, tone, needs = psp_status
        else:
            status_key = row.status
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
                "status_key": status_key,
                "status_label": status_label,
                "status_tone": tone,
                # Deep-link to the sample detail route so the customer
                # can follow their order through the production pipeline
                # (Ordered → Payment confirmed → Preparing → In production
                # → Ready). The portal FE's activity feed only makes a row
                # clickable when the href sits under a known detail
                # namespace — /portal/samples/<uuid> is that namespace
                # for sample-kit orders.
                "href": f"/portal/samples/{row.id}",
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
    """Merged sort key: (updated_at desc, id desc). Matches each
    per-kind ``order_by`` so the merge preserves the DB's ordering.
    ``id`` is coerced to string so heterogeneous UUID vs int ids
    (Formulation vs Payment) compare stably; we're only using it
    as a tiebreaker within the same timestamp so the string order
    is fine."""

    return (item.get("updated_at"), str(item.get("id", "")))


def _serialize_item(item: dict) -> dict:
    out = dict(item)
    ts = out.get("updated_at")
    if ts is not None and hasattr(ts, "isoformat"):
        out["updated_at"] = ts.isoformat()
    return out


__all__ = ["PortalActivityView"]
