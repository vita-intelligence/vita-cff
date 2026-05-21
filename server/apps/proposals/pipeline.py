"""CRM-style pipeline read-model for the proposals surface.

Powers the staff ``/pipeline`` kanban board: one column per
:class:`ProposalStatus` value, each capped at a small page of the
most-recently-updated proposals so the first paint is always cheap
regardless of org size. Lives in its own module — separate from
:mod:`apps.proposals.services` — because the read shape, ownership
rule, and cursor scheme are pipeline-specific and the services
module already carries the full write surface for proposals.

Design choices:

* **Per-column queries, not a single mega query.** Each column is
  ``WHERE org=X AND status=Y [AND sales_person=Z] ORDER BY
  -updated_at LIMIT 25``. The composite index
  ``proposals_pipeline_col_idx`` covers the predicate so each
  column is a single b-tree range scan. Six sequential 25-row
  queries are cheaper, easier to reason about, and easier to
  optimise per-column than a window-function UNION.

* **Keyset cursor on ``(-updated_at, id)``.** Offset pagination
  on a high-churn pipeline drifts (rows shift columns between
  page fetches); keyset pagination is stable. ``id`` is the
  tiebreaker for proposals that share an ``updated_at`` to the
  microsecond.

* **Ownership rule.** When the caller does NOT hold
  :attr:`ProposalsCapability.VIEW_ALL` the queryset is silently
  scoped to ``sales_person=request.user`` — they only ever see
  their own pipeline. The "view all" request without the cap is
  a 403 (raised by :class:`PipelinePermissionDenied`) rather
  than a silent narrowing, so the FE can hide the toggle when
  it's not available.

* **Card shape is intentionally trim.** Just enough to render a
  kanban card (code, customer, sales-person initials, deal
  value, expiry). The detail page (``/proposals/[id]``) handles
  the full read — keeps the board endpoint lean even when a
  column has hundreds of cards loaded across "Load more" clicks.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable, Literal
from uuid import UUID

from django.db.models import (
    Count,
    DecimalField,
    ExpressionWrapper,
    F,
    OuterRef,
    Q,
    Subquery,
    Sum,
    Value,
)
from django.db.models.functions import Coalesce

from apps.organizations.models import Membership, Organization
from apps.organizations.modules import (
    PROPOSALS_MODULE,
    ProposalsCapability,
)
from apps.organizations.services import has_capability
from apps.proposals.models import Proposal, ProposalLine, ProposalStatus


PipelineScope = Literal["mine", "all"]


#: Default per-column page size. Small enough that even a 6-column
#: first-paint over a 1M-row table reads at most 150 rows; large
#: enough that most reps fit their whole pipeline in one page per
#: status without paging.
DEFAULT_COLUMN_LIMIT = 25


class PipelinePermissionDenied(Exception):
    """Raised when the caller asks for ``scope="all"`` without
    holding :attr:`ProposalsCapability.VIEW_ALL`. The REST layer
    translates this to a 403 — the FE should not have shown the
    "All" toggle in the first place, so this is a defence-in-
    depth check, not a routine error path."""


# ---------------------------------------------------------------------------
# Read shape (dataclasses, serialized by the REST layer)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PipelineCard:
    """One card on the kanban board.

    All fields are read straight from the Proposal row plus its
    ``sales_person`` FK — no aggregates that require touching the
    lines table, so the read stays bound by the composite index.
    """

    id: UUID
    code: str
    title: str
    status: str
    customer_name: str
    customer_company: str
    sales_person_id: UUID | None
    sales_person_name: str
    valid_until: Any  # datetime.date | None
    updated_at: datetime
    currency: str
    quantity: int
    unit_price: Decimal | None
    freight_amount: Decimal | None
    #: Quick deal total = ``quantity * unit_price + freight``.
    #: ``None`` if the proposal hasn't priced the single line yet.
    #: Intentionally not :attr:`Proposal.total_excl_vat` (which
    #: walks the ``lines`` table) — the kanban deliberately stays
    #: bound by the column index and surfaces a "headline" total
    #: only. The proposal detail page renders the precise number.
    deal_total: Decimal | None


@dataclass(frozen=True)
class PipelineColumn:
    """One column on the kanban board — i.e. one status value."""

    status: str
    label: str
    total: int
    #: Sum of ``deal_total`` across EVERY row in the column, not just
    #: the loaded cards. Computed as a single SQL aggregate so the
    #: column header can show "${currency} ${total_value}" without
    #: walking pages. ``None`` when the column is empty or every row
    #: has a null ``unit_price`` (i.e. no headline pricing yet).
    total_value: Decimal | None
    #: Wire-side currency hint — the dominant currency across the
    #: column's rows. Almost every org runs single-currency so this
    #: is unambiguous in practice; mixed-currency columns fall back
    #: to the most common code and the FE renders an asterisk hint.
    currency: str
    #: ``True`` when the column contains rows with more than one
    #: currency code. The FE shows a small "*" badge so the operator
    #: knows the totals are an approximation rather than a precise
    #: per-currency sum.
    mixed_currency: bool
    cards: list[PipelineCard]
    next_cursor: str | None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def list_pipeline(
    *,
    organization: Organization,
    membership: Membership | None,
    user: Any,
    scope: PipelineScope = "mine",
    column_limit: int = DEFAULT_COLUMN_LIMIT,
) -> list[PipelineColumn]:
    """Return every kanban column for the user's pipeline view.

    Columns are emitted in :class:`ProposalStatus` declaration
    order so the FE renders them left-to-right in funnel order
    without having to reshuffle.
    """

    _check_scope_allowed(membership=membership, scope=scope)

    columns: list[PipelineColumn] = []
    for status in ProposalStatus.values:
        cards, next_cursor, total, total_value, currency, mixed = _query_column(
            organization=organization,
            user=user,
            scope=scope,
            status=status,
            cursor=None,
            limit=column_limit,
        )
        columns.append(
            PipelineColumn(
                status=status,
                label=ProposalStatus(status).label,
                total=total,
                total_value=total_value,
                currency=currency,
                mixed_currency=mixed,
                cards=cards,
                next_cursor=next_cursor,
            ),
        )
    return columns


def list_pipeline_column(
    *,
    organization: Organization,
    membership: Membership | None,
    user: Any,
    scope: PipelineScope,
    status: str,
    cursor: str | None,
    limit: int = DEFAULT_COLUMN_LIMIT,
) -> tuple[list[PipelineCard], str | None, int, Decimal | None, str, bool]:
    """Return one column's next page — used by the "Load more"
    affordance on a column that has already been initially loaded.

    Returns ``(cards, next_cursor, total, total_value, currency,
    mixed_currency)`` so the FE can refresh its column header (count
    + sum) alongside appending the new cards.
    """

    if status not in ProposalStatus.values:
        # Unknown status: defensive. The FE only ever sends values
        # that the bundled-board endpoint already emitted.
        return ([], None, 0, None, "", False)
    _check_scope_allowed(membership=membership, scope=scope)
    return _query_column(
        organization=organization,
        user=user,
        scope=scope,
        status=status,
        cursor=cursor,
        limit=limit,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _check_scope_allowed(
    *,
    membership: Membership | None,
    scope: PipelineScope,
) -> None:
    """Defence-in-depth: a caller asking for ``scope="all"`` must
    hold :attr:`ProposalsCapability.VIEW_ALL`. Without it the
    request is rejected outright rather than silently narrowed to
    ``"mine"``, so a buggy FE that forgets to hide the toggle
    cannot accidentally leak a cross-rep view."""

    if scope == "all" and not has_capability(
        membership, PROPOSALS_MODULE, ProposalsCapability.VIEW_ALL,
    ):
        raise PipelinePermissionDenied()


def _query_column(
    *,
    organization: Organization,
    user: Any,
    scope: PipelineScope,
    status: str,
    cursor: str | None,
    limit: int,
) -> tuple[list[PipelineCard], str | None, int, Decimal | None, str, bool]:
    """Run one column's query + cursor-paginate. Returns the
    cards, the next cursor (or ``None`` if exhausted), the total
    count, the column-wide ``total_value`` (sum of headline deal
    totals), the dominant currency, and a ``mixed_currency`` flag.

    The aggregates are computed against the same filter set as the
    listing so the column header always reflects the full size
    + value of the column, not just what "Load more" has revealed."""

    base = Proposal.objects.filter(
        organization=organization,
        status=status,
    )
    if scope == "mine":
        base = base.filter(sales_person_id=getattr(user, "id", None))

    # Per-row deal total expression — mirrors ``Proposal.total_excl_vat``
    # so the kanban headlines line up with what the proposal detail
    # page and the rendered document actually print.
    #
    # Two cases per row, in priority order:
    #
    # 1. **Line-based proposal** (the multi-product envelope used by
    #    most real quotes) — sum of ``line.unit_price × line.quantity``
    #    across every ProposalLine attached to the row. The header-
    #    level ``unit_price`` / ``quantity`` are unused in this case.
    #
    # 2. **Legacy single-line proposal** — when no lines exist, fall
    #    back to header-level ``unit_price × quantity``.
    #
    # Freight (header-level) adds on top in either case.
    #
    # ``Coalesce`` picks the first non-null source: the lines
    # subquery wins when present, otherwise the legacy formula
    # contributes, otherwise zero. Without this the kanban shows
    # £0 for every line-based proposal, which is the bug a sales
    # rep with a £559k deal hit.
    money_field = DecimalField(max_digits=14, decimal_places=4)
    zero_money = Value(Decimal("0"), output_field=money_field)

    # Subquery: SUM(line.unit_price * line.quantity) per proposal.
    # ``.values("proposal").annotate(...)`` is Django's idiom for
    # "GROUP BY proposal then aggregate" — one row per outer
    # proposal, with the aggregated total in ``total``.
    lines_subtotal = (
        ProposalLine.objects
        .filter(proposal=OuterRef("pk"))
        .annotate(
            line_total=ExpressionWrapper(
                Coalesce(F("unit_price"), zero_money) * F("quantity"),
                output_field=money_field,
            ),
        )
        .values("proposal")
        .annotate(total=Sum("line_total"))
        .values("total")
    )

    subtotal_expr = Coalesce(
        Subquery(lines_subtotal, output_field=money_field),
        ExpressionWrapper(
            Coalesce(F("unit_price"), zero_money) * F("quantity"),
            output_field=money_field,
        ),
        zero_money,
    )
    deal_total_expr = ExpressionWrapper(
        subtotal_expr + Coalesce(F("freight_amount"), zero_money),
        output_field=money_field,
    )

    # Count + sum in one round-trip — the planner runs them as a
    # single index scan over the ``proposals_pipeline_col_idx``
    # composite (the filter set lines up with the leading columns).
    metrics = base.aggregate(
        count=Count("id"),
        total_value=Sum(deal_total_expr),
    )
    total = int(metrics["count"] or 0)
    total_value: Decimal | None = metrics["total_value"]

    # Currency hint — we don't aggregate per-currency (the wire
    # shape would balloon and the FE would need a picker), so we
    # peek at distinct currencies on the column and surface the
    # most common one plus a ``mixed_currency`` flag when there's
    # more than one.
    #
    # ``.order_by()`` clears the model's default ``-updated_at``
    # ordering before ``.distinct()`` — without that, Django's SQL
    # generator pulls the order-by columns into the SELECT list,
    # which silently defeats DISTINCT on a single column (every
    # row's ``updated_at`` is different, so every row survives).
    currencies = list(
        base.order_by()
        .values_list("currency", flat=True)
        .distinct(),
    )
    currencies = [c for c in currencies if c]
    if not currencies:
        currency = ""
        mixed_currency = False
    elif len(currencies) == 1:
        currency = currencies[0]
        mixed_currency = False
    else:
        # Pick the most-frequent currency as the display hint —
        # one extra small aggregate is cheaper than serialising
        # every distinct currency on the wire.
        ranked = (
            base.order_by()
            .values("currency")
            .annotate(c=Count("id"))
            .order_by("-c", "currency")
        )
        currency = ranked[0]["currency"] if ranked else currencies[0]
        mixed_currency = True

    # ``prefetch_related("lines")`` so ``Proposal.total_excl_vat``
    # (which walks ``self.lines.all()``) doesn't issue a per-row
    # query for the up-to-25 loaded cards. One batched IN-query
    # serves the full page.
    page = base.select_related("sales_person").prefetch_related("lines")
    if cursor is not None:
        decoded = _decode_cursor(cursor)
        if decoded is not None:
            updated_at, last_id = decoded
            # Strict keyset: ``(updated_at, id)`` lexicographic
            # ordering on DESC ``updated_at`` with id tiebreak.
            # Postgres tuple comparison would be tidier but
            # Django's ORM doesn't expose it portably, so we
            # decompose into the equivalent OR-of-AND.
            page = page.filter(
                Q(updated_at__lt=updated_at)
                | Q(updated_at=updated_at, id__lt=last_id),
            )

    # Fetch one extra row to know whether more pages exist without
    # a separate count query for the suffix.
    rows = list(
        page.order_by("-updated_at", "-id")[: limit + 1]
    )
    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = _encode_cursor(last.updated_at, last.id)

    cards = [_to_card(row) for row in rows]
    return cards, next_cursor, total, total_value, currency, mixed_currency


def _to_card(proposal: Proposal) -> PipelineCard:
    """Project a Proposal row into the kanban card shape."""

    sales_person = proposal.sales_person
    sales_person_id = sales_person.id if sales_person is not None else None
    sales_person_name = ""
    if sales_person is not None:
        sales_person_name = (
            getattr(sales_person, "get_full_name", lambda: "")()
            or getattr(sales_person, "email", "")
            or ""
        )

    title = (
        proposal.customer_company
        or proposal.customer_name
        or proposal.code
        or "Proposal"
    )

    # Canonical headline number — delegates to the model property
    # so the kanban chip matches what the proposal detail page,
    # list row, and rendered PDF all print. Multi-line proposals
    # sum their ``lines``; legacy single-line proposals fall back
    # to header-level ``unit_price × quantity``. The
    # ``prefetch_related("lines")`` upstream means this is a free
    # in-Python walk over already-loaded rows.
    deal_total: Decimal | None = proposal.total_excl_vat

    return PipelineCard(
        id=proposal.id,
        code=proposal.code,
        title=title,
        status=proposal.status,
        customer_name=proposal.customer_name,
        customer_company=proposal.customer_company,
        sales_person_id=sales_person_id,
        sales_person_name=sales_person_name,
        valid_until=proposal.valid_until,
        updated_at=proposal.updated_at,
        currency=proposal.currency,
        quantity=proposal.quantity,
        unit_price=proposal.unit_price,
        freight_amount=proposal.freight_amount,
        deal_total=deal_total,
    )


# ---------------------------------------------------------------------------
# Cursor encoding (opaque to clients)
# ---------------------------------------------------------------------------


def _encode_cursor(updated_at: datetime, last_id: UUID) -> str:
    """``base64(json({"u": iso, "i": uuid}))``. Opaque on the
    wire — clients echo it back verbatim. The JSON shape stays
    forward-compatible: future cursors can add fields without
    breaking decoders that ignore unknown keys."""

    payload = json.dumps(
        {"u": updated_at.isoformat(), "i": str(last_id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[datetime, UUID] | None:
    """Inverse of :func:`_encode_cursor`. Returns ``None`` on any
    decode error so a tampered / stale cursor degrades to "start
    of column" rather than a 500."""

    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
        updated_at = datetime.fromisoformat(payload["u"])
        last_id = UUID(payload["i"])
        return updated_at, last_id
    except (
        ValueError,
        KeyError,
        TypeError,
        json.JSONDecodeError,
    ):
        return None


__all__ = [
    "PipelineCard",
    "PipelineColumn",
    "PipelinePermissionDenied",
    "PipelineScope",
    "DEFAULT_COLUMN_LIMIT",
    "list_pipeline",
    "list_pipeline_column",
]
