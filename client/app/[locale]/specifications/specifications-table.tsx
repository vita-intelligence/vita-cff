"use client";

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Send,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { Chip } from "@/components/ui/chip";
import { useRouter } from "@/i18n/navigation";
import {
  useInfiniteSpecifications,
  type PaginatedSpecificationsDto,
  type SpecificationSheetDto,
  type SpecificationStatus,
} from "@/services/specifications";


const ROW_HEIGHT_ESTIMATE = 60;
const VIEWPORT_HEIGHT_CLASS = "h-[calc(100vh-22rem)]";


/**
 * Global specifications list — rounded-card chrome, semantic status
 * chips, ink-500 metadata. SSR-hydrated via :func:`getSpecificationsFirstPageServer`,
 * revalidates on every new cursor page.
 */
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
  const router = useRouter();

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
          <span className="text-xs text-ink-500">
            {ctx.row.original.code || "—"}
          </span>
        ),
      },
      {
        id: "client",
        header: tSpecs("columns.client"),
        cell: (ctx) => (
          <div className="flex flex-col">
            <span className="text-sm font-medium text-ink-1000">
              {ctx.row.original.client_company || "—"}
            </span>
            {ctx.row.original.client_name ? (
              <span className="text-xs text-ink-500">
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
          <span className="text-sm text-ink-700">
            {ctx.row.original.formulation_name}
          </span>
        ),
      },
      {
        id: "version",
        header: tSpecs("columns.version"),
        cell: (ctx) => (
          <span className="text-xs text-ink-500">
            v{ctx.row.original.formulation_version_number}
          </span>
        ),
      },
      {
        id: "status",
        header: tSpecs("columns.status"),
        cell: (ctx) => (
          <SpecStatusChip status={ctx.row.original.status} tSpecs={tSpecs} />
        ),
      },
      {
        id: "updated_at",
        header: tSpecs("columns.updated_at"),
        cell: (ctx) => (
          <span className="text-sm text-ink-500">
            {formatRelativeDay(ctx.row.original.updated_at)}
          </span>
        ),
        meta: { align: "end" as const },
      },
    ],
    [tSpecs],
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
      <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
        <FileText className="mx-auto h-8 w-8 text-ink-300" />
        <h2 className="mt-3 text-lg font-semibold text-ink-1000">
          {emptyTitle}
        </h2>
        <p className="mt-1 text-sm text-ink-500">{emptyHint}</p>
      </div>
    );
  }

  const headerGroups = table.getHeaderGroups();

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
        <div
          ref={scrollRef}
          className={`overflow-auto ${VIEWPORT_HEIGHT_CLASS}`}
        >
          <table className="w-full min-w-[720px] border-collapse">
            <thead className="sticky top-0 z-10 bg-ink-0/95 backdrop-blur">
              {headerGroups.map((hg) => (
                <tr key={hg.id} className="border-b border-ink-200">
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
                        className={`px-4 py-3 text-xs font-medium uppercase tracking-wide text-ink-500 ${align}`}
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
                    className="cursor-pointer border-b border-ink-100 transition-colors hover:bg-ink-50"
                  >
                    {row.getVisibleCells().map((cell) => {
                      const align =
                        (cell.column.columnDef.meta as
                          | { align?: "start" | "end" }
                          | undefined)?.align === "end"
                          ? "text-right"
                          : "text-left";
                      return (
                        <td key={cell.id} className={`px-4 py-3.5 ${align}`}>
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
          {tSpecs("row_count", { count: modelRows.length })}
          {hasNextPage ? ` · ${tSpecs("scroll_hint")}` : ""}
        </span>
        {isFetchingNextPage ? (
          <span>{tCommon("states.loading")}</span>
        ) : null}
      </div>
    </div>
  );
}


function SpecStatusChip({
  status,
  tSpecs,
}: {
  status: SpecificationStatus;
  tSpecs: ReturnType<typeof useTranslations<"specifications">>;
}) {
  const map: Record<
    SpecificationStatus,
    { tone: "neutral" | "orange" | "success" | "danger" | "info"; icon: ReactNode }
  > = {
    draft: { tone: "neutral", icon: <Sparkles className="h-3 w-3" /> },
    in_review: { tone: "info", icon: <Sparkles className="h-3 w-3" /> },
    approved: {
      tone: "success",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    sent: { tone: "orange", icon: <Send className="h-3 w-3" /> },
    accepted: {
      tone: "success",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    rejected: {
      tone: "danger",
      icon: <AlertTriangle className="h-3 w-3" />,
    },
  };
  const s = map[status];
  return (
    <Chip tone={s.tone} icon={s.icon}>
      {tSpecs(`status.${status}` as "status.draft")}
    </Chip>
  );
}


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
  const months = Math.floor(days / day) / 30;
  if (months < 12) return `${Math.floor(months)}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
