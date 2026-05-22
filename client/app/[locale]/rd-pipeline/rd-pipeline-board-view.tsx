"use client";

/**
 * Kanban board for the R&D side of the project lifecycle.
 *
 * Rendered at ``/rd-pipeline``. Five columns derived from the
 * project's child-document state (Builder → Spec drafting → Spec
 * approved → Proposal → Closed); cards = projects. Default scope is
 * ``mine`` (filtered to ``lead_scientist=request.user``); members
 * with the ``formulations.view_all_rd_pipeline`` capability also see
 * an "All" toggle.
 *
 * The view mirrors the structure of the sales :class:`PipelineBoardView`
 * — bundled fetch + per-column append buffer + a "Load more"
 * affordance — but ships without the money/currency strip. R&D
 * pipelines are headcount-driven, not deal-value-driven, so the
 * relevant headline is "how many live projects per stage", not a
 * monetary total.
 *
 * Read-only in v1: stages are derived from child-document state,
 * not a flippable column on the project row, so a drag-to-advance
 * gesture would need to manufacture side effects across multiple
 * tables and we want those transitions to stay explicit.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Link } from "@/i18n/navigation";
import {
  fetchRDPipelineBoard,
  fetchRDPipelineColumnPage,
  type RDPipelineCardDto,
  type RDPipelineColumnDto,
  type RDPipelineScope,
  type RDPipelineStage,
} from "@/services/formulations/rd-pipeline";


//: Tailwind tone strip per stage. Funnel-style left-to-right
//: gradient — neutral → amber → blue → indigo → emerald — so the
//: board reads at a glance.
const STAGE_TONE: Record<RDPipelineStage, { border: string; chip: string }> = {
  builder: {
    border: "border-t-ink-300",
    chip: "bg-ink-100 text-ink-700 ring-ink-200",
  },
  spec_drafting: {
    border: "border-t-amber-400",
    chip: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  spec_approved: {
    border: "border-t-blue-400",
    chip: "bg-blue-50 text-blue-800 ring-blue-200",
  },
  proposal: {
    border: "border-t-indigo-400",
    chip: "bg-indigo-50 text-indigo-800 ring-indigo-200",
  },
  closed: {
    border: "border-t-emerald-500",
    chip: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  },
};


//: Per-column "Load more" buffer. Cleared on every bundled
//: re-fetch so the user never sees a duplicated card after a scope
//: flip or a manual refresh.
interface AppendState {
  readonly extraCards: readonly RDPipelineCardDto[];
  readonly nextCursor: string | null;
}


export function RDPipelineBoardView({ orgId }: { orgId: string }) {
  const t = useTranslations("rd_pipeline");

  const [scope, setScope] = useState<RDPipelineScope>("mine");
  const boardQuery = useQuery({
    queryKey: ["formulations", "rd-pipeline", orgId, scope],
    queryFn: () => fetchRDPipelineBoard(orgId, scope),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const [appendByStage, setAppendByStage] = useState<
    Record<string, AppendState>
  >({});

  // Reset the append buffer whenever the bundled response refreshes
  // — the previous extras may include a card that has since moved
  // to a different stage.
  useEffect(() => {
    setAppendByStage({});
  }, [boardQuery.dataUpdatedAt]);

  const onLoadMore = useCallback(
    async (column: RDPipelineColumnDto) => {
      const current = appendByStage[column.stage];
      const cursor = current?.nextCursor ?? column.next_cursor;
      if (cursor === null) return;
      const page = await fetchRDPipelineColumnPage(orgId, column.stage, {
        scope,
        cursor,
      });
      setAppendByStage((prev) => {
        const previousExtras = prev[column.stage]?.extraCards ?? [];
        return {
          ...prev,
          [column.stage]: {
            extraCards: [...previousExtras, ...page.cards],
            nextCursor: page.next_cursor,
          },
        };
      });
    },
    [orgId, scope, appendByStage],
  );

  const board = boardQuery.data;
  const canViewAll = board?.scope_capabilities.can_view_all ?? false;
  const totalCount = board?.columns.reduce((n, c) => n + c.total, 0) ?? 0;

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

      {board ? (
        <p className="text-xs text-ink-500">
          {t("total_count", { count: totalCount })}
        </p>
      ) : null}

      {boardQuery.isPending ? (
        <BoardSkeleton />
      ) : boardQuery.isError ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {t("error_load")}
        </p>
      ) : board ? (
        <BoardColumns
          columns={board.columns}
          appendByStage={appendByStage}
          onLoadMore={onLoadMore}
          scope={scope}
          t={t}
        />
      ) : null}
    </section>
  );
}


function ScopeToggle({
  scope,
  onChange,
  t,
}: {
  scope: RDPipelineScope;
  onChange: (next: RDPipelineScope) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div
      role="tablist"
      aria-label={t("scope_aria")}
      className="inline-flex rounded-full bg-ink-100 p-0.5 text-xs font-medium"
    >
      {(["mine", "all"] as const).map((value) => {
        const isActive = scope === value;
        return (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={isActive}
            onClick={() => onChange(value)}
            className={
              isActive
                ? "rounded-full bg-white px-4 py-1.5 text-ink-1000 shadow-sm"
                : "rounded-full px-4 py-1.5 text-ink-600 hover:text-ink-900"
            }
          >
            {t(`scope_${value}`)}
          </button>
        );
      })}
    </div>
  );
}


function BoardColumns({
  columns,
  appendByStage,
  onLoadMore,
  scope,
  t,
}: {
  columns: readonly RDPipelineColumnDto[];
  appendByStage: Record<string, AppendState>;
  onLoadMore: (column: RDPipelineColumnDto) => void;
  scope: RDPipelineScope;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-flow-col auto-cols-[minmax(260px,1fr)] gap-4 overflow-x-auto pb-4">
      {columns.map((column) => (
        <Column
          key={column.stage}
          column={column}
          append={appendByStage[column.stage] ?? null}
          onLoadMore={() => onLoadMore(column)}
          scope={scope}
          t={t}
        />
      ))}
    </div>
  );
}


function Column({
  column,
  append,
  onLoadMore,
  scope,
  t,
}: {
  column: RDPipelineColumnDto;
  append: AppendState | null;
  onLoadMore: () => void;
  scope: RDPipelineScope;
  t: ReturnType<typeof useTranslations>;
}) {
  const tone = STAGE_TONE[column.stage];
  const merged: readonly RDPipelineCardDto[] = [
    ...column.cards,
    ...(append?.extraCards ?? []),
  ];
  const moreAvailable =
    (append ? append.nextCursor : column.next_cursor) !== null;

  return (
    <section
      aria-label={t(`stages.${column.stage}`)}
      className={`flex min-h-0 flex-col rounded-xl bg-white shadow-sm ring-1 ring-ink-200 ${tone.border} border-t-[3px]`}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-3">
        <h2 className="text-sm font-semibold text-ink-1000">
          {t(`stages.${column.stage}`)}
        </h2>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${tone.chip}`}
        >
          {column.total}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {merged.length === 0 ? (
          <p className="rounded-lg bg-ink-50 px-3 py-6 text-center text-xs text-ink-500">
            {t("column_empty")}
          </p>
        ) : (
          merged.map((card) => <Card key={card.id} card={card} scope={scope} />)
        )}
        {moreAvailable ? (
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded-lg bg-ink-50 px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-100"
          >
            {t("load_more")}
          </button>
        ) : null}
      </div>
    </section>
  );
}


function Card({
  card,
  scope,
}: {
  card: RDPipelineCardDto;
  scope: RDPipelineScope;
}) {
  return (
    <Link
      href={`/formulations/${card.id}`}
      className="block rounded-lg border border-ink-200 bg-white px-3 py-2.5 text-left transition-shadow hover:shadow-sm"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {card.code}
      </p>
      <p className="mt-0.5 truncate text-sm font-medium text-ink-1000">
        {card.name}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-md bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200">
          {prettify(card.dosage_form)}
        </span>
        <span className="inline-flex items-center rounded-md bg-ink-50 px-1.5 py-0.5 text-[10px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200">
          {prettify(card.project_status)}
        </span>
        {scope === "all" && card.lead_scientist_name ? (
          <span className="inline-flex items-center rounded-md bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info ring-1 ring-inset ring-info/20">
            {card.lead_scientist_name}
          </span>
        ) : null}
      </div>
    </Link>
  );
}


/** Snake-case ``in_development`` → Title-case ``In Development``.
 *  Kept ad-hoc here because the card badges aren't important
 *  enough to bring full i18n into — both the dosage form and the
 *  project status are English-only constants on the wire. */
function prettify(value: string): string {
  if (!value) return "";
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}


function BoardSkeleton() {
  return (
    <div className="grid grid-flow-col auto-cols-[minmax(260px,1fr)] gap-4 overflow-x-auto pb-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex h-[400px] flex-col gap-2 rounded-xl bg-white p-3 ring-1 ring-ink-200"
        >
          <div className="h-5 w-24 animate-pulse rounded bg-ink-100" />
          {Array.from({ length: 3 }).map((__, j) => (
            <div
              key={j}
              className="h-16 animate-pulse rounded-lg bg-ink-50"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
