"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";

import { useRouter } from "@/i18n/navigation";
import {
  useInfiniteSpecifications,
  type PaginatedSpecificationsDto,
  type SpecificationSheetDto,
} from "@/services/specifications";

const ROW_HEIGHT_ESTIMATE = 52;
const VIEWPORT_HEIGHT_CLASS = "h-[calc(100vh-22rem)]";

export function SpecificationsTable({
  orgId,
  initialFirstPage,
  emptyTitle,
  emptyHint,
}: {
  orgId: string;
  initialFirstPage: PaginatedSpecificationsDto | null;
  emptyTitle: string;
  emptyHint: string;
}) {
  const tSpecs = useTranslations("specifications");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteSpecifications(orgId, {
    pageSize: 50,
    initialFirstPage,
  });

  const rows: readonly SpecificationSheetDto[] = useMemo(
    () => data?.pages.flatMap((page) => [...page.results]) ?? [],
    [data],
  );

  const columns = useMemo<ColumnDef<SpecificationSheetDto>[]>(
    () => [
      {
        id: "code",
        header: tSpecs("columns.code"),
        cell: (ctx) => (
          <code className="font-mono text-xs text-ink-600">
            {ctx.row.original.code || "—"}
          </code>
        ),
      },
      {
        id: "client",
        header: tSpecs("columns.client"),
        cell: (ctx) => (
          <div>
            <span className="block font-bold">
              {ctx.row.original.client_company || "—"}
            </span>
            {ctx.row.original.client_name ? (
              <span className="font-mono text-[10px] text-ink-500">
                {ctx.row.original.client_name}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "formulation",
        header: tSpecs("columns.formulation"),
        cell: (ctx) => (
          <span>{ctx.row.original.formulation_name}</span>
        ),
      },
      {
        id: "version",
        header: tSpecs("columns.version"),
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            v{ctx.row.original.formulation_version_number}
          </span>
        ),
      },
      {
        id: "status",
        header: tSpecs("columns.status"),
        cell: (ctx) => (
          <span className="border-2 border-ink-1000 bg-ink-0 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-700">
            {tSpecs(
              `status.${ctx.row.original.status}` as `status.draft`,
            )}
          </span>
        ),
      },
      {
        id: "updated_at",
        header: tSpecs("columns.updated_at"),
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            {dateFormatter.format(new Date(ctx.row.original.updated_at))}
          </span>
        ),
        meta: { align: "end" as const },
      },
    ],
    [tSpecs, dateFormatter],
  );

  const table = useReactTable({
    data: rows as SpecificationSheetDto[],
    columns,
    getRowId: (row) => row.id,
    getCoreRowModel: getCoreRowModel(),
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
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

  const modelRows = table.getRowModel().rows;

  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (!last) return;
    if (
      last.index >= modelRows.length - 10 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      void fetchNextPage();
    }
  }, [
    virtualRows,
    modelRows.length,
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
    modelRows.length,
  ]);

  if (!isFetching && modelRows.length === 0) {
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
            {headerGroups.map((hg) => (
              <tr key={hg.id} className="border-b-2 border-ink-1000">
                {hg.headers.map((header) => {
                  const align =
                    (header.column.columnDef.meta as
                      | { align?: "start" | "end" }
                      | undefined)?.align === "end"
                      ? "text-right"
                      : "text-left";
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={`px-4 py-3 font-mono text-[10px] tracking-widest uppercase text-ink-700 ${align}`}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
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
            {virtualRows.map((v) => {
              const row = modelRows[v.index]!;
              return (
                <tr
                  key={row.id}
                  onClick={() =>
                    router.push(`/specifications/${row.original.id}`)
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
                      <td key={cell.id} className={`px-4 py-3 ${align}`}>
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
          {modelRows.length} loaded
          {hasNextPage ? " · scrolling loads more" : ""}
        </span>
        {isFetchingNextPage ? (
          <span>{tCommon("states.loading")}</span>
        ) : null}
      </div>
    </div>
  );
}
