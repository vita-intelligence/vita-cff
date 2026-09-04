"use client";

/**
 * Shared search + infinite-scroll shell for the NPD (vita-cff) portal.
 * Mirrors the PSP mobile hub's ``<InfiniteList>`` pattern so paged
 * portal surfaces (warehouse lots, dispatch-request history, and
 * anything else that goes long at scale) share the same UX:
 *
 *   * sticky search input at the top with a 250 ms debounce
 *   * IntersectionObserver sentinel that fetches the next page as the
 *     operator approaches the bottom
 *   * silent-degrade on network hiccups — the list keeps what it has
 *     and offers a tap-to-retry chip
 *   * request-sequence guard so a fast-typed query doesn't stitch
 *     stale results in
 *   * dedupe-by-uuid on append so an overlap between windows can't
 *     produce React key warnings
 *
 * Style is brutalist to match ``@/components/portal/brutalist`` —
 * heavy black borders, uppercase labels, tabular numbers. The
 * ``storageKey`` seeds sessionStorage so a quick detour to a detail
 * page and back keeps the operator's query.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, Search, X } from "lucide-react";

export interface PortalPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

interface Props<T> {
  readonly initialItems: readonly T[];
  readonly initialNextCursor: string | null;
  readonly fetchPage: (params: {
    q: string;
    cursor: string | null;
  }) => Promise<PortalPage<T>>;
  readonly renderItem: (item: T) => React.ReactNode;
  readonly emptyState: React.ReactNode;
  readonly searchPlaceholder: string;
  readonly storageKey: string;
}

const DEBOUNCE_MS = 250;
const SENTINEL_ROOT_MARGIN_PX = 400;

export function PortalInfiniteList<T extends { uuid: string }>({
  initialItems,
  initialNextCursor,
  fetchPage,
  renderItem,
  emptyState,
  searchPlaceholder,
  storageKey,
}: Props<T>) {
  const [q, setQ] = useState<string>(() => readStoredQuery(storageKey));
  const [items, setItems] = useState<readonly T[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialNextCursor);
  const [phase, setPhase] = useState<"idle" | "loading" | "error">("idle");
  const [initialised, setInitialised] = useState<boolean>(q === "");
  const requestSeqRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    writeStoredQuery(storageKey, q);
  }, [q, storageKey]);

  useEffect(() => {
    if (!initialised) {
      setInitialised(true);
      if (q === "") return;
    }

    const trimmed = q.trim();
    const seq = ++requestSeqRef.current;
    setPhase("loading");

    const timer = window.setTimeout(async () => {
      try {
        const page = await fetchPage({ q: trimmed, cursor: null });
        if (seq !== requestSeqRef.current) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setPhase("idle");
      } catch {
        if (seq !== requestSeqRef.current) return;
        setPhase("error");
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const loadMore = useCallback(async () => {
    if (cursor === null || phase === "loading") return;
    const seq = ++requestSeqRef.current;
    setPhase("loading");
    try {
      const page = await fetchPage({ q: q.trim(), cursor });
      if (seq !== requestSeqRef.current) return;
      setItems((prev) => appendUnique(prev, page.items));
      setCursor(page.next_cursor);
      setPhase("idle");
    } catch {
      if (seq !== requestSeqRef.current) return;
      setPhase("error");
    }
  }, [cursor, phase, q, fetchPage]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null || phase === "loading") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (!entry?.isIntersecting) return;
        void loadMore();
      },
      { rootMargin: `${SENTINEL_ROOT_MARGIN_PX}px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [cursor, phase, loadMore]);

  const showEmpty = useMemo(
    () => items.length === 0 && phase !== "loading",
    [items.length, phase],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 -mx-4 border-b-2 border-black bg-white px-4 py-2 sm:mx-0 sm:border-2">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500"
            aria-hidden
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-label={searchPlaceholder}
            className="block h-10 w-full border-2 border-black bg-white pl-8 pr-9 text-sm outline-none focus:bg-neutral-50"
          />
          {q ? (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-neutral-500 hover:text-black"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {showEmpty ? emptyState : items.map((item) => renderItem(item))}

      {cursor !== null && (
        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-4 text-[11px] text-neutral-500"
        >
          {phase === "loading" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </span>
          ) : phase === "error" ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              className="border-2 border-black bg-white px-3 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-neutral-100"
            >
              Tap to retry
            </button>
          ) : (
            <span className="uppercase tracking-widest">Scroll for more</span>
          )}
        </div>
      )}
      {cursor === null && items.length > 0 && phase !== "loading" && (
        <p className="pt-2 text-center text-[11px] uppercase tracking-widest text-neutral-500">
          End of list
        </p>
      )}
      {phase === "error" && cursor === null && (
        <p className="pt-2 text-center text-[11px] text-red-700">
          Couldn&rsquo;t update — check connection and try again.
        </p>
      )}
    </div>
  );
}

function appendUnique<T extends { uuid: string }>(
  prev: readonly T[],
  next: readonly T[],
): T[] {
  if (next.length === 0) return [...prev];
  const seen = new Set(prev.map((x) => x.uuid));
  const merged = [...prev];
  for (const item of next) {
    if (!seen.has(item.uuid)) merged.push(item);
  }
  return merged;
}

function readStoredQuery(storageKey: string): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

function writeStoredQuery(storageKey: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(storageKey, value);
    else window.sessionStorage.removeItem(storageKey);
  } catch {
    // Storage blocked (private mode etc) — no big deal.
  }
}
