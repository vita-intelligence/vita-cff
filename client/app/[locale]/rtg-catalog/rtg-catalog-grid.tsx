"use client";

/**
 * Client-side grid for the staff RTG Catalog page.
 *
 * Built for scale — every row renders from a cursor-paginated infinite
 * query keyed on ``(search, publishState)``. Switching tabs or typing
 * in the search box re-hits the server; the client never has to hold
 * more than the last few fetched pages in memory. Big-O behaviour:
 *
 * * Server query — a single indexed ``.filter(organization,
 *   project_type='ready_to_go', is_rtg_published=?)`` plus an
 *   optional ``icontains`` on ``name``/``code``. O(log N) index seek +
 *   O(page_size) rows returned. Cursor pagination keeps subsequent
 *   pages cheap — no ``OFFSET`` skew as N grows.
 * * Client render — O(pages_fetched × page_size) DOM nodes. An
 *   ``IntersectionObserver`` sentinel triggers ``fetchNextPage`` when
 *   the user scrolls near the end, so nothing loads until it needs
 *   to.
 * * Tab counts — separate ``rtg-catalog-counts`` endpoint returns
 *   ``{all, published, unpublished}`` in one round-trip so the pills
 *   don't force a full list walk. Constant work per call.
 *
 * The card click routes to ``/formulations/<id>`` — the RTG catalog
 * editing surface (:class:`RTGCatalogPanel`) is embedded on the
 * project overview page, so we send the manager straight there.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  EyeOff,
  ImageIcon,
  Loader2,
  Package,
  Search,
  X,
} from "lucide-react";

import { Link } from "@/i18n/navigation";
import { useDebouncedValue } from "@/lib/utils/use-debounced-value";
import {
  useInfiniteFormulations,
  useRtgCatalogCounts,
  type FormulationDto,
  type PaginatedFormulationsDto,
} from "@/services/formulations";


type FilterKey = "all" | "published" | "unpublished";

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 60;


interface Props {
  readonly orgId: string;
  readonly initialFirstPage: PaginatedFormulationsDto | null;
  readonly canWrite: boolean;
}


export function RTGCatalogGrid({ orgId, initialFirstPage, canWrite }: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, SEARCH_DEBOUNCE_MS);

  // Map the tab into the backend param. ``undefined`` = "all" (no
  // filter), true / false = the explicit publish state.
  const isRtgPublished =
    filter === "published"
      ? true
      : filter === "unpublished"
        ? false
        : undefined;

  const counts = useRtgCatalogCounts(orgId);

  const list = useInfiniteFormulations(orgId, {
    ordering: "-updated_at",
    pageSize: PAGE_SIZE,
    projectType: "ready_to_go",
    includePublishedRtg: true,
    isRtgPublished,
    search: debouncedSearch,
    // Only hydrate from the SSR seed when the user hasn't touched
    // filters yet — a search / tab change invalidates its shape.
    initialFirstPage:
      filter === "all" && debouncedSearch.trim() === ""
        ? initialFirstPage
        : null,
  });

  const items = useMemo<FormulationDto[]>(
    () => list.data?.pages.flatMap((p) => p.results) ?? [],
    [list.data],
  );

  // Sentinel-driven infinite scroll. The observer re-runs when the
  // fetch state flips so a new sentinel gets picked up after each
  // page loads.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (!list.hasNextPage || list.isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void list.fetchNextPage();
        }
      },
      { root: null, rootMargin: "240px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [list, items.length]);

  const totalAll = counts.data?.all ?? 0;
  const totalPublished = counts.data?.published ?? 0;
  const totalUnpublished = counts.data?.unpublished ?? 0;

  const emptyBecauseNoRTG =
    !list.isLoading &&
    items.length === 0 &&
    debouncedSearch.trim() === "" &&
    totalAll === 0;

  if (emptyBecauseNoRTG) {
    return <EmptyState canWrite={canWrite} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <FilterTabs
          filter={filter}
          onChange={setFilter}
          counts={{
            all: totalAll,
            published: totalPublished,
            unpublished: totalUnpublished,
          }}
        />
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          busy={list.isFetching && !list.isFetchingNextPage}
        />
      </div>

      {list.isLoading && items.length === 0 ? (
        <div className="flex items-center justify-center rounded-2xl bg-ink-50 py-16 text-sm text-ink-500 ring-1 ring-ink-200">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading catalog…
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-2xl bg-ink-50 p-8 text-center text-sm text-ink-500 ring-1 ring-ink-200">
          {debouncedSearch.trim()
            ? `No SKUs match “${debouncedSearch.trim()}”.`
            : "No SKUs match the current filter."}
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((f) => (
              <CatalogCard key={f.id} formulation={f} />
            ))}
          </div>
          {list.hasNextPage ? (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-6 text-xs text-ink-500"
            >
              {list.isFetchingNextPage ? (
                <>
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  Loading more…
                </>
              ) : (
                <span aria-hidden />
              )}
            </div>
          ) : items.length > PAGE_SIZE ? (
            <p className="py-4 text-center text-xs text-ink-500">
              End of catalog.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}


function SearchBox({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  busy: boolean;
}) {
  return (
    <div className="relative w-full sm:w-72">
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search code or name…"
        className="h-10 w-full rounded-full bg-ink-50 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-400"
      />
      {busy && value ? (
        <Loader2
          aria-hidden
          className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-orange-500"
        />
      ) : value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}


function FilterTabs({
  filter,
  onChange,
  counts,
}: {
  filter: FilterKey;
  onChange: (next: FilterKey) => void;
  counts: Record<FilterKey, number>;
}) {
  const tabs: readonly { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "published", label: "Published" },
    { key: "unpublished", label: "Unpublished" },
  ];
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full bg-ink-50 p-1 ring-1 ring-ink-200"
      role="tablist"
    >
      {tabs.map((t) => {
        const active = filter === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-white text-ink-1000 shadow-sm"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            <span>{t.label}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                active
                  ? "bg-ink-100 text-ink-700"
                  : "bg-white text-ink-500"
              }`}
            >
              {counts[t.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}


function CatalogCard({ formulation }: { formulation: FormulationDto }) {
  const {
    id,
    code,
    name,
    is_rtg_published,
    rtg_display_name,
    rtg_short_description,
    rtg_hero_image,
    rtg_base_price,
    rtg_currency_code,
    rtg_moq,
    rtg_packaging_options,
  } = formulation;

  const cardTitle = rtg_display_name.trim() || name;
  const priceLabel = formatPrice(rtg_base_price, rtg_currency_code);

  return (
    <Link
      href={`/formulations/${id}`}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200 transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[4/3] w-full bg-ink-50">
        {rtg_hero_image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={rtg_hero_image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-300">
            <ImageIcon className="h-10 w-10" aria-hidden />
          </div>
        )}
        <span
          className={`absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            is_rtg_published
              ? "bg-emerald-100 text-emerald-800"
              : "bg-ink-100 text-ink-600"
          }`}
        >
          {is_rtg_published ? (
            <>
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Published
            </>
          ) : (
            <>
              <EyeOff className="h-3 w-3" aria-hidden />
              Unpublished
            </>
          )}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            {code || "—"}
          </p>
          <h2 className="mt-0.5 line-clamp-2 text-base font-semibold tracking-tight text-ink-1000 group-hover:text-orange-700">
            {cardTitle}
          </h2>
        </div>
        {rtg_short_description ? (
          <p className="line-clamp-2 text-xs text-ink-600">
            {rtg_short_description}
          </p>
        ) : (
          <p className="text-xs italic text-ink-400">
            No short description yet.
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          {priceLabel ? (
            <span className="rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              {priceLabel}
            </span>
          ) : null}
          {rtg_moq ? (
            <span className="rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              MOQ {rtg_moq}
            </span>
          ) : null}
          {rtg_packaging_options.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              <Package className="h-3 w-3" aria-hidden />
              {rtg_packaging_options.length} pack
              {rtg_packaging_options.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}


function EmptyState({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="rounded-2xl bg-ink-50 p-10 text-center ring-1 ring-ink-200">
      <p className="text-sm font-medium text-ink-800">
        No Ready-to-Go products yet.
      </p>
      <p className="mt-2 text-xs text-ink-500">
        {canWrite ? (
          <>
            Click <span className="font-semibold">New RTG product</span>{" "}
            above to add one, or open an existing project on{" "}
            <Link
              href="/formulations"
              className="text-orange-700 underline-offset-2 hover:underline"
            >
              Formulations
            </Link>{" "}
            and switch its type to Ready-to-Go.
          </>
        ) : (
          <>Ask a project owner to publish some RTG SKUs to your catalog.</>
        )}
      </p>
    </div>
  );
}


function formatPrice(
  amount: string | null,
  currency: string,
): string | null {
  if (!amount) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(parsed);
  } catch {
    return `${currency} ${parsed.toFixed(2)}`;
  }
}
