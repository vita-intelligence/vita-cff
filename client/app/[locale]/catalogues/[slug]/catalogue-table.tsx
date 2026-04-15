"use client";

import { AlertDialog, Button } from "@heroui/react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useRouter } from "@/i18n/navigation";
import type { AttributeDefinitionDto } from "@/services/attributes/types";
import {
  archiveItem,
  hardDeleteItem,
  updateItem,
  useInfiniteItems,
} from "@/services/catalogues";
import type {
  ItemDto,
  PaginatedItemsDto,
} from "@/services/catalogues/types";

const SELECT_COLUMN_ID = "__select";
const DYNAMIC_PREFIX = "attr:";
const ROW_HEIGHT_ESTIMATE = 52;
const VIEWPORT_HEIGHT_CLASS = "h-[calc(100vh-20rem)]";

function columnOrderStorageKey(slug: string): string {
  return `vita.catalogues.${slug}.columnOrder`;
}

function dynamicKey(definitionKey: string): string {
  return `${DYNAMIC_PREFIX}${definitionKey}`;
}

function BrutalistCheckbox({
  checked,
  indeterminate,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  ariaLabel: string;
  onChange: (event: ReactMouseEvent<HTMLInputElement>) => void;
}) {
  const filled = checked || Boolean(indeterminate);
  return (
    <span
      className={`relative inline-flex h-4 w-4 items-center justify-center border-2 border-ink-1000 ${
        filled ? "bg-ink-1000" : "bg-ink-0"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        aria-label={ariaLabel}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onClick={(e) => {
          e.stopPropagation();
          onChange(e);
        }}
        onChange={() => {}}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none focus:outline-none"
      />
      {checked ? (
        <svg
          className="pointer-events-none relative h-3 w-3 text-ink-0"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="square"
          aria-hidden
        >
          <path d="M3 8L7 12L13 4" />
        </svg>
      ) : indeterminate ? (
        <svg
          className="pointer-events-none relative h-3 w-3 text-ink-0"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="square"
          aria-hidden
        >
          <path d="M3 8L13 8" />
        </svg>
      ) : null}
    </span>
  );
}

function useDynamicCellRenderer() {
  const locale = useLocale();
  const priceFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }),
    [locale],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  return useCallback(
    (item: ItemDto, definition: AttributeDefinitionDto) => {
      const raw = item.attributes?.[definition.key];
      if (raw === null || raw === undefined || raw === "") {
        return <span className="font-mono text-xs text-ink-400">—</span>;
      }
      switch (definition.data_type) {
        case "text":
          return (
            <span className="font-mono text-xs text-ink-700">
              {String(raw)}
            </span>
          );
        case "number":
          return (
            <span className="font-mono text-xs">
              {typeof raw === "number"
                ? priceFormatter.format(raw)
                : String(raw)}
            </span>
          );
        case "boolean":
          return (
            <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
              {raw ? "yes" : "no"}
            </span>
          );
        case "date":
          return (
            <span className="font-mono text-xs text-ink-700">
              {typeof raw === "string"
                ? dateFormatter.format(new Date(raw))
                : String(raw)}
            </span>
          );
        case "single_select": {
          const option = definition.options.find(
            (o) => o.value === String(raw),
          );
          return (
            <span className="font-mono text-xs text-ink-700">
              {option?.label ?? String(raw)}
            </span>
          );
        }
        case "multi_select":
          if (!Array.isArray(raw)) return <span>—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {raw.map((value) => {
                const option = definition.options.find(
                  (o) => o.value === value,
                );
                return (
                  <span
                    key={value}
                    className="border border-ink-1000 px-1.5 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-700"
                  >
                    {option?.label ?? value}
                  </span>
                );
              })}
            </div>
          );
        default:
          return <span>{String(raw)}</span>;
      }
    },
    [priceFormatter, dateFormatter],
  );
}

export function CatalogueTable({
  orgId,
  slug,
  definitions,
  emptyTitle,
  emptyHint,
  viewArchived,
  canAdmin,
  initialFirstPage,
}: {
  orgId: string;
  slug: string;
  definitions: readonly AttributeDefinitionDto[];
  emptyTitle: string;
  emptyHint: string;
  viewArchived: boolean;
  canAdmin: boolean;
  initialFirstPage: PaginatedItemsDto | null;
}) {
  const tItems = useTranslations("items");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  const storageKey = columnOrderStorageKey(slug);
  const renderDynamic = useDynamicCellRenderer();

  const priceFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }),
    [locale],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);
  const ordering = useMemo(() => {
    const first = sorting[0];
    if (!first) return "name";
    return first.desc ? `-${first.id}` : first.id;
  }, [sorting]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteItems(orgId, slug, {
    includeArchived: viewArchived,
    ordering,
    pageSize: 100,
    initialFirstPage,
  });

  const flatItems: readonly ItemDto[] = useMemo(
    () => data?.pages.flatMap((page) => [...page.results]) ?? [],
    [data],
  );

  const columns = useMemo<ColumnDef<ItemDto>[]>(() => {
    const selectColumn: ColumnDef<ItemDto> = {
      id: SELECT_COLUMN_ID,
      size: 40,
      enableSorting: false,
      header: ({ table }) => (
        <div className="flex items-center justify-center">
          <BrutalistCheckbox
            ariaLabel="Select all"
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected()}
            onChange={() => table.toggleAllRowsSelected()}
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <BrutalistCheckbox
            ariaLabel={`Select ${row.original.name}`}
            checked={row.getIsSelected()}
            onChange={(event) => {
              if (event.shiftKey) {
                handleShiftSelect(row.id);
              } else {
                row.toggleSelected();
              }
              setLastSelectedId(row.id);
            }}
          />
        </div>
      ),
    };

    const builtins: ColumnDef<ItemDto>[] = [
      {
        id: "name",
        accessorKey: "name",
        header: tItems("columns.name"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-bold">{ctx.row.original.name}</span>
        ),
      },
      {
        id: "internal_code",
        accessorKey: "internal_code",
        header: tItems("columns.internal_code"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            {ctx.row.original.internal_code || "—"}
          </span>
        ),
      },
      {
        id: "unit",
        accessorKey: "unit",
        header: tItems("columns.unit"),
        enableSorting: false,
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            {ctx.row.original.unit || "—"}
          </span>
        ),
      },
      {
        id: "base_price",
        accessorFn: (row) =>
          row.base_price ? Number.parseFloat(row.base_price) : null,
        header: tItems("columns.base_price"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-mono text-xs">
            {ctx.row.original.base_price
              ? priceFormatter.format(
                  Number.parseFloat(ctx.row.original.base_price),
                )
              : "—"}
          </span>
        ),
        meta: { align: "end" as const },
      },
      {
        id: "updated_at",
        accessorKey: "updated_at",
        header: tItems("columns.updated_at"),
        enableSorting: true,
        cell: (ctx) => (
          <span className="font-mono text-xs text-ink-600">
            {dateFormatter.format(new Date(ctx.row.original.updated_at))}
          </span>
        ),
      },
      {
        id: "status",
        header: tItems("columns.status"),
        enableSorting: false,
        cell: (ctx) => {
          const archived = ctx.row.original.is_archived;
          return (
            <span
              className={
                archived
                  ? "border-2 border-ink-1000 bg-ink-200 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-700"
                  : "border-2 border-ink-1000 bg-ink-1000 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-0"
              }
            >
              {archived
                ? tItems("status.archived")
                : tItems("status.active")}
            </span>
          );
        },
      },
    ];

    const dynamicColumns: ColumnDef<ItemDto>[] = definitions
      .filter((d) => !d.is_archived)
      .sort(
        (a, b) =>
          a.display_order - b.display_order || a.label.localeCompare(b.label),
      )
      .map((d) => ({
        id: dynamicKey(d.key),
        header: d.label,
        enableSorting: false,
        accessorFn: (row) => row.attributes?.[d.key],
        cell: (ctx) => renderDynamic(ctx.row.original, d),
        meta: {
          align: (d.data_type === "number" ? "end" : "start") as
            | "end"
            | "start",
        },
      }));

    return [selectColumn, ...builtins, ...dynamicColumns];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitions, tItems, priceFormatter, dateFormatter, renderDynamic]);

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const handleShiftSelect = useCallback(
    (targetRowId: string) => {
      if (!lastSelectedId || lastSelectedId === targetRowId) {
        setRowSelection((prev) => {
          const next = { ...prev };
          next[targetRowId] = !prev[targetRowId];
          return next;
        });
        return;
      }
      const order = flatItems.map((i) => i.id);
      const lastIndex = order.indexOf(lastSelectedId);
      const currIndex = order.indexOf(targetRowId);
      if (lastIndex === -1 || currIndex === -1) return;
      const [from, to] =
        lastIndex < currIndex
          ? [lastIndex, currIndex]
          : [currIndex, lastIndex];
      setRowSelection((prev) => {
        const next = { ...prev };
        const willSelect = !prev[targetRowId];
        for (let i = from; i <= to; i += 1) {
          const id = order[i];
          if (id === undefined) continue;
          if (willSelect) {
            next[id] = true;
          } else {
            delete next[id];
          }
        }
        return next;
      });
    },
    [flatItems, lastSelectedId],
  );

  const defaultColumnOrder = useMemo(
    () => columns.map((c) => c.id!).filter(Boolean),
    [columns],
  );
  const [columnOrder, setColumnOrder] =
    useState<ColumnOrderState>(defaultColumnOrder);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      const saved =
        Array.isArray(parsed) && parsed.every((v) => typeof v === "string")
          ? (parsed as string[])
          : null;
      if (!saved) {
        setColumnOrder(defaultColumnOrder);
        return;
      }
      const available = new Set(defaultColumnOrder);
      const merged = saved.filter((id) => available.has(id));
      const seen = new Set(merged);
      for (const id of defaultColumnOrder) {
        if (!seen.has(id)) merged.push(id);
      }
      const withoutSelect = merged.filter((id) => id !== SELECT_COLUMN_ID);
      setColumnOrder([SELECT_COLUMN_ID, ...withoutSelect]);
    } catch {
      setColumnOrder(defaultColumnOrder);
    }
  }, [defaultColumnOrder, storageKey]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify(columnOrder.filter((id) => id !== SELECT_COLUMN_ID)),
      );
    } catch {
      /* ignore */
    }
  }, [columnOrder, storageKey]);

  const table = useReactTable({
    data: flatItems as ItemDto[],
    columns,
    state: { rowSelection, sorting, columnOrder },
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableSorting: true,
    manualSorting: true,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnOrderChange: setColumnOrder,
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
  }, [virtualRows, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage || isFetching) return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 32) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isFetching, fetchNextPage, rows.length]);

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );
  const selectionCount = selectedIds.length;
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setLastSelectedId(null);
  }, []);

  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [isBulkDeleteOpen, setIsBulkDeleteOpen] = useState(false);

  const runBulk = useCallback(
    async (
      op: (id: string) => Promise<unknown>,
      onDone?: () => void,
    ): Promise<void> => {
      setBulkBusy(true);
      setBulkError(null);
      try {
        const results = await Promise.allSettled(
          selectedIds.map((id) => op(id)),
        );
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          setBulkError(tItems("bulk.partial_failure"));
        } else {
          clearSelection();
        }
        onDone?.();
        router.refresh();
      } finally {
        setBulkBusy(false);
      }
    },
    [selectedIds, clearSelection, router, tItems],
  );

  const onBulkArchive = useCallback(
    () => runBulk((id) => archiveItem(orgId, slug, id)),
    [runBulk, orgId, slug],
  );
  const onBulkRestore = useCallback(
    () =>
      runBulk((id) => updateItem(orgId, slug, id, { is_archived: false })),
    [runBulk, orgId, slug],
  );
  const onBulkDeletePermanently = useCallback(
    () =>
      runBulk(
        (id) => hardDeleteItem(orgId, slug, id),
        () => setIsBulkDeleteOpen(false),
      ),
    [runBulk, orgId, slug],
  );

  const handleDragStart =
    (key: string) => (event: DragEvent<HTMLDivElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    };

  const handleDragOver =
    (key: string) => (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (dragOverKey !== key) setDragOverKey(key);
    };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.stopPropagation();
    setDragOverKey(null);
  };

  const handleDrop =
    (targetKey: string) => (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const sourceKey = event.dataTransfer.getData("text/plain");
      if (!sourceKey || sourceKey === targetKey) {
        setDragOverKey(null);
        return;
      }
      setColumnOrder((prev) => {
        const next = [...prev];
        const fromIndex = next.indexOf(sourceKey);
        const toIndex = next.indexOf(targetKey);
        if (fromIndex === -1 || toIndex === -1) return prev;
        next.splice(fromIndex, 1);
        next.splice(toIndex, 0, sourceKey);
        const withoutSelect = next.filter((id) => id !== SELECT_COLUMN_ID);
        return [SELECT_COLUMN_ID, ...withoutSelect];
      });
      setDragOverKey(null);
    };

  const handleDragEnd = () => setDragOverKey(null);

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
  const loadedCount = rows.length;

  return (
    <div className="flex flex-col gap-4">
      {selectionCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink-1000 bg-ink-1000 px-4 py-3 text-ink-0">
          <div className="flex items-center gap-4">
            <span className="font-mono text-xs tracking-widest uppercase">
              {tItems("bulk.selected_count", { count: selectionCount })}
            </span>
            <button
              type="button"
              className="font-mono text-[10px] tracking-widest uppercase text-ink-0 underline underline-offset-4 hover:text-ink-200 disabled:opacity-50"
              onClick={clearSelection}
              disabled={bulkBusy}
            >
              {tItems("bulk.clear")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {canAdmin && !viewArchived ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-none border-2 border-ink-0 font-bold tracking-wider uppercase text-ink-0 hover:bg-ink-0 hover:text-ink-1000"
                onClick={onBulkArchive}
                isDisabled={bulkBusy}
              >
                {tItems("bulk.archive")}
              </Button>
            ) : null}
            {canAdmin && viewArchived ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-none border-2 border-ink-0 font-bold tracking-wider uppercase text-ink-0 hover:bg-ink-0 hover:text-ink-1000"
                  onClick={onBulkRestore}
                  isDisabled={bulkBusy}
                >
                  {tItems("bulk.restore")}
                </Button>
                <AlertDialog
                  isOpen={isBulkDeleteOpen}
                  onOpenChange={setIsBulkDeleteOpen}
                >
                  <AlertDialog.Trigger>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      className="rounded-none font-bold tracking-wider uppercase"
                      isDisabled={bulkBusy}
                    >
                      {tItems("bulk.delete_permanently")}
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Backdrop>
                    <AlertDialog.Container size="md">
                      <AlertDialog.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0 text-ink-1000">
                        <AlertDialog.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
                          <AlertDialog.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                            {tItems("bulk.confirm_title", {
                              count: selectionCount,
                            })}
                          </AlertDialog.Heading>
                        </AlertDialog.Header>
                        <AlertDialog.Body className="px-6 py-6">
                          <p className="text-sm text-ink-700">
                            {tItems("bulk.confirm_body")}
                          </p>
                        </AlertDialog.Body>
                        <AlertDialog.Footer className="flex items-center justify-end gap-3 border-t-2 border-ink-1000 px-6 py-4">
                          <Button
                            type="button"
                            variant="outline"
                            size="md"
                            className="rounded-none border-2 font-bold tracking-wider uppercase"
                            onClick={() => setIsBulkDeleteOpen(false)}
                            isDisabled={bulkBusy}
                          >
                            {tItems("bulk.confirm_cancel")}
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="md"
                            className="rounded-none font-bold tracking-wider uppercase"
                            onClick={onBulkDeletePermanently}
                            isDisabled={bulkBusy}
                          >
                            {tItems("bulk.confirm_confirm")}
                          </Button>
                        </AlertDialog.Footer>
                      </AlertDialog.Dialog>
                    </AlertDialog.Container>
                  </AlertDialog.Backdrop>
                </AlertDialog>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {bulkError ? (
        <p
          role="alert"
          className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
        >
          {bulkError}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className={`overflow-auto border-2 border-ink-1000 bg-ink-0 ${VIEWPORT_HEIGHT_CLASS}`}
      >
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-ink-0">
            {headerGroups.map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b-2 border-ink-1000">
                {headerGroup.headers.map((header) => {
                  const columnId = header.column.id;
                  const isSelectCol = columnId === SELECT_COLUMN_ID;
                  const align =
                    (header.column.columnDef.meta as
                      | { align?: "start" | "end" }
                      | undefined)?.align === "end"
                      ? "text-right"
                      : "text-left";
                  const dropClass =
                    dragOverKey === columnId
                      ? "bg-ink-100 border-l-4 border-ink-1000"
                      : "";
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      style={isSelectCol ? { width: 40 } : undefined}
                      className={`px-3 py-3 font-mono text-[10px] tracking-widest uppercase text-ink-700 ${align} ${dropClass}`}
                    >
                      {isSelectCol ? (
                        flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )
                      ) : (
                        <div
                          draggable
                          onDragStart={handleDragStart(columnId)}
                          onDragOver={handleDragOver(columnId)}
                          onDragLeave={handleDragLeave}
                          onDrop={handleDrop(columnId)}
                          onDragEnd={handleDragEnd}
                          onClick={
                            canSort
                              ? header.column.getToggleSortingHandler()
                              : undefined
                          }
                          className={`flex cursor-grab items-center gap-2 active:cursor-grabbing ${
                            align === "text-right"
                              ? "justify-end"
                              : "justify-start"
                          } ${canSort ? "hover:text-ink-1000" : ""}`}
                        >
                          <span className="text-ink-400" aria-hidden>
                            ⋮⋮
                          </span>
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
                        </div>
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
                <td
                  colSpan={columnOrder.length}
                  style={{ height: paddingTop }}
                />
              </tr>
            ) : null}
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index]!;
              const selected = row.getIsSelected();
              return (
                <tr
                  key={row.id}
                  onClick={() =>
                    router.push(`/catalogues/${slug}/${row.original.id}`)
                  }
                  className={`cursor-pointer border-b border-ink-200 hover:bg-ink-50 ${
                    selected ? "bg-ink-100" : ""
                  }`}
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
                        className={`px-3 py-3 ${align}`}
                        onClick={(event) => {
                          if (cell.column.id === SELECT_COLUMN_ID) {
                            event.stopPropagation();
                          }
                        }}
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
                <td
                  colSpan={columnOrder.length}
                  style={{ height: paddingBottom }}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t-2 border-ink-1000 bg-ink-0 px-4 py-2 font-mono text-[10px] tracking-widest uppercase text-ink-600">
        <span>
          {loadedCount} loaded{hasNextPage ? " · scrolling loads more" : ""}
        </span>
        {isFetchingNextPage ? (
          <span>{tCommon("states.loading")}</span>
        ) : null}
      </div>
    </div>
  );
}
