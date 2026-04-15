"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { useRouter } from "@/i18n/navigation";
import {
  useInfiniteFormulations,
  type FormulationDto,
  type PaginatedFormulationsDto,
} from "@/services/formulations";

const ROW_HEIGHT_ESTIMATE = 52;
const VIEWPORT_HEIGHT_CLASS = "h-[calc(100vh-22rem)]";

const ALLOWED_SORT_FIELDS = new Set(["name", "code", "updated_at"]);

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
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  // ---------------------------------------------------------------------
  // Sorting — drives the ordering query param so sort survives paging
  // ---------------------------------------------------------------------
  const [sorting, setSorting] = useState<SortingState>([
    { id: "updated_at", desc: true },
  ]);
  const ordering = useMemo(() => {
    const first = sorting[0];
    if (!first || !ALLOWED_SORT_FIELDS.has(first.id)) return "-updated_at";
    return first.desc ? `-${first.id}` : first.id;
  }, [sorting]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteFormulations(orgId, {
    ordering,
    pageSize: 50,
    initialFirstPage,
  });

  const flatFormulations: readonly FormulationDto[] = useMemo(
    () => data?.pages.flatMap((page) => [...page.results]) ?? [],
    [data],
  );

  // ---------------------------------------------------------------------
  // Columns
  // ---------------------------------------------------------------------
  const columns = useMemo<ColumnDef<FormulationDto>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: tFormulations("columns.name"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-bold">{ctx.row.original.name}</span>
        ),
      },
      {
        id: "code",
        accessorKey: "code",
        header: tFormulations("columns.code"),
        enableSorting: true,
        cell: (ctx) => (
          <code className="font-mono text-xs text-ink-600">
            {ctx.row.original.code || "—"}
          </code>
        ),
      },
      {
        id: "dosage_form",
        accessorKey: "dosage_form",
        header: tFormulations("columns.dosage_form"),
        enableSorting: false,
        cell: (ctx) => (
          <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
            {tFormulations(`dosage_forms.${ctx.row.original.dosage_form}`)}
          </span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: tFormulations("columns.status"),
        enableSorting: false,
        cell: (ctx) => (
          <span className="border-2 border-ink-1000 bg-ink-0 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-700">
            {tFormulations(`status.${ctx.row.original.status}`)}
          </span>
        ),
      },
      {
        id: "updated_at",
        accessorKey: "updated_at",
        header: tFormulations("columns.updated_at"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            {dateFormatter.format(new Date(ctx.row.original.updated_at))}
          </span>
        ),
        meta: { align: "end" as const },
      },
    ],
    [tFormulations, dateFormatter],
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

  // ---------------------------------------------------------------------
  // Virtualization
  // ---------------------------------------------------------------------
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

  // Fetch more as the user scrolls near the bottom.
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

  // Guarantee we fill the viewport even when the first page is short —
  // the virtualizer can't know to page further without a scroll event.
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

  if (!isFetching && rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2 border-2 border-ink-1000 bg-ink-0 p-8">
        <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {tCommon("states.empty")}
        </p>
        <h2 className="text-2xl font-black tracking-tight uppercase">
          {emptyTitle}
        </h2>
        <p className="text-sm text-ink-600">{emptyHint}</p>
      </div>
    );
  }

  const headerGroups = table.getHeaderGroups();

  return (
    <div className="flex flex-col gap-4">
      <div
        ref={scrollRef}
        className={`overflow-auto border-2 border-ink-1000 bg-ink-0 ${VIEWPORT_HEIGHT_CLASS}`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-ink-0">
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b-2 border-ink-1000">
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
                      className={`px-4 py-3 font-mono text-[10px] tracking-widest uppercase text-ink-700 ${align}`}
                    >
                      <button
                        type="button"
                        onClick={
                          canSort
                            ? header.column.getToggleSortingHandler()
                            : undefined
                        }
                        className={`flex items-center gap-2 ${
                          align === "text-right" ? "ml-auto" : ""
                        } ${canSort ? "hover:text-ink-1000" : "cursor-default"}`}
                      >
                        <span>
                          {flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                        </span>
                        {canSort ? (
                          <span className="text-ink-500" aria-hidden>
                            {sortDir === "asc"
                              ? "▲"
                              : sortDir === "desc"
                                ? "▼"
                                : ""}
                          </span>
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
              return (
                <tr
                  key={row.id}
                  onClick={() =>
                    router.push(`/formulations/${row.original.id}`)
                  }
                  className="cursor-pointer border-b border-ink-200 hover:bg-ink-50"
                >
                  {row.getVisibleCells().map((cell) => {
                    const align =
                      (cell.column.columnDef.meta as
                        | { align?: "start" | "end" }
                        | undefined)?.align === "end"
                        ? "text-right"
                        : "text-left";
                    return (
                      <td
                        key={cell.id}
                        className={`px-4 py-3 ${align}`}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden>
                <td colSpan={columns.length} style={{ height: paddingBottom }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t-2 border-ink-1000 bg-ink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase text-ink-600">
        <span>
          {rows.length} loaded{hasNextPage ? " · scrolling loads more" : ""}
        </span>
        {isFetchingNextPage ? (
          <span>{tCommon("states.loading")}</span>
        ) : null}
      </div>
    </div>
  );
}
