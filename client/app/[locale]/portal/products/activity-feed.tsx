"use client";

/**
 * Unified activity feed for the NPD portal main page.
 *
 * Mirrors the web-site portal's ``/portal`` activity feed
 * (web-site/src/app/[locale]/portal/page.tsx) one-for-one so both
 * portals surface projects + RTG orders + samples in a single
 * filterable list. Type tabs + search + infinite scroll — the
 * backend endpoint (``/api/portal/activity``, keyset-paged) caps
 * paging at 500 rows so millions of rows demand filter/search
 * rather than blind paging.
 *
 * NPD's ``/portal/products`` used to render only the
 * ``/api/portal/dashboard`` ``products`` array — formulations +
 * CFFs, no samples. That's the gap this component closes.
 *
 * Rendered in NPD's brutalist style (black borders, orange accents)
 * so it blends with the surrounding page chrome. Href rewriting:
 * the activity endpoint emits web-site-style URLs
 * (``/portal/projects/<id>``); we rewrite to NPD's
 * ``/portal/products/<id>`` on the fly. Sample rows point at
 * ``/portal/samples/<id>`` which NPD doesn't have a page for yet,
 * so those render as non-clickable status cards for now.
 */

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FlaskConical,
  Layers,
  Loader2,
  PackageSearch,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";


// ---------------------------------------------------------------------------
// Wire types — must mirror server/apps/client_portal/api/activity_views.py
// ---------------------------------------------------------------------------

type ActivityKind = "project" | "rtg" | "sample";
type StatusTone = "attention" | "in_progress" | "success" | "muted" | "danger";

interface ActivityItem {
  readonly kind: ActivityKind;
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly subtitle: string;
  readonly status_key: string;
  readonly status_label: string;
  readonly status_tone: StatusTone;
  readonly href: string;
  readonly amount: string | null;
  readonly currency: string;
  readonly quantity: number | null;
  readonly updated_at: string;
  readonly needs_attention: boolean;
}

interface ActivityPage {
  readonly items: readonly ActivityItem[];
  readonly next_cursor: string | null;
  readonly counts: Record<"all" | ActivityKind, number>;
}


const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 250;

const KIND_TABS: ReadonlyArray<{
  key: "all" | ActivityKind;
  label: string;
}> = [
  { key: "all", label: "Everything" },
  { key: "project", label: "Custom" },
  { key: "rtg", label: "Ready-to-Go" },
  { key: "sample", label: "Samples" },
];

const KIND_ICON: Record<ActivityKind, React.ComponentType<{ className?: string }>> = {
  project: Sparkles,
  rtg: PackageSearch,
  sample: FlaskConical,
};

// Brutalist tone chips — solid backgrounds, black borders.
const TONE_CHIP: Record<StatusTone, string> = {
  attention: "bg-orange-500 text-black",
  in_progress: "bg-blue-100 text-blue-900",
  success: "bg-emerald-500 text-black",
  muted: "bg-neutral-200 text-neutral-700",
  danger: "bg-red-500 text-white",
};


export function ActivityFeed() {
  const [kind, setKind] = useState<"all" | ActivityKind>("all");
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState<readonly ActivityItem[]>([]);
  const [counts, setCounts] = useState<Record<"all" | ActivityKind, number>>({
    all: 0,
    project: 0,
    rtg: 0,
    sample: 0,
  });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Ref-guarded seq counter so a stale (kind, search) response can't
  // clobber fresh data mid-flight.
  const requestSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    (async () => {
      setPhase("loading");
      setErrorMessage(null);
      const page = await fetchPage({ kind, search: debouncedSearch, cursor: null });
      if (seq !== requestSeqRef.current) return;
      if (page === null) {
        setPhase("error");
        return;
      }
      if ("errorMessage" in page) {
        setErrorMessage(page.errorMessage);
        setPhase("error");
        return;
      }
      setItems(page.items);
      setCounts(page.counts);
      setNextCursor(page.next_cursor);
      setPhase("ready");
    })();
  }, [kind, debouncedSearch]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    const seq = requestSeqRef.current;
    const page = await fetchPage({ kind, search: debouncedSearch, cursor: nextCursor });
    if (seq !== requestSeqRef.current) {
      setLoadingMore(false);
      return;
    }
    if (page !== null && !("errorMessage" in page)) {
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    }
    setLoadingMore(false);
  }, [nextCursor, loadingMore, kind, debouncedSearch]);

  // IntersectionObserver sentinel — auto-fetch as the user scrolls.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || nextCursor === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !loadingMore) {
            void loadMore();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [nextCursor, loadMore, loadingMore]);

  return (
    <section className="mt-10">
      <TabStrip kind={kind} counts={counts} onChange={setKind} />
      <div className="mt-3">
        <SearchBar value={searchInput} onChange={setSearchInput} />
      </div>

      <div className="mt-6">
        {phase === "loading" ? (
          <FeedLoading />
        ) : phase === "error" ? (
          <FeedError message={errorMessage} />
        ) : items.length === 0 ? (
          <FeedEmpty kind={kind} hasSearch={debouncedSearch.length > 0} />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((item) => (
              <li key={`${item.kind}-${item.id}`}>
                <ActivityCard item={item} />
              </li>
            ))}
          </ul>
        )}

        {nextCursor !== null && phase === "ready" ? (
          <>
            <div ref={sentinelRef} aria-hidden className="h-1" />
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] transition-all hover:shadow-[3px_3px_0_0_black] disabled:opacity-60"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}


async function fetchPage(args: {
  kind: "all" | ActivityKind;
  search: string;
  cursor: string | null;
}): Promise<ActivityPage | { errorMessage: string } | null> {
  const params = new URLSearchParams();
  params.set("kind", args.kind);
  params.set("limit", String(PAGE_SIZE));
  if (args.cursor) params.set("cursor", args.cursor);
  if (args.search) params.set("q", args.search);
  try {
    const { data } = await apiClient.get<ActivityPage>(
      `/api/portal/activity/?${params.toString()}`,
    );
    return data;
  } catch (err: unknown) {
    return { errorMessage: portalErrorMessage(err) };
  }
}


function TabStrip({
  kind,
  counts,
  onChange,
}: {
  kind: "all" | ActivityKind;
  counts: Record<"all" | ActivityKind, number>;
  onChange: (next: "all" | ActivityKind) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Activity type"
      className="flex flex-wrap items-center gap-2"
    >
      {KIND_TABS.map((tab) => {
        const active = kind === tab.key;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={`inline-flex items-center gap-2 border-2 border-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] transition-all ${
              active
                ? "bg-black text-white"
                : "bg-white text-black hover:shadow-[3px_3px_0_0_black]"
            }`}
          >
            {tab.label}
            <span
              className={`inline-flex items-center border ${
                active
                  ? "border-white/40 bg-white/10 text-white"
                  : "border-black bg-neutral-100 text-black"
              } px-1.5 py-0.5 text-[9px] tabular-nums`}
            >
              {counts[tab.key] ?? 0}
            </span>
          </button>
        );
      })}
    </div>
  );
}


function SearchBar({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative w-full max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by code, product, or reference…"
        className="h-10 w-full border-2 border-black bg-white pl-9 pr-9 text-sm outline-none focus:shadow-[3px_3px_0_0_black]"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-black"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}


function ActivityCard({ item }: { item: ActivityItem }) {
  const Icon = KIND_ICON[item.kind];
  const toneClass = TONE_CHIP[item.status_tone];
  const amount = item.amount ? formatMoney(item.amount, item.currency) : null;
  // Activity endpoint emits web-site-style hrefs
  // (``/portal/projects/<uuid>`` / ``/portal/samples/<uuid>``). NPD
  // routes the shared per-formulation detail at ``/portal/products/<uuid>``
  // (rewrite project/RTG hrefs) and mirrors ``/portal/samples/<uuid>``
  // one-for-one, so sample hrefs pass through unchanged.
  let clickableHref: string | null = null;
  if (
    (item.kind === "project" || item.kind === "rtg") &&
    item.href.startsWith("/portal/projects/")
  ) {
    clickableHref = item.href.replace("/portal/projects/", "/portal/products/");
  } else if (item.kind === "sample" && item.href.startsWith("/portal/samples/")) {
    clickableHref = item.href;
  }

  const className = `group flex items-center gap-4 border-2 border-black bg-white p-4 transition-all sm:p-5 ${
    item.needs_attention ? "!bg-orange-50" : ""
  } ${clickableHref ? "hover:shadow-[4px_4px_0_0_black] cursor-pointer" : ""}`;

  const inner = (
    <>
      <span
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center border-2 border-black bg-white"
        aria-hidden
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-base font-black uppercase leading-tight tracking-tight">
            {item.title}
          </p>
          <span
            className={`inline-flex items-center gap-1 border border-black px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${toneClass}`}
          >
            {item.status_tone === "success" ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : item.status_tone === "attention" ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              <Clock className="h-3 w-3" />
            )}
            {item.status_label}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
          {item.code ? <span className="font-mono font-semibold">{item.code}</span> : null}
          {item.code && item.subtitle ? <span>·</span> : null}
          {item.subtitle ? <span>{item.subtitle}</span> : null}
          <span>·</span>
          <span>Updated {formatDate(item.updated_at)}</span>
        </p>
      </div>
      {amount ? (
        <p className="shrink-0 text-right text-base font-black tabular-nums">{amount}</p>
      ) : null}
    </>
  );

  if (clickableHref) {
    return (
      <a href={clickableHref} className={className}>
        {inner}
      </a>
    );
  }
  return <article className={className}>{inner}</article>;
}


function FeedLoading() {
  return (
    <div className="flex items-center justify-center gap-2 border-2 border-dashed border-black bg-neutral-50 p-10 text-sm text-neutral-600">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading your activity…
    </div>
  );
}


function FeedError({ message }: { message: string | null }) {
  return (
    <div className="border-2 border-black bg-red-50 p-6 text-sm">
      <p className="font-bold uppercase tracking-[0.18em]">Couldn&rsquo;t load your activity</p>
      <p className="mt-2 text-neutral-700">
        {message ?? "Refresh the page — if this persists, let us know."}
      </p>
    </div>
  );
}


function FeedEmpty({
  kind,
  hasSearch,
}: {
  kind: "all" | ActivityKind;
  hasSearch: boolean;
}) {
  if (hasSearch) {
    return (
      <div className="border-2 border-dashed border-black bg-neutral-50 p-10 text-center">
        <Search className="mx-auto h-8 w-8 text-neutral-400" aria-hidden />
        <p className="mt-3 text-sm text-neutral-700">
          Nothing matches your search — try fewer words.
        </p>
      </div>
    );
  }
  const copy: Record<"all" | ActivityKind, { title: string; body: string; icon: React.ComponentType<{ className?: string }> }> = {
    all: {
      title: "Your activity will show up here.",
      body: "Order a ready-to-go product, request a sample, or start a bespoke formulation and you'll see it below.",
      icon: Layers,
    },
    project: {
      title: "No custom formulations yet.",
      body: "Bring us a brief and we'll open a bespoke project you can track end-to-end from concept to launch.",
      icon: Sparkles,
    },
    rtg: {
      title: "No ready-to-go orders yet.",
      body: "Browse the catalogue and place an order — it'll land here as a draft quote for you to sign.",
      icon: PackageSearch,
    },
    sample: {
      title: "No sample requests yet.",
      body: "Pay for a sample from any ready-to-go product and it'll show up here while we prep the kit.",
      icon: FlaskConical,
    },
  };
  const c = copy[kind];
  const Icon = c.icon;
  return (
    <div className="border-2 border-dashed border-black bg-neutral-50 p-10 text-center">
      <Icon className="mx-auto h-8 w-8 text-neutral-400" aria-hidden />
      <p className="mt-3 text-base font-black uppercase tracking-tight">{c.title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-neutral-600">{c.body}</p>
    </div>
  );
}


function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency || ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}


function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}
