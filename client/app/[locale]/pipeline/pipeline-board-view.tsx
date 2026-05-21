"use client";

/**
 * CRM-style kanban board for the proposals pipeline.
 *
 * Rendered at ``/pipeline``. One column per :class:`ProposalStatus`
 * value; cards = proposals. The data layer is the bundled-board
 * endpoint (one round-trip for the initial paint) plus a per-column
 * "Load more" endpoint that uses opaque keyset cursors.
 *
 * State model:
 *
 * * The bundled fetch is a single TanStack ``useQuery`` keyed on
 *   ``(orgId, scope)`` — flipping the scope toggle refetches the
 *   whole board, which is the same wire cost as one column query
 *   since the columns are first-page-only.
 * * Each column owns a local "extra pages" buffer keyed by status:
 *   ``Load more`` appends to it and advances the local cursor.
 *   When the bundled board re-fetches (manual refresh, scope flip),
 *   the buffer is cleared so the user sees a stable, deduplicated
 *   list.
 *
 * The board deliberately ships read-only in v1 — no drag-to-
 * advance. Status transitions carry audit + email side effects
 * and need to remain explicit (the proposal detail page already
 * hosts the transition controls).
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Link } from "@/i18n/navigation";
import {
  fetchPipelineBoard,
  fetchPipelineColumnPage,
  type PipelineCardDto,
  type PipelineColumnDto,
  type PipelineScope,
} from "@/services/proposals/pipeline";


//: Tailwind tone strip per status. Used as a 3px top border on each
//: column so the funnel reads at a glance — neutral → amber → blue
//: → indigo → emerald, with red as the off-funnel "lost" bucket.
//: The same tones inform the chip below the column title.
const COLUMN_TONE: Record<string, { border: string; chip: string }> = {
  draft: {
    border: "border-t-ink-300",
    chip: "bg-ink-100 text-ink-700 ring-ink-200",
  },
  in_review: {
    border: "border-t-amber-400",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  approved: {
    border: "border-t-blue-400",
    chip: "bg-blue-50 text-blue-800 ring-blue-200",
  },
  sent: {
    border: "border-t-indigo-400",
    chip: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  },
  accepted: {
    border: "border-t-emerald-500",
    chip: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  },
  rejected: {
    border: "border-t-red-400",
    chip: "bg-red-50 text-red-800 ring-red-200",
  },
};

const DEFAULT_TONE = {
  border: "border-t-ink-300",
  chip: "bg-ink-100 text-ink-700 ring-ink-200",
};


//: Per-column append buffer — what "Load more" has already pulled
//: in addition to the bundled board's first page. Cleared on every
//: bundled re-fetch so the user never sees a duplicated card after
//: a scope flip or a manual refresh.
interface AppendState {
  readonly extraCards: readonly PipelineCardDto[];
  readonly nextCursor: string | null;
}


export function PipelineBoardView({ orgId }: { orgId: string }) {
  const t = useTranslations("pipeline");

  const [scope, setScope] = useState<PipelineScope>("mine");
  const boardQuery = useQuery({
    queryKey: ["proposals", "pipeline", orgId, scope],
    queryFn: () => fetchPipelineBoard(orgId, scope),
    //: Keep the data warm so flipping back to a previously-loaded
    //: scope feels instant; refetch on focus catches the case where
    //: a teammate moved a deal while the rep was on another tab.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  //: Append buffer state keyed by status. Reset whenever the bundled
  //: query result changes (scope flip, refresh, etc.) — the
  //: ``useMemo`` below recomputes the merged view from this buffer
  //: + the bundled response.
  const [appendByStatus, setAppendByStatus] = useState<
    Record<string, AppendState>
  >({});

  // Reset the append buffer whenever the bundled response refreshes
  // — the previous extra-pages set is stale (status of one of those
  // proposals may have moved). ``dataUpdatedAt`` ticks once per
  // successful refetch, so this fires exactly when needed.
  useEffect(() => {
    setAppendByStatus({});
  }, [boardQuery.dataUpdatedAt]);

  const onLoadMore = useCallback(
    async (column: PipelineColumnDto) => {
      const current = appendByStatus[column.status];
      const cursor = current?.nextCursor ?? column.next_cursor;
      if (cursor === null) return;
      const page = await fetchPipelineColumnPage(orgId, column.status, {
        scope,
        cursor,
      });
      setAppendByStatus((prev) => {
        const previousExtras = prev[column.status]?.extraCards ?? [];
        return {
          ...prev,
          [column.status]: {
            extraCards: [...previousExtras, ...page.cards],
            nextCursor: page.next_cursor,
          },
        };
      });
    },
    [orgId, scope, appendByStatus],
  );

  const board = boardQuery.data;
  const canViewAll = board?.scope_capabilities.can_view_all ?? false;
  const totals = useMemo(
    () => board ? computePipelineTotals(board.columns) : null,
    [board],
  );

  return (
    <section className="mt-8 flex min-h-0 flex-1 flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-600">
            {t("subtitle")}
          </p>
        </div>

        {canViewAll ? (
          <ScopeToggle scope={scope} onChange={setScope} t={t} />
        ) : null}
      </header>

      {totals ? <PipelineTotalsBar totals={totals} t={t} /> : null}

      {boardQuery.isPending ? (
        <BoardSkeleton />
      ) : boardQuery.isError ? (
        <ErrorState message={t("error_load")} />
      ) : board ? (
        <BoardColumns
          columns={board.columns}
          appendByStatus={appendByStatus}
          onLoadMore={onLoadMore}
          t={t}
        />
      ) : null}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Pipeline-wide totals (headline strip above the board)
// ---------------------------------------------------------------------------


interface PipelineTotals {
  /** Total cards across all columns. */
  readonly totalCount: number;
  /** Total cards across "in-funnel" columns only — i.e. excluding
   *  the terminal ``accepted`` / ``rejected`` buckets. This is the
   *  number most sales leads actually care about ("what's still
   *  live?"). */
  readonly openCount: number;
  /** Sum of column ``total_value`` across the in-funnel columns. */
  readonly openValue: number;
  /** Sum of ``total_value`` on rows that landed in ``accepted``
   *  — i.e. won deals. Surfaced as a secondary metric so the
   *  operator sees their realised pipeline alongside the open one. */
  readonly wonValue: number;
  /** Dominant currency hint — pulled from the column with the
   *  largest ``total_value``. */
  readonly currency: string;
  /** ``true`` when any column reports ``mixed_currency`` — the
   *  headline number is then an approximation, signalled with a
   *  small "*" badge. */
  readonly mixedCurrency: boolean;
}


function computePipelineTotals(
  columns: readonly PipelineColumnDto[],
): PipelineTotals {
  // Terminal statuses don't count toward "live pipeline value".
  // ``accepted`` is broken out as won; ``rejected`` is simply
  // excluded from the headline so a wave of dead deals doesn't
  // distort the figure.
  const terminalStatuses = new Set(["accepted", "rejected"]);

  let totalCount = 0;
  let openCount = 0;
  let openValue = 0;
  let wonValue = 0;
  let mixedCurrency = false;

  // Pick the dominant currency from the column with the largest
  // ``total_value`` — typical orgs are single-currency so this
  // matches what the operator expects.
  let dominantCurrency = "";
  let dominantValue = -1;

  for (const column of columns) {
    totalCount += column.total;
    const value = column.total_value
      ? Number.parseFloat(column.total_value)
      : 0;
    const safeValue = Number.isFinite(value) ? value : 0;

    if (column.mixed_currency) mixedCurrency = true;
    if (column.currency && safeValue > dominantValue) {
      dominantValue = safeValue;
      dominantCurrency = column.currency;
    }

    if (!terminalStatuses.has(column.status)) {
      openCount += column.total;
      openValue += safeValue;
    } else if (column.status === "accepted") {
      wonValue += safeValue;
    }
  }

  return {
    totalCount,
    openCount,
    openValue,
    wonValue,
    currency: dominantCurrency,
    mixedCurrency,
  };
}


function PipelineTotalsBar({
  totals,
  t,
}: {
  totals: PipelineTotals;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <SummaryStat
        label={t("totals_open_value")}
        primary={formatMoneyCompact(totals.openValue, totals.currency)}
        secondary={t("totals_open_count", { count: totals.openCount })}
        tone="primary"
        hint={
          totals.mixedCurrency ? t("totals_mixed_currency_hint") : undefined
        }
      />
      <SummaryStat
        label={t("totals_won_value")}
        primary={formatMoneyCompact(totals.wonValue, totals.currency)}
        secondary={t("totals_realised_hint")}
        tone="success"
      />
      <SummaryStat
        label={t("totals_total_count")}
        primary={new Intl.NumberFormat().format(totals.totalCount)}
        secondary={t("totals_total_hint")}
        tone="neutral"
      />
    </div>
  );
}


function SummaryStat({
  label,
  primary,
  secondary,
  tone,
  hint,
}: {
  label: string;
  primary: string;
  secondary: string;
  tone: "primary" | "success" | "neutral";
  hint?: string;
}) {
  const toneClasses =
    tone === "primary"
      ? "bg-white ring-ink-200"
      : tone === "success"
        ? "bg-emerald-50/40 ring-emerald-200"
        : "bg-ink-50 ring-ink-200";
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 rounded-2xl px-5 py-4 ring-1 ring-inset ${toneClasses}`}
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <span
        className="truncate text-2xl font-semibold tracking-tight text-ink-1000"
        title={primary}
      >
        {primary}
        {hint ? (
          <span
            className="ml-1 align-super text-[10px] font-medium text-ink-500"
            title={hint}
          >
            *
          </span>
        ) : null}
      </span>
      <span className="text-xs text-ink-600">{secondary}</span>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Columns + cards
// ---------------------------------------------------------------------------


function BoardColumns({
  columns,
  appendByStatus,
  onLoadMore,
  t,
}: {
  columns: readonly PipelineColumnDto[];
  appendByStatus: Record<string, AppendState>;
  onLoadMore: (column: PipelineColumnDto) => Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  // Bound the board height so each column's card list scrolls
  // internally rather than the whole page. The ``calc`` accounts
  // for: the staff nav bar (~64px), the page header + totals row
  // (~280px on desktop, less on mobile), and the page footer
  // (~64px). ``min-h-[420px]`` keeps the board usable on a short
  // viewport.
  return (
    <div className="flex gap-4 overflow-x-auto pb-4 h-[calc(100dvh-360px)] min-h-[420px]">
      {columns.map((column) => (
        <Column
          key={column.status}
          column={column}
          appendState={appendByStatus[column.status]}
          onLoadMore={onLoadMore}
          t={t}
        />
      ))}
    </div>
  );
}


function Column({
  column,
  appendState,
  onLoadMore,
  t,
}: {
  column: PipelineColumnDto;
  appendState: AppendState | undefined;
  onLoadMore: (column: PipelineColumnDto) => Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const tone = COLUMN_TONE[column.status] ?? DEFAULT_TONE;
  const allCards = useMemo(() => {
    const extras = appendState?.extraCards ?? [];
    return [...column.cards, ...extras];
  }, [column.cards, appendState]);

  // ``nextCursor`` follows the local buffer once load-more has run;
  // until then it reflects the bundled board's first-page cursor.
  const nextCursor = appendState
    ? appendState.nextCursor
    : column.next_cursor;

  const loadMore = useMutation({
    mutationFn: () => onLoadMore(column),
  });

  const columnValue = column.total_value
    ? Number.parseFloat(column.total_value)
    : 0;
  const hasValue = column.total_value && Number.isFinite(columnValue) && columnValue !== 0;

  return (
    <article
      className={`flex h-full w-80 shrink-0 flex-col rounded-2xl border border-ink-200 bg-white shadow-sm ring-1 ring-ink-100/60 border-t-4 ${tone.border}`}
    >
      <header className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold uppercase tracking-wide text-ink-1000">
            {column.label}
          </span>
          <span
            className={`inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone.chip}`}
          >
            {column.total}
          </span>
        </div>
        {hasValue ? (
          <span
            className="truncate text-lg font-semibold tracking-tight text-ink-1000"
            title={formatMoney(column.total_value!, column.currency)}
          >
            {formatMoneyCompact(columnValue, column.currency)}
            {column.mixed_currency ? (
              <span
                className="ml-1 align-super text-[10px] font-medium text-ink-500"
                title={t("totals_mixed_currency_hint")}
              >
                *
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-ink-400">{t("column_no_value")}</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {allCards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-ink-200 bg-ink-0 p-4 text-center text-xs text-ink-500">
            {t("column_empty")}
          </p>
        ) : (
          allCards.map((card) => <Card key={card.id} card={card} t={t} />)
        )}
      </div>

      {nextCursor ? (
        <footer className="border-t border-ink-100 p-3">
          <button
            type="button"
            onClick={() => loadMore.mutate()}
            disabled={loadMore.isPending}
            className="w-full rounded-lg bg-ink-50 px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 disabled:opacity-60"
          >
            {loadMore.isPending ? t("loading_more") : t("load_more")}
          </button>
        </footer>
      ) : null}
    </article>
  );
}


function Card({
  card,
  t,
}: {
  card: PipelineCardDto;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Link
      href={`/proposals/${card.id}`}
      prefetch={false}
      className="group flex flex-col gap-2 rounded-lg border border-ink-200 bg-white p-3 transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-400"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-500">
          {card.code || t("no_code")}
        </span>
        {card.deal_total ? (
          <span
            className="shrink-0 rounded bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-800"
            title={formatMoney(card.deal_total, card.currency)}
          >
            {formatMoneyCompact(
              Number.parseFloat(card.deal_total),
              card.currency,
            )}
          </span>
        ) : null}
      </div>
      <p className="line-clamp-2 text-sm font-medium text-ink-1000">
        {card.title}
      </p>
      {card.customer_company && card.customer_company !== card.title ? (
        <p className="truncate text-xs text-ink-600">{card.customer_company}</p>
      ) : null}
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-500">
        <span className="inline-flex items-center gap-1">
          <Avatar name={card.sales_person_name} />
          <span className="truncate">
            {card.sales_person_name || t("unassigned")}
          </span>
        </span>
        {card.valid_until ? (
          <span title={t("valid_until")}>
            {formatDate(card.valid_until)}
          </span>
        ) : null}
      </div>
    </Link>
  );
}


function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink-100 text-[10px] font-semibold text-ink-700 ring-1 ring-inset ring-ink-200"
    >
      {initials || "·"}
    </span>
  );
}


function ScopeToggle({
  scope,
  onChange,
  t,
}: {
  scope: PipelineScope;
  onChange: (scope: PipelineScope) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div
      role="tablist"
      aria-label={t("scope_label")}
      className="inline-flex items-center rounded-lg bg-ink-100 p-1 ring-1 ring-inset ring-ink-200"
    >
      {(["mine", "all"] as const).map((value) => {
        const active = scope === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-white text-ink-1000 shadow-sm"
                : "text-ink-600 hover:text-ink-1000"
            }`}
          >
            {t(`scope_${value}`)}
          </button>
        );
      })}
    </div>
  );
}


function BoardSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex h-80 w-72 shrink-0 flex-col gap-3 rounded-2xl border border-ink-200 bg-white p-4 shadow-sm"
        >
          <div className="h-4 w-24 animate-pulse rounded bg-ink-100" />
          <div className="h-20 animate-pulse rounded bg-ink-50" />
          <div className="h-20 animate-pulse rounded bg-ink-50" />
        </div>
      ))}
    </div>
  );
}


function ErrorState({ message }: { message: string }) {
  return (
    <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
      {message}
    </p>
  );
}


// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------


function formatMoney(raw: string, currency: string): string {
  // Full-precision formatter — used for ``title`` tooltips so the
  // operator can hover a compact-formatted chip ("£1.2M") and read
  // the precise number underneath. Decimal strings come from the
  // API; ``parseFloat`` is enough here because the proposal detail
  // page renders the precise number via the existing money
  // formatter — this is just a tooltip echo.
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return raw;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "GBP",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${raw}`;
  }
}


/**
 * Compact currency formatter — used everywhere a money figure has
 * limited horizontal space (card chips, column headers, totals
 * bar). Renders ``£1.2M`` / ``£250K`` / ``£42`` rather than the
 * full ``£1,234,567`` so a long pipeline column doesn't overflow
 * the 320px-wide card surface.
 *
 * Fallback strategy: small values (< 10,000) render in full so the
 * "Draft column has £450" case stays human-readable. ``Intl``'s
 * ``notation: "compact"`` handles the M/K/B suffixes per locale.
 */
function formatMoneyCompact(value: number, currency: string): string {
  if (!Number.isFinite(value)) return "—";
  const useCompact = Math.abs(value) >= 10_000;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "GBP",
      notation: useCompact ? "compact" : "standard",
      compactDisplay: "short",
      maximumFractionDigits: useCompact ? 1 : 0,
    }).format(value);
  } catch {
    return `${currency || ""} ${value.toFixed(0)}`.trim();
  }
}


function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
  });
}
