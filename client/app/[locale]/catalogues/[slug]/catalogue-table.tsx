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
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Minus,
  Search,
  X,
} from "lucide-react";
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

import { Chip } from "@/components/ui/chip";
import { useRouter } from "@/i18n/navigation";
import { useDebouncedValue } from "@/lib/utils";
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

// Fixed widths keep the table from re-laying itself out as new
// pages paginate in. Tuned for readability: primary identifiers get
// real estate, secondary fields are clamped. Dynamic attributes
// size by data type below.
const COLUMN_WIDTHS: Record<string, number> = {
  [SELECT_COLUMN_ID]: 44,
  name: 320,
  internal_code: 140,
  unit: 96,
  base_price: 120,
  updated_at: 140,
  status: 112,
};

// Horizontal scroll nudge — one click moves the viewport roughly
// one short column so the user can walk through columns without
// overshooting a data-dense run.
const SCROLL_STEP_PX = 280;

function dynamicColumnWidth(dataType: AttributeDefinitionDto["data_type"]): number {
  switch (dataType) {
    case "boolean":
      return 88;
    case "date":
      return 140;
    case "number":
      return 128;
    case "single_select":
      return 160;
    case "multi_select":
      return 220;
    case "text":
    default:
      return 200;
  }
}

function columnOrderStorageKey(slug: string): string {
  return `vita.catalogues.${slug}.columnOrder`;
}

function dynamicKey(definitionKey: string): string {
  return `${DYNAMIC_PREFIX}${definitionKey}`;
}

function RowCheckbox({
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
      className={`relative inline-flex h-4 w-4 items-center justify-center rounded transition-colors ${
        filled
          ? "bg-orange-500 ring-1 ring-inset ring-orange-600"
          : "bg-ink-0 ring-1 ring-inset ring-ink-300"
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
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded focus:outline-none"
      />
      {checked ? (
        <Check
          className="pointer-events-none relative h-3 w-3 text-ink-0"
          strokeWidth={3}
          aria-hidden
        />
      ) : indeterminate ? (
        <Minus
          className="pointer-events-none relative h-3 w-3 text-ink-0"
          strokeWidth={3}
          aria-hidden
        />
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
        return <span className="text-sm text-ink-300">—</span>;
      }
      switch (definition.data_type) {
        case "text":
          return (
            <span className="text-sm text-ink-700">{String(raw)}</span>
          );
        case "number":
          return (
            <span className="text-sm tabular-nums text-ink-700">
              {typeof raw === "number"
                ? priceFormatter.format(raw)
                : String(raw)}
            </span>
          );
        case "boolean":
          return raw ? (
            <Chip tone="success">Yes</Chip>
          ) : (
            <Chip tone="neutral">No</Chip>
          );
        case "date":
          return (
            <span className="text-sm text-ink-700">
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
            <span className="text-sm text-ink-700">
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
                  <Chip key={value} tone="neutral">
                    {option?.label ?? value}
                  </Chip>
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

  // Controlled search state. ``searchInput`` tracks keystrokes so the
  // field feels responsive; ``debouncedSearch`` is what we forward to
  // the query hook so we don't fire a fetch per keypress. 300 ms lands
  // right on the sweet spot between "responsive" and "spammy" — any
  // faster and a fast typist triggers several overlapping fetches.
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const normalisedSearch = debouncedSearch.trim();

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
    search: normalisedSearch || undefined,
    // Only seed the first page when there's no search — otherwise the
    // SSR snapshot would briefly flash unfiltered results before the
    // search query refetches.
    initialFirstPage: normalisedSearch ? null : initialFirstPage,
  });

  const flatItems: readonly ItemDto[] = useMemo(
    () => data?.pages.flatMap((page) => [...page.results]) ?? [],
    [data],
  );

  const columns = useMemo<ColumnDef<ItemDto>[]>(() => {
    const selectColumn: ColumnDef<ItemDto> = {
      id: SELECT_COLUMN_ID,
      size: COLUMN_WIDTHS[SELECT_COLUMN_ID],
      enableSorting: false,
      header: ({ table }) => (
        <div className="flex items-center justify-center">
          <RowCheckbox
            ariaLabel="Select all"
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected()}
            onChange={() => table.toggleAllRowsSelected()}
          />
        </div>
      ),
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <RowCheckbox
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
        size: COLUMN_WIDTHS.name,
        cell: (ctx) => (
          <span className="block truncate text-sm font-medium text-ink-1000">
            {ctx.row.original.name}
          </span>
        ),
      },
      {
        id: "internal_code",
        accessorKey: "internal_code",
        header: tItems("columns.internal_code"),
        enableSorting: true,
        size: COLUMN_WIDTHS.internal_code,
        cell: (ctx) => (
          <span className="block truncate text-xs text-ink-500">
            {ctx.row.original.internal_code || "—"}
          </span>
        ),
      },
      {
        id: "unit",
        accessorKey: "unit",
        header: tItems("columns.unit"),
        enableSorting: false,
        size: COLUMN_WIDTHS.unit,
        cell: (ctx) => (
          <span className="block truncate text-sm text-ink-700">
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
        size: COLUMN_WIDTHS.base_price,
        cell: (ctx) => (
          <span className="block truncate text-sm tabular-nums text-ink-1000">
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
        size: COLUMN_WIDTHS.updated_at,
        cell: (ctx) => (
          <span className="block truncate text-sm text-ink-500">
            {dateFormatter.format(new Date(ctx.row.original.updated_at))}
          </span>
        ),
      },
      {
        id: "status",
        header: tItems("columns.status"),
        enableSorting: false,
        size: COLUMN_WIDTHS.status,
        cell: (ctx) => {
          const archived = ctx.row.original.is_archived;
          return archived ? (
            <Chip tone="neutral">{tItems("status.archived")}</Chip>
          ) : (
            <Chip tone="success">{tItems("status.active")}</Chip>
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
        size: dynamicColumnWidth(d.data_type),
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

  const headerGroups = table.getHeaderGroups();
  const loadedCount = rows.length;
  const isEmpty = !isFetching && rows.length === 0;
  const hasActiveSearch = normalisedSearch.length > 0;

  // Horizontal-scroll affordance state: observe the viewport and
  // flip `canScroll{Left,Right}` so the chevron buttons (and an
  // optional edge fade) reflect whether there's more table off
  // screen. The 4 px slack tolerates sub-pixel rounding.
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 4);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [rows.length, columnOrder, isEmpty]);

  const scrollByStep = useCallback((direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * SCROLL_STEP_PX, behavior: "smooth" });
  }, []);

  const tableTotalWidth = table.getTotalSize();

  const searchBar = (
    <div className="flex items-center gap-2">
      <div className="relative flex h-10 flex-1 items-center">
        <Search
          aria-hidden
          strokeWidth={2.25}
          className="pointer-events-none absolute left-3 h-4 w-4 text-ink-400"
        />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={tItems("search.placeholder")}
          aria-label={tItems("search.placeholder")}
          className="h-full w-full rounded-lg bg-ink-0 pl-10 pr-10 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none transition-shadow placeholder:text-ink-400 focus:ring-2 focus:ring-orange-400 [&::-webkit-search-cancel-button]:hidden"
        />
        {searchInput ? (
          <button
            type="button"
            aria-label={tItems("search.clear")}
            onClick={() => setSearchInput("")}
            className="absolute right-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        ) : null}
      </div>
      {canScrollLeft || canScrollRight ? (
        <div className="hidden items-center gap-1 md:flex">
          <button
            type="button"
            aria-label={tItems("scroll.previous")}
            onClick={() => scrollByStep(-1)}
            disabled={!canScrollLeft}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-ink-0 text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={tItems("scroll.next")}
            onClick={() => scrollByStep(1)}
            disabled={!canScrollRight}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-ink-0 text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {searchBar}

      {isEmpty ? (
        <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tCommon("states.empty")}
          </p>
          <h2 className="mt-2 text-lg font-semibold text-ink-1000">
            {hasActiveSearch
              ? tItems("search.no_match_title", { query: normalisedSearch })
              : emptyTitle}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {hasActiveSearch ? tItems("search.no_match_hint") : emptyHint}
          </p>
        </div>
      ) : null}

      {isEmpty ? null : selectionCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink-1000 px-4 py-3 text-ink-0 shadow-sm">
          <div className="flex items-center gap-3">
            <Chip tone="orange">
              {tItems("bulk.selected_count", { count: selectionCount })}
            </Chip>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-ink-200 hover:bg-ink-700/60 hover:text-ink-0 disabled:opacity-50"
              onClick={clearSelection}
              disabled={bulkBusy}
            >
              <X className="h-3.5 w-3.5" />
              {tItems("bulk.clear")}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canAdmin && !viewArchived ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-lg bg-ink-0/10 px-3 text-sm font-medium text-ink-0 ring-1 ring-inset ring-ink-0/20 hover:bg-ink-0/15"
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
                  className="h-9 rounded-lg bg-ink-0/10 px-3 text-sm font-medium text-ink-0 ring-1 ring-inset ring-ink-0/20 hover:bg-ink-0/15"
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
                      className="h-9 rounded-lg bg-danger px-3 text-sm font-medium text-ink-0 hover:bg-danger/90"
                      isDisabled={bulkBusy}
                    >
                      {tItems("bulk.delete_permanently")}
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Backdrop>
                    <AlertDialog.Container size="md">
                      <AlertDialog.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 text-ink-1000 shadow-lg ring-1 ring-ink-200">
                        <AlertDialog.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                          <AlertDialog.Heading className="text-base font-semibold text-ink-1000">
                            {tItems("bulk.confirm_title", {
                              count: selectionCount,
                            })}
                          </AlertDialog.Heading>
                        </AlertDialog.Header>
                        <AlertDialog.Body className="px-6 py-6">
                          <p className="text-sm text-ink-500">
                            {tItems("bulk.confirm_body")}
                          </p>
                        </AlertDialog.Body>
                        <AlertDialog.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                          <Button
                            type="button"
                            variant="outline"
                            size="md"
                            className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                            onClick={() => setIsBulkDeleteOpen(false)}
                            isDisabled={bulkBusy}
                          >
                            {tItems("bulk.confirm_cancel")}
                          </Button>
                          <Button
                            type="button"
                            variant="danger"
                            size="md"
                            className="h-10 rounded-lg bg-danger px-4 text-sm font-medium text-ink-0 hover:bg-danger/90"
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

      {bulkError && !isEmpty ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {bulkError}
        </p>
      ) : null}

      {isEmpty ? null : (
      <>
      <div className="overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
        <div
          ref={scrollRef}
          className={`overflow-auto ${VIEWPORT_HEIGHT_CLASS}`}
        >
          <table
            className="border-collapse"
            style={{
              tableLayout: "fixed",
              width: `${tableTotalWidth}px`,
              minWidth: "100%",
            }}
          >
            <colgroup>
              {table.getVisibleLeafColumns().map((col) => (
                <col key={col.id} style={{ width: `${col.getSize()}px` }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-ink-0/95 backdrop-blur">
              {headerGroups.map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-ink-200">
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
                        ? "bg-orange-50 border-l-2 border-orange-500"
                        : "";
                    const canSort = header.column.getCanSort();
                    const sortDir = header.column.getIsSorted();
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        className={`overflow-hidden px-3 py-3 text-xs font-medium uppercase tracking-wide text-ink-500 ${align} ${dropClass}`}
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
                            className={`group flex min-w-0 cursor-grab items-center gap-1.5 active:cursor-grabbing ${
                              align === "text-right"
                                ? "ml-auto justify-end"
                                : "justify-start"
                            } ${canSort ? "transition-colors hover:text-ink-1000" : ""}`}
                          >
                            <GripVertical
                              className="h-3 w-3 shrink-0 text-ink-300 opacity-0 transition-opacity group-hover:opacity-100"
                              aria-hidden
                            />
                            <span className="truncate">
                              {flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                            </span>
                            {canSort ? (
                              sortDir === "asc" ? (
                                <ArrowUp className="h-3 w-3 shrink-0 text-ink-700" />
                              ) : sortDir === "desc" ? (
                                <ArrowDown className="h-3 w-3 shrink-0 text-ink-700" />
                              ) : (
                                <ArrowUpDown className="h-3 w-3 shrink-0 text-ink-300" />
                              )
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
                    className={`cursor-pointer border-b border-ink-100 transition-colors hover:bg-ink-50 ${
                      selected ? "bg-orange-50/60" : ""
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
                          className={`overflow-hidden whitespace-nowrap px-3 py-3 align-middle ${align}`}
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
      </div>

      <div className="flex items-center justify-between px-1 text-xs text-ink-500">
        <span>
          {tItems("row_count", { count: loadedCount })}
          {hasActiveSearch ? ` · ${tItems("search.match_suffix")}` : ""}
          {hasNextPage ? ` · ${tItems("scroll_hint")}` : ""}
        </span>
        {isFetchingNextPage ? (
          <span>{tCommon("states.loading")}</span>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
}
