"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Search,
  UserRound,
} from "lucide-react";

import { Link } from "@/i18n/navigation";
import { useLabelDesigns } from "@/services/label-design";
import type {
  LabelDesignListItemDto,
  LabelDesignStatus,
} from "@/services/label-design/types";


// ---------------------------------------------------------------------------
// Tabs config — order matches the workflow so staff reading the page
// top-to-bottom follow the natural progression. ``all`` is the
// catch-all and always sits first; the pre-design tab batches the
// two statuses that don't belong to anybody on the labelling team
// yet (finance / customer).
// ---------------------------------------------------------------------------


type TabKey =
  | "all"
  | "pre_design"
  | LabelDesignStatus;


interface TabDef {
  readonly key: TabKey;
  readonly label: string;
  /** Underlying ``status`` query param sent to the API. ``null``
   *  means "no status filter" (covered by counts-from-the-server
   *  aggregation). */
  readonly statusParam: LabelDesignStatus | null;
  /** Statuses included in the count pill — used for tabs that
   *  visually group several statuses (``all``, ``pre_design``). */
  readonly aggregates: ReadonlyArray<LabelDesignStatus> | "all";
}


const TABS: ReadonlyArray<TabDef> = [
  { key: "all", label: "All", statusParam: null, aggregates: "all" },
  {
    key: "pre_design",
    label: "Pre-design",
    statusParam: null, // handled client-side via the counts map
    aggregates: ["payment_pending", "label_path_pending"],
  },
  {
    key: "design_preferences_pending",
    label: "Awaiting brief",
    statusParam: "design_preferences_pending",
    aggregates: ["design_preferences_pending"],
  },
  {
    key: "design_in_progress",
    label: "In design",
    statusParam: "design_in_progress",
    aggregates: ["design_in_progress"],
  },
  {
    key: "scientist_review",
    label: "Scientist",
    statusParam: "scientist_review",
    aggregates: ["scientist_review"],
  },
  {
    key: "director_review",
    label: "Director",
    statusParam: "director_review",
    aggregates: ["director_review"],
  },
  {
    key: "customer_approval",
    label: "Customer",
    statusParam: "customer_approval",
    aggregates: ["customer_approval"],
  },
  {
    key: "label_approved",
    label: "Approved",
    statusParam: "label_approved",
    aggregates: ["label_approved"],
  },
  {
    key: "on_hold",
    label: "On hold",
    statusParam: "on_hold",
    aggregates: ["on_hold"],
  },
];


const STATUS_LABELS: Record<LabelDesignStatus, string> = {
  payment_pending: "Payment pending",
  label_path_pending: "Awaiting path",
  design_preferences_pending: "Awaiting brief",
  design_in_progress: "In design",
  scientist_review: "Scientist review",
  director_review: "Director review",
  customer_approval: "Customer approval",
  label_approved: "Approved",
  on_hold: "On hold",
};


// ---------------------------------------------------------------------------
// Page entry — tabs, search box, table, load-more.
// ---------------------------------------------------------------------------


export function LabellingQueue({
  orgId,
  canReviewScientist = false,
  canReviewDirector = false,
  canDesign = false,
}: {
  orgId: string;
  canReviewScientist?: boolean;
  canReviewDirector?: boolean;
  canDesign?: boolean;
}) {
  // Smart default tab — drop the user on the queue that matches
  // their role so the "lazy director" sees their pile straight
  // away without clicking around. Order of precedence puts the
  // narrowest capability first: a director-only user lands on
  // "Director", a scientist-only on "Scientist", a designer on
  // "In design", and everyone else (owner, mixed cap) still
  // sees "All" which is the broadest view.
  const defaultTab: TabKey =
    canReviewDirector && !canReviewScientist && !canDesign
      ? "director_review"
      : canReviewScientist && !canReviewDirector && !canDesign
        ? "scientist_review"
        : canDesign && !canReviewScientist && !canReviewDirector
          ? "design_in_progress"
          : "all";
  const [tab, setTab] = useState<TabKey>(defaultTab);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search so a 12-character query doesn't fire 12
  // backend requests. 250ms is the sweet spot between snappy and
  // wasteful.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // ``TABS[0]`` is the "All" tab — guaranteed present at module
  // load — so the non-null assertion here is safe and only exists
  // to placate TS's noUncheckedIndexedAccess.
  const activeTab = TABS.find((t) => t.key === tab) ?? TABS[0]!;

  // ``pre_design`` is the only tab where one HTTP call won't do —
  // it spans two statuses and the API only accepts one. We issue
  // two queries and stitch them client-side, paginated each side.
  const isPreDesign = tab === "pre_design";

  const primary = useLabelDesigns(orgId, {
    status: isPreDesign ? "payment_pending" : (activeTab.statusParam ?? undefined),
    search,
  });
  const secondary = useLabelDesigns(orgId, {
    status: "label_path_pending",
    search,
    enabled: isPreDesign,
  });

  // ``counts_by_status`` comes from the search-filtered set so the
  // tab pills reflect the current search, not the full corpus.
  const counts = primary.data?.pages?.[0]?.counts_by_status ?? {};
  const totalAll = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);

  const tabCount = (def: TabDef): number => {
    if (def.aggregates === "all") return totalAll;
    return def.aggregates.reduce((s, k) => s + (counts[k] ?? 0), 0);
  };

  const primaryItems = (primary.data?.pages ?? []).flatMap((p) => p.items);
  const secondaryItems = isPreDesign
    ? (secondary.data?.pages ?? []).flatMap((p) => p.items)
    : [];
  // Combine + sort by ``updated_at`` so the merged pre-design list
  // matches the single-tab ordering staff are used to.
  const items: ReadonlyArray<LabelDesignListItemDto> = isPreDesign
    ? [...primaryItems, ...secondaryItems].sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      )
    : primaryItems;

  const isLoading =
    primary.isLoading || (isPreDesign && secondary.isLoading);
  const error = primary.error ?? (isPreDesign ? secondary.error : null);
  const canLoadMore = isPreDesign
    ? primary.hasNextPage || secondary.hasNextPage
    : primary.hasNextPage;
  const isLoadingMore =
    primary.isFetchingNextPage ||
    (isPreDesign && secondary.isFetchingNextPage);
  const loadMore = () => {
    if (primary.hasNextPage && !primary.isFetchingNextPage) {
      primary.fetchNextPage();
    }
    if (isPreDesign && secondary.hasNextPage && !secondary.isFetchingNextPage) {
      secondary.fetchNextPage();
    }
  };

  return (
    <section className="mt-6 flex flex-col gap-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-1000">Labelling</h1>
          <p className="text-xs text-ink-500">
            Every project that has reached the label-design phase. Filter by
            status or search by project code / product name.
          </p>
        </div>
        <SearchBox value={searchInput} onChange={setSearchInput} />
      </header>

      <Tabs
        tabs={TABS}
        active={tab}
        onChange={setTab}
        countFor={tabCount}
      />

      {isLoading ? (
        <p className="inline-flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      ) : error ? (
        <p className="text-sm text-danger">Couldn’t load the queue.</p>
      ) : items.length === 0 ? (
        <EmptyState search={search} />
      ) : (
        <QueueTable items={items} />
      )}

      {canLoadMore ? (
        <div className="mt-2 flex justify-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={isLoadingMore}
            className="inline-flex items-center gap-2 rounded-md border border-ink-200 bg-ink-0 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Load more
          </button>
        </div>
      ) : null}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Search input with the standard icon placement.
// ---------------------------------------------------------------------------


function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input
        type="search"
        placeholder="Project code or product name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border border-ink-200 bg-ink-0 pl-10 pr-3 text-sm text-ink-1000 placeholder:text-ink-400 focus:border-ink-400 focus:outline-none"
      />
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tab strip with count pills.
// ---------------------------------------------------------------------------


function Tabs({
  tabs,
  active,
  onChange,
  countFor,
}: {
  tabs: ReadonlyArray<TabDef>;
  active: TabKey;
  onChange: (k: TabKey) => void;
  countFor: (def: TabDef) => number;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-ink-200">
      {tabs.map((t) => {
        const isActive = active === t.key;
        const count = countFor(t);
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${
              isActive
                ? "border-ink-1000 text-ink-1000"
                : "border-transparent text-ink-500 hover:text-ink-1000"
            }`}
          >
            {t.label}
            <span
              className={`inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                isActive
                  ? "bg-ink-1000 text-ink-0"
                  : "bg-ink-100 text-ink-700"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Table — six columns, optimised for scanning.
// ---------------------------------------------------------------------------


function QueueTable({ items }: { items: ReadonlyArray<LabelDesignListItemDto> }) {
  return (
    <div className="overflow-x-auto rounded-md border border-ink-200">
      <table className="min-w-full divide-y divide-ink-200 text-sm">
        <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Project</th>
            <th className="px-3 py-2 text-left font-semibold">Product</th>
            <th className="px-3 py-2 text-left font-semibold">Status</th>
            <th className="px-3 py-2 text-left font-semibold">Age</th>
            <th className="px-3 py-2 text-left font-semibold">Designer</th>
            <th className="px-3 py-2 text-left font-semibold">Flags</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100 bg-ink-0">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}


function QueueRow({ item }: { item: LabelDesignListItemDto }) {
  const ageDays = useMemo(() => {
    const ms = Date.now() - new Date(item.updated_at).getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
  }, [item.updated_at]);
  return (
    <tr className="hover:bg-ink-50">
      <td className="px-3 py-2 text-ink-1000">
        <Link
          href={`/labelling/${item.id}`}
          className="font-semibold hover:underline"
        >
          {item.formulation_code || "—"}
        </Link>
        {/* Spec code suffix — multi-spec projects produce one
            row per spec sharing the same formulation code, so
            this is what tells a designer "this row is the Alex
            Capsules MA22222 label, not the MA22223 label". */}
        {item.specification_sheet_code ? (
          <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-ink-500">
            · {item.specification_sheet_code}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-ink-700">{item.formulation_name || "—"}</td>
      <td className="px-3 py-2">
        <StatusChip status={item.status} />
      </td>
      <td className="px-3 py-2 text-ink-700 tabular-nums">{ageDays}d</td>
      <td className="px-3 py-2 text-ink-700">
        {item.assigned_designer_email ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <UserRound className="h-3 w-3 text-ink-400" />
            {item.assigned_designer_email}
          </span>
        ) : (
          <span className="text-xs text-ink-400">Unassigned</span>
        )}
      </td>
      <td className="px-3 py-2">
        {item.rejection_count > 0 ? (
          <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-700">
            <AlertTriangle className="h-3 w-3" />
            {item.rejection_count} rejection
            {item.rejection_count > 1 ? "s" : ""}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/labelling/${item.id}`}
          aria-label="Open workspace"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-1000"
        >
          <ChevronRight className="h-4 w-4" />
        </Link>
      </td>
    </tr>
  );
}


function StatusChip({ status }: { status: LabelDesignStatus }) {
  const tone =
    status === "label_approved"
      ? "bg-emerald-100 text-emerald-900"
      : status === "on_hold"
        ? "bg-rose-100 text-rose-900"
        : status === "customer_approval"
          ? "bg-purple-100 text-purple-900"
          : status === "director_review"
            ? "bg-orange-100 text-orange-900"
            : status === "scientist_review"
              ? "bg-amber-100 text-amber-900"
              : status === "design_in_progress"
                ? "bg-blue-100 text-blue-900"
                : "bg-ink-100 text-ink-700";
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}


function EmptyState({ search }: { search: string }) {
  return (
    <div className="rounded-md border border-dashed border-ink-200 bg-ink-50 px-4 py-8 text-center">
      <p className="text-sm font-semibold text-ink-700">
        {search ? `Nothing matches "${search}"` : "Nothing here yet"}
      </p>
      <p className="mt-1 text-xs text-ink-500">
        {search
          ? "Try a different code or product name."
          : "Projects that reach the label-design phase will show up here."}
      </p>
    </div>
  );
}
