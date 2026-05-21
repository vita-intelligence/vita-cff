"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  FlaskConical,
  Loader2,
  PlayCircle,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useRouter } from "@/i18n/navigation";
import {
  useInfiniteFormulations,
  type FormulationDto,
  type PaginatedFormulationsDto,
  type ProjectStatus,
} from "@/services/formulations";

import {
  ProjectsFilterBar,
  useProjectsFiltersState,
} from "./projects-filter-bar";


const ROW_HEIGHT_ESTIMATE = 56;
const VIEWPORT_HEIGHT_CLASS = "h-[calc(100vh-22rem)]";
const ALLOWED_SORT_FIELDS = new Set(["name", "code", "updated_at"]);


/**
 * Project list. Modernised to match the workspace treatment (rounded
 * card, ink/orange tokens, sentence-case metadata) so moving between
 * the list and a project overview feels like one surface.
 */
export function FormulationsTable({
  orgId,
  initialFirstPage,
  emptyTitle,
  emptyHint,
}: {
  orgId: string;
  initialFirstPage: PaginatedFormulationsDto | null;
  emptyTitle: string;
  emptyHint: string;
}) {
  const tFormulations = useTranslations("formulations");
  const tProject = useTranslations("project_overview");
  const tCommon = useTranslations("common");
  const router = useRouter();
  //: Tracks which row the operator just clicked so the table can
  //: light up a spinner on THAT row while ``router.push`` resolves.
  //: Without this the operator clicks, sees nothing for ~500ms,
  //: and clicks again — the second click is silently swallowed by
  //: the in-flight navigation and the row feels broken. Cleared
  //: automatically when this component unmounts on navigation.
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([
    { id: "updated_at", desc: true },
  ]);
  const ordering = useMemo(() => {
    const first = sorting[0];
    if (!first || !ALLOWED_SORT_FIELDS.has(first.id)) return "-updated_at";
    return first.desc ? `-${first.id}` : first.id;
  }, [sorting]);

  // ``applied`` is what the backend is actually filtered by (lives
  // in the URL); ``pending`` is what the user is editing in the bar
  // and only flushes on Apply. Reading applied here means each
  // backend hit is intentional, not driven by every chip click.
  const filters = useProjectsFiltersState();
  const applied = filters.applied;
  const isSearching = applied.search.length > 0;
  const filtersActive = filters.appliedAnyActive;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteFormulations(orgId, {
    ordering,
    pageSize: 50,
    search: applied.search,
    statuses: applied.statuses,
    salesPersonId: applied.salesPersonId || undefined,
    projectType: applied.projectType || undefined,
    initialFirstPage,
  });

  const flatFormulations: readonly FormulationDto[] = useMemo(
    () => data?.pages.flatMap((page) => [...page.results]) ?? [],
    [data],
  );

  const columns = useMemo<ColumnDef<FormulationDto>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: tFormulations("columns.name"),
        enableSorting: true,
        cell: (ctx) => (
          <div className="flex flex-col">
            <span className="text-sm font-medium text-ink-1000">
              {ctx.row.original.name}
            </span>
            {ctx.row.original.code ? (
              <span className="text-xs text-ink-500">
                {ctx.row.original.code}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "dosage_form",
        accessorKey: "dosage_form",
        header: tFormulations("columns.dosage_form"),
        enableSorting: false,
        cell: (ctx) => (
          <span className="text-sm text-ink-700">
            {tFormulations(`dosage_forms.${ctx.row.original.dosage_form}`)}
          </span>
        ),
      },
      {
        id: "project_status",
        accessorKey: "project_status",
        header: tFormulations("columns.project_status"),
        enableSorting: false,
        cell: (ctx) => (
          <ProjectStatusChip
            status={ctx.row.original.project_status}
            tProject={tProject}
          />
        ),
      },
      {
        id: "updated_at",
        accessorKey: "updated_at",
        header: tFormulations("columns.updated_at"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="text-sm text-ink-500">
            {formatRelativeDay(ctx.row.original.updated_at)}
          </span>
        ),
        meta: { align: "end" as const },
      },
    ],
    [tFormulations, tProject],
  );

  const table = useReactTable({
    data: flatFormulations as FormulationDto[],
    columns,
    state: { sorting },
    getRowId: (row) => row.id,
    enableSorting: true,
    manualSorting: true,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
  });

  const rows = table.getRowModel().rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 10,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1]!.end
      : 0;

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last) return;
    if (last.index >= rows.length - 10 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [
    virtualRows,
    rows.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetching) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 32) {
      void fetchNextPage();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    fetchNextPage,
    rows.length,
  ]);

  const headerGroups = table.getHeaderGroups();

  const filterBar = (
    <ProjectsFilterBar
      orgId={orgId}
      filters={filters}
      isFetching={isFetching}
    />
  );

  if (!isFetching && rows.length === 0) {
    if (isSearching || filtersActive) {
      return (
        <div className="flex flex-col gap-3">
          {filterBar}
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-ink-0 p-12 text-center shadow-sm ring-1 ring-ink-200">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-100 text-ink-500 ring-1 ring-ink-200">
              <Search className="h-6 w-6" />
            </div>
            <h2 className="text-lg font-semibold text-ink-1000">
              {applied.search
                ? tFormulations("no_matches", { query: applied.search })
                : tFormulations("no_matches_filtered")}
            </h2>
            <p className="max-w-md text-sm text-ink-500">
              {tFormulations("no_matches_hint")}
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-ink-0 p-12 text-center shadow-sm ring-1 ring-ink-200">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-600 ring-1 ring-orange-200">
          <Plus className="h-6 w-6" />
        </div>
        <h2 className="text-lg font-semibold text-ink-1000">{emptyTitle}</h2>
        <p className="max-w-md text-sm text-ink-500">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {filterBar}
      <div className="overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
        <div ref={scrollRef} className={`overflow-auto ${VIEWPORT_HEIGHT_CLASS}`}>
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-ink-0/95 backdrop-blur">
              {headerGroups.map((headerGroup) => (
                <tr
                  key={headerGroup.id}
                  className="border-b border-ink-200"
                >
                  {headerGroup.headers.map((header) => {
                    const align =
                      (header.column.columnDef.meta as
                        | { align?: "start" | "end" }
                        | undefined)?.align === "end"
                        ? "text-right"
                        : "text-left";
                    const canSort = header.column.getCanSort();
                    const sortDir = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        className={`px-5 py-3 text-xs font-medium uppercase tracking-wide text-ink-500 ${align}`}
                      >
                        <button
                          type="button"
                          onClick={
                            canSort
                              ? header.column.getToggleSortingHandler()
                              : undefined
                          }
                          className={`inline-flex items-center gap-1.5 ${
                            align === "text-right" ? "ml-auto" : ""
                          } ${
                            canSort
                              ? "transition-colors hover:text-ink-1000"
                              : "cursor-default"
                          }`}
                        >
                          <span>
                            {flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                          </span>
                          {canSort ? (
                            sortDir === "asc" ? (
                              <ArrowUp className="h-3 w-3 text-ink-700" />
                            ) : sortDir === "desc" ? (
                              <ArrowDown className="h-3 w-3 text-ink-700" />
                            ) : (
                              <ArrowUpDown className="h-3 w-3 text-ink-300" />
                            )
                          ) : null}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {paddingTop > 0 ? (
                <tr aria-hidden>
                  <td colSpan={columns.length} style={{ height: paddingTop }} />
                </tr>
              ) : null}
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index]!;
                const isPending = pendingRowId === row.id;
                return (
                  <tr
                    key={row.id}
                    onClick={() => {
                      // Acknowledge the click instantly so the row
                      // shows a spinner while ``router.push``
                      // resolves the next segment. Block re-clicks
                      // on a row that's already navigating so a
                      // double-tap doesn't spawn a queued
                      // second navigation.
                      if (pendingRowId !== null) return;
                      setPendingRowId(row.id);
                      router.push(`/formulations/${row.original.id}`);
                    }}
                    aria-busy={isPending}
                    className={`cursor-pointer border-b border-ink-100 transition-colors hover:bg-ink-50 ${
                      isPending ? "bg-ink-50" : ""
                    }`}
                  >
                    {row.getVisibleCells().map((cell, cellIndex) => {
                      const align =
                        (cell.column.columnDef.meta as
                          | { align?: "start" | "end" }
                          | undefined)?.align === "end"
                          ? "text-right"
                          : "text-left";
                      // Inject the pending spinner inline with the
                      // first column's content. Layout-stable: the
                      // spinner slot is always rendered (just
                      // ``opacity-0`` when idle) so the row's
                      // geometry never shifts while waiting.
                      const isFirstCell = cellIndex === 0;
                      return (
                        <td key={cell.id} className={`px-5 py-4 ${align}`}>
                          {isFirstCell ? (
                            <div className="flex items-center gap-2">
                              <Loader2
                                aria-hidden
                                className={`h-3.5 w-3.5 shrink-0 animate-spin text-orange-500 transition-opacity ${
                                  isPending ? "opacity-100" : "opacity-0"
                                }`}
                              />
                              <div className="min-w-0 flex-1">
                                {flexRender(
                                  cell.column.columnDef.cell,
                                  cell.getContext(),
                                )}
                              </div>
                            </div>
                          ) : (
                            flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {paddingBottom > 0 ? (
                <tr aria-hidden>
                  <td
                    colSpan={columns.length}
                    style={{ height: paddingBottom }}
                  />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between px-1 text-xs text-ink-500">
        <span>
          {tFormulations("row_count", { count: rows.length })}
          {hasNextPage ? ` · ${tFormulations("scroll_hint")}` : ""}
        </span>
        {isFetchingNextPage ? (
          <span className="text-ink-500">{tCommon("states.loading")}</span>
        ) : null}
      </div>
    </div>
  );
}


function ProjectStatusChip({
  status,
  tProject,
}: {
  status: ProjectStatus;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const map: Record<
    ProjectStatus,
    { classes: string; icon: ReactNode }
  > = {
    concept: {
      classes: "bg-ink-100 text-ink-700 ring-ink-200",
      icon: <Sparkles className="h-3 w-3" />,
    },
    in_development: {
      classes: "bg-info/10 text-info ring-info/20",
      icon: <FlaskConical className="h-3 w-3" />,
    },
    pilot: {
      classes: "bg-orange-50 text-orange-700 ring-orange-200",
      icon: <PlayCircle className="h-3 w-3" />,
    },
    approved: {
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    discontinued: {
      classes: "bg-danger/10 text-danger ring-danger/20",
      icon: <AlertTriangle className="h-3 w-3" />,
    },
  };
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.classes}`}
    >
      {s.icon}
      {tProject(`status.${status}` as "status.concept")}
    </span>
  );
}


/**
 * Deterministic UTC-day-based relative formatter. Avoids the
 * SSR/client drift we hit with Intl.DateTimeFormat — the list is
 * SSR-hydrated, and rendering a localized date would flash between
 * server and client formats on first paint.
 */
function formatRelativeDay(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = now - then;
  const day = 86_400_000;
  if (diffMs < day) return "today";
  if (diffMs < 2 * day) return "yesterday";
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
