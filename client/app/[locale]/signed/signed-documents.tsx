"use client";

import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileSignature,
  Inbox,
  Paperclip,
  Plus,
  Search,
  Send,
  Stamp,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { Link } from "@/i18n/navigation";
import {
  useInfiniteProposals,
  type ProposalListItemDto,
} from "@/services/proposals";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";

import { BulkCreateProposalModal } from "./bulk-create-proposal-modal";
import { SpecCreateProposalModal } from "./spec-create-proposal-modal";


type TopTab = "proposals" | "specifications";
type CardMode = "approved" | "sent" | "signed";


const TOP_TAB_STORAGE_KEY = "signed:top_tab";


/**
 * Tab state that survives page reloads via ``localStorage``.
 *
 * SSR renders with ``fallback`` (no ``window`` on the server); after
 * mount we lazily hydrate from storage. If the stored value doesn't
 * match ``allowed`` — the caller may have lost the capability that
 * unlocked it, or the value was written by an older build — we drop
 * it and keep the current state as-is.
 */
function useStickyTabState<T extends string>(
  storageKey: string,
  fallback: T,
  allowed: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw && (allowed as readonly string[]).includes(raw)) {
        setValue(raw as T);
      }
    } catch {
      //: Private-mode / no-storage browsers throw here. Falling back
      //: to the caller's default is the correct behaviour — there's
      //: no persistence to honour anyway.
    }
    //: We intentionally re-hydrate only on mount; ``allowed`` is a
    //: literal tuple in the caller and doesn't change per-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        //: Same rationale as the read side — degrade quietly.
      }
    },
    [storageKey],
  );
  return [value, update];
}


/**
 * Debounce a value so it stops updating for a bit after each write.
 * Search inputs use it to hold back the network call until typing
 * pauses — otherwise every keystroke would fire six paginated
 * requests.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}


/**
 * Sentinel-driven "load more" for an infinite query. Attach the
 * returned ``ref`` to a DOM node at the bottom of the list — when it
 * scrolls into view the observer calls ``fetchNextPage`` (unless
 * we're already fetching one, or there are no more pages).
 */
function useInfiniteScrollSentinel({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        //: Root margin gives us ~one screen of headroom — the page
        //: keeps scrolling smoothly instead of jerking when the last
        //: row appears at the fold.
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return ref;
}


/**
 * Bulk selection wiring shared between :func:`SpecsSection` and
 * :func:`SpecCard`. Selection is confined to the approved-pipeline
 * surface — a single sheet's ``linked_customer.id`` seeds the bag;
 * every subsequent toggle must match. The bag lives on the parent so
 * clicking "Create proposal" on the sticky bar can hand the full
 * selection off to :func:`BulkCreateProposalModal` in one shot.
 */
interface BulkSelection {
  readonly selectedIds: ReadonlySet<string>;
  readonly customerId: string | null;
  //: Non-empty selection blocks toggling a sheet from a different
  //: customer. UI uses this to render a "locked" checkbox with a
  //: tooltip instead of silently dropping the click.
  readonly isSelectable: (sheet: SpecificationSheetDto) => boolean;
  readonly toggle: (sheet: SpecificationSheetDto) => void;
  readonly clear: () => void;
}


/**
 * Two-axis archive view.
 *
 * Top tabs select the document type (proposals vs specification
 * sheets); sub-tabs split each type by where the document sits in
 * its customer-facing lifecycle:
 *
 *   * ``Pipeline`` (default) — documents still moving toward a
 *     customer signature. Split into two sections:
 *       * **Ready to send** (``status=approved``) — director has
 *         signed off, waiting for someone to mail it out.
 *       * **Awaiting customer signature** (``status=sent``) — out
 *         with the client, kiosk link live.
 *   * ``Signed`` — terminal state (``status=accepted``). The kiosk
 *     signature is already on the document.
 *
 * Three queries fire per document type (one per status) regardless
 * of the active sub-tab. They're cheap (filtered by status on a
 * single org column) and firing them eagerly means switching tabs
 * is instant rather than flashing a spinner on every click.
 */
export function SignedDocuments({
  orgId,
  canViewProposals,
  canViewSpecs,
}: {
  orgId: string;
  canViewProposals: boolean;
  canViewSpecs: boolean;
}) {
  const t = useTranslations("signed");
  const [topTab, setTopTab] = useStickyTabState<TopTab>(
    TOP_TAB_STORAGE_KEY,
    canViewProposals ? "proposals" : "specifications",
    ["proposals", "specifications"],
  );
  //: Free-text search bar. ``search`` tracks the keystrokes;
  //: ``debouncedSearch`` is what actually reaches the network — held
  //: back 250 ms so the operator can type "Cherya" without firing 6×6
  //: requests. Not persisted — search is a moment-in-time intent.
  const [search, setSearch] = useState<string>("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  //: A user who lost a capability shouldn't land on a tab they can't
  //: see. Correct the persisted value once, in-flight, so the fallback
  //: kicks in without a manual click.
  useEffect(() => {
    if (topTab === "proposals" && !canViewProposals && canViewSpecs) {
      setTopTab("specifications");
    } else if (topTab === "specifications" && !canViewSpecs && canViewProposals) {
      setTopTab("proposals");
    }
  }, [topTab, canViewProposals, canViewSpecs, setTopTab]);

  // Every column uses an infinite cursor query. Page size 50 is small
  // enough that the initial paint is fast on a tenant with millions of
  // rows (only 6 × 50 = 300 rows initially), and each column fetches
  // more on scroll via an IntersectionObserver sentinel.
  //
  // Search is forwarded to the backend as ``?search=…``; the query
  // key includes it, so typing invalidates the cache automatically.
  // Empty orgId disables the query (403 guard).
  const PAGE_SIZE = 50;
  const approvedProposals = useInfiniteProposals(
    canViewProposals ? orgId : "",
    { status: "approved", search: debouncedSearch || undefined, pageSize: PAGE_SIZE },
  );
  const sentProposals = useInfiniteProposals(
    canViewProposals ? orgId : "",
    { status: "sent", search: debouncedSearch || undefined, pageSize: PAGE_SIZE },
  );
  const signedProposals = useInfiniteProposals(
    canViewProposals ? orgId : "",
    { status: "accepted", search: debouncedSearch || undefined, pageSize: PAGE_SIZE },
  );
  const approvedSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "approved",
    search: debouncedSearch || undefined,
    pageSize: PAGE_SIZE,
  });
  const sentSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "sent",
    search: debouncedSearch || undefined,
    pageSize: PAGE_SIZE,
  });
  const signedSpecs = useInfiniteSpecifications(canViewSpecs ? orgId : "", {
    status: "accepted",
    search: debouncedSearch || undefined,
    pageSize: PAGE_SIZE,
  });

  const proposalsApproved = useMemo(
    () =>
      canViewProposals
        ? approvedProposals.data?.pages.flatMap((p) => p.results) ?? []
        : [],
    [approvedProposals.data, canViewProposals],
  );
  const proposalsSent = useMemo(
    () =>
      canViewProposals
        ? sentProposals.data?.pages.flatMap((p) => p.results) ?? []
        : [],
    [sentProposals.data, canViewProposals],
  );
  const proposalsSigned = useMemo(
    () =>
      canViewProposals
        ? signedProposals.data?.pages.flatMap((p) => p.results) ?? []
        : [],
    [signedProposals.data, canViewProposals],
  );
  // ``Unlinked first`` ranking — specs without a ``linked_proposal``
  // are the action items (no quote has been raised against the sheet
  // yet, so the sales team needs to do something). We surface them
  // at the top of every spec column on this tab; within each bucket
  // the backend's ``-updated_at`` ordering is preserved (the sort is
  // stable in modern JS engines).
  const unlinkedFirst = <T extends { linked_proposal: unknown }>(
    rows: readonly T[],
  ): T[] =>
    [...rows].sort((a, b) => {
      const aLinked = a.linked_proposal == null ? 0 : 1;
      const bLinked = b.linked_proposal == null ? 0 : 1;
      return aLinked - bLinked;
    });

  const specsApproved = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            approvedSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [approvedSpecs.data, canViewSpecs],
  );
  const specsSent = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            sentSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [sentSpecs.data, canViewSpecs],
  );
  const specsSigned = useMemo(
    () =>
      canViewSpecs
        ? unlinkedFirst(
            signedSpecs.data?.pages.flatMap((p) => p.results) ?? [],
          )
        : [],
    [signedSpecs.data, canViewSpecs],
  );

  // Bulk selection state. Only ever populated from the
  // Ready-to-send specs section; scoped inside :func:`SpecCard`.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    null,
  );
  const [bulkModalOpen, setBulkModalOpen] = useState(false);

  const clearBulk = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedCustomerId(null);
  }, []);

  const isSelectable = useCallback(
    (sheet: SpecificationSheetDto) => {
      const customerId = sheet.linked_customer?.id ?? null;
      if (!customerId) return false;
      if (sheet.linked_proposal) return false;
      if (selectedCustomerId && customerId !== selectedCustomerId) return false;
      return true;
    },
    [selectedCustomerId],
  );

  const toggleBulk = useCallback((sheet: SpecificationSheetDto) => {
    const customerId = sheet.linked_customer?.id ?? null;
    if (!customerId) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sheet.id)) {
        next.delete(sheet.id);
        //: Last one out flips the customer lock — otherwise the picker
        //: would silently stay bound to the just-dropped customer and
        //: block the operator from switching to a different one.
        if (next.size === 0) setSelectedCustomerId(null);
        return next;
      }
      next.add(sheet.id);
      setSelectedCustomerId((cur) => cur ?? customerId);
      return next;
    });
  }, []);

  const bulkSelection: BulkSelection = useMemo(
    () => ({
      selectedIds,
      customerId: selectedCustomerId,
      isSelectable,
      toggle: toggleBulk,
      clear: clearBulk,
    }),
    [selectedIds, selectedCustomerId, isSelectable, toggleBulk, clearBulk],
  );

  const selectedSheets = useMemo(
    () => specsApproved.filter((s) => selectedIds.has(s.id)),
    [specsApproved, selectedIds],
  );

  // Top-tab counters: every document in any of the lifecycle states
  // tracked on this page. Lets the user see the full volume of
  // customer-facing work in one glance before picking which type.
  const proposalsTotal =
    proposalsApproved.length + proposalsSent.length + proposalsSigned.length;
  const specsTotal =
    specsApproved.length + specsSent.length + specsSigned.length;

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-100 pb-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {t("title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">{t("subtitle")}</p>
        </div>
        {/* Search input lives in the header so it's reachable
            regardless of the active top tab. Filter is client-side
            over the already-loaded 500-row buckets, so results update
            keystroke-by-keystroke without a network round-trip. */}
        <label className="relative flex w-full max-w-xs items-center md:w-72">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
            className="h-9 w-full rounded-lg bg-ink-0 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:outline-none focus:ring-orange-500"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label={t("search.clear")}
              className="absolute right-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-400 hover:bg-ink-100 hover:text-ink-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </label>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        {canViewProposals ? (
          <TopTabButton
            active={topTab === "proposals"}
            onClick={() => setTopTab("proposals")}
            icon={<FileSignature className="h-4 w-4" />}
            label={t("tabs.proposals")}
            count={proposalsTotal}
          />
        ) : null}
        {canViewSpecs ? (
          <TopTabButton
            active={topTab === "specifications"}
            onClick={() => setTopTab("specifications")}
            icon={<ClipboardCheck className="h-4 w-4" />}
            label={t("tabs.specifications")}
            count={specsTotal}
          />
        ) : null}
      </div>

      {/* Three-column lifecycle board. Everything is visible at once
          so operators aren't paying a click to swap between "pipeline"
          and "signed" — the columns just show the same data split by
          stage. Collapses to stacked sections on narrow screens. */}
      {topTab === "proposals" && canViewProposals ? (
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
          <ProposalsSection
            heading={t("sections.ready_to_send")}
            hint={t("sections.ready_to_send_hint")}
            icon={<Stamp className="h-4 w-4" />}
            emptyMessage={t("empty.ready_to_send_proposals")}
            proposals={proposalsApproved}
            loading={approvedProposals.isLoading}
            errored={approvedProposals.isError}
            mode="approved"
            hasNextPage={approvedProposals.hasNextPage ?? false}
            isFetchingNextPage={approvedProposals.isFetchingNextPage}
            fetchNextPage={approvedProposals.fetchNextPage}
          />
          <ProposalsSection
            heading={t("sections.awaiting")}
            hint={t("sections.awaiting_hint")}
            icon={<Send className="h-4 w-4" />}
            emptyMessage={t("empty.awaiting_proposals")}
            proposals={proposalsSent}
            loading={sentProposals.isLoading}
            errored={sentProposals.isError}
            mode="sent"
            hasNextPage={sentProposals.hasNextPage ?? false}
            isFetchingNextPage={sentProposals.isFetchingNextPage}
            fetchNextPage={sentProposals.fetchNextPage}
          />
          <ProposalsSection
            heading={t("sections.signed")}
            icon={<CheckCircle2 className="h-4 w-4" />}
            emptyMessage={t("empty.signed_proposals")}
            proposals={proposalsSigned}
            loading={signedProposals.isLoading}
            errored={signedProposals.isError}
            mode="signed"
            hasNextPage={signedProposals.hasNextPage ?? false}
            isFetchingNextPage={signedProposals.isFetchingNextPage}
            fetchNextPage={signedProposals.fetchNextPage}
          />
        </div>
      ) : null}
      {topTab === "specifications" && canViewSpecs ? (
        <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
          <SpecsSection
            orgId={orgId}
            heading={t("sections.ready_to_send")}
            hint={t("sections.ready_to_send_hint")}
            icon={<Stamp className="h-4 w-4" />}
            emptyMessage={t("empty.ready_to_send_specs")}
            specs={specsApproved}
            loading={approvedSpecs.isLoading}
            errored={approvedSpecs.isError}
            mode="approved"
            bulkSelection={bulkSelection}
            hasNextPage={approvedSpecs.hasNextPage ?? false}
            isFetchingNextPage={approvedSpecs.isFetchingNextPage}
            fetchNextPage={approvedSpecs.fetchNextPage}
          />
          <SpecsSection
            orgId={orgId}
            heading={t("sections.awaiting")}
            hint={t("sections.awaiting_hint")}
            icon={<Send className="h-4 w-4" />}
            emptyMessage={t("empty.awaiting_specs")}
            specs={specsSent}
            loading={sentSpecs.isLoading}
            errored={sentSpecs.isError}
            mode="sent"
            hasNextPage={sentSpecs.hasNextPage ?? false}
            isFetchingNextPage={sentSpecs.isFetchingNextPage}
            fetchNextPage={sentSpecs.fetchNextPage}
          />
          <SpecsSection
            orgId={orgId}
            heading={t("sections.signed")}
            icon={<CheckCircle2 className="h-4 w-4" />}
            emptyMessage={t("empty.signed_specs")}
            specs={specsSigned}
            loading={signedSpecs.isLoading}
            errored={signedSpecs.isError}
            mode="signed"
            hasNextPage={signedSpecs.hasNextPage ?? false}
            isFetchingNextPage={signedSpecs.isFetchingNextPage}
            fetchNextPage={signedSpecs.fetchNextPage}
          />
        </div>
      ) : null}

      {selectedSheets.length > 0 && topTab === "specifications" ? (
        <BulkSelectionBar
          count={selectedSheets.length}
          customerLabel={
            selectedSheets[0]?.linked_customer?.company ||
            selectedSheets[0]?.linked_customer?.name ||
            null
          }
          onCreate={() => setBulkModalOpen(true)}
          onClear={clearBulk}
        />
      ) : null}
      <BulkCreateProposalModal
        orgId={orgId}
        sheets={selectedSheets}
        isOpen={bulkModalOpen}
        onClose={() => {
          setBulkModalOpen(false);
          //: Successful create → the mutation router.push()es away; the
          //: modal owning cleanup covers cancel too, but we also drop
          //: the bag so the sticky bar disappears when the operator
          //: dismisses without confirming.
          clearBulk();
        }}
      />
    </section>
  );
}


function BulkSelectionBar({
  count,
  customerLabel,
  onCreate,
  onClear,
}: {
  count: number;
  customerLabel: string | null;
  onCreate: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("signed");
  return (
    <div className="pointer-events-none sticky bottom-4 z-40 mt-6 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-ink-1000 px-4 py-2 text-xs font-medium text-ink-0 shadow-lg ring-1 ring-inset ring-ink-1000">
        <span>
          {t(count === 1 ? "bulk.count_one" : "bulk.count_other", {
            count,
          })}
          {customerLabel ? (
            <span className="ml-1 text-ink-300">
              {t("bulk.for_customer", { name: customerLabel })}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-ink-800 px-3 text-[11px] font-medium text-ink-0 hover:bg-ink-700"
        >
          <X className="h-3 w-3" />
          {t("bulk.clear")}
        </button>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-7 items-center gap-1 rounded-full bg-orange-500 px-3 text-[11px] font-semibold text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-3 w-3" />
          {t("bulk.create_proposal")}
        </button>
      </div>
    </div>
  );
}


function TopTabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium ring-1 ring-inset transition-colors ${
        active
          ? "bg-orange-500/10 text-orange-700 ring-orange-500/30"
          : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
      }`}
    >
      {icon}
      <span>{label}</span>
      <span
        className={`inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
          active
            ? "bg-orange-500 text-ink-0"
            : "bg-ink-100 text-ink-700"
        }`}
      >
        {count}
      </span>
    </button>
  );
}


function ProposalsSection({
  heading,
  hint,
  icon,
  emptyMessage,
  proposals,
  loading,
  errored,
  mode,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  heading: string;
  hint?: string;
  icon: React.ReactNode;
  emptyMessage: string;
  proposals: readonly ProposalListItemDto[];
  loading: boolean;
  errored: boolean;
  mode: CardMode;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const t = useTranslations("signed");
  const sentinelRef = useInfiniteScrollSentinel({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-700">
        {icon}
        <span>{heading}</span>
        <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold text-ink-700">
          {proposals.length}
          {hasNextPage ? "+" : ""}
        </span>
      </h2>
      {hint ? (
        <p className="mt-1 text-xs text-ink-500">{hint}</p>
      ) : null}
      {loading ? (
        <p className="mt-3 text-sm text-ink-500">{t("loading")}</p>
      ) : errored ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {t("errors.load")}
        </p>
      ) : proposals.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-3">
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} mode={mode} />
            ))}
          </ul>
          {/* Sentinel + subtle loading footer. The observer trips on
              first intersection, so we render a tall-ish div even
              when we're already at the end (``hasNextPage=false``)
              so scrolling doesn't feel abrupt. */}
          <div ref={sentinelRef} className="mt-3" aria-hidden>
            {isFetchingNextPage ? (
              <p className="text-center text-xs text-ink-400">{t("loading")}</p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}


function SpecsSection({
  orgId,
  heading,
  hint,
  icon,
  emptyMessage,
  specs,
  loading,
  errored,
  mode,
  bulkSelection,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  orgId: string;
  heading: string;
  hint?: string;
  icon: React.ReactNode;
  emptyMessage: string;
  specs: readonly SpecificationSheetDto[];
  loading: boolean;
  errored: boolean;
  mode: CardMode;
  //: Only threaded through the approved-mode caller; other modes get
  //: ``undefined`` so the checkbox column stays hidden.
  bulkSelection?: BulkSelection;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const t = useTranslations("signed");
  const sentinelRef = useInfiniteScrollSentinel({
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  });
  return (
    <div>
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-ink-700">
        {icon}
        <span>{heading}</span>
        <span className="ml-1 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-ink-100 px-1.5 text-[11px] font-semibold text-ink-700">
          {specs.length}
          {hasNextPage ? "+" : ""}
        </span>
      </h2>
      {hint ? (
        <p className="mt-1 text-xs text-ink-500">{hint}</p>
      ) : null}
      {loading ? (
        <p className="mt-3 text-sm text-ink-500">{t("loading")}</p>
      ) : errored ? (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {t("errors.load")}
        </p>
      ) : specs.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-3">
            {specs.map((s) => (
              <SpecCard
                key={s.id}
                orgId={orgId}
                sheet={s}
                mode={mode}
                bulkSelection={bulkSelection}
              />
            ))}
          </ul>
          <div ref={sentinelRef} className="mt-3" aria-hidden>
            {isFetchingNextPage ? (
              <p className="text-center text-xs text-ink-400">{t("loading")}</p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}


function EmptyState({ message }: { message: string }) {
  return (
    <div className="mt-3 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
      <Inbox className="mx-auto h-6 w-6 text-ink-400" />
      <p className="mt-2 text-sm text-ink-500">{message}</p>
    </div>
  );
}


function ProposalCard({
  proposal,
  mode,
}: {
  proposal: ProposalListItemDto;
  mode: CardMode;
}) {
  const t = useTranslations("signed");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });

  const customer =
    proposal.customer_company ||
    proposal.customer_name ||
    t("card.no_customer");
  const productLabel = t(
    proposal.lines_count === 1
      ? "card.products_one"
      : "card.products_other",
    { count: proposal.lines_count },
  );

  // Pick the timestamp that matches the lifecycle stage being shown.
  // ``approved`` prefers the director-signature timestamp (the
  // moment the doc became sendable); ``signed`` prefers the customer
  // signature; both fall back to ``updated_at`` if the signature
  // stamp is missing — which can happen for legacy data signed
  // before the timestamped flow was wired in.
  const stampSource =
    mode === "approved"
      ? proposal.director_signed_at ?? proposal.updated_at
      : mode === "signed" && proposal.customer_signed_at
        ? proposal.customer_signed_at
        : proposal.updated_at;
  const stampKey =
    mode === "approved"
      ? "card.approved_at"
      : mode === "signed"
        ? "card.signed_at"
        : "card.sent_at";
  const stampLabel = t(stampKey, {
    time: format.relativeTime(new Date(stampSource), now),
  });

  return (
    <li className="rounded-xl bg-ink-0 px-4 py-3 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-semibold tracking-tight text-ink-1000">
            {proposal.code} · {customer}
          </span>
          <span className="text-xs text-ink-500">
            {proposal.formulation_name} · {productLabel}
          </span>
          <span className="text-[11px] text-ink-400">{stampLabel}</span>
        </div>
        <Link
          href={`/proposals/${proposal.id}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <LinkIconSlot
            idleIcon={<ExternalLink className="h-4 w-4" />}
            spinnerSizeClassName="h-4 w-4"
          />
          {t("card.open")}
        </Link>
      </div>
    </li>
  );
}


function SpecCard({
  orgId,
  sheet,
  mode,
  bulkSelection,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  mode: CardMode;
  bulkSelection?: BulkSelection;
}) {
  const t = useTranslations("signed");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [createOpen, setCreateOpen] = useState(false);

  //: Checkbox is only shown on approved-mode cards where the sheet is
  //: eligible for a new proposal (no proposal yet) — otherwise there's
  //: nothing to bulk-do with the row.
  const showCheckbox =
    mode === "approved" &&
    bulkSelection !== undefined &&
    sheet.linked_proposal === null;
  const isSelected = bulkSelection?.selectedIds.has(sheet.id) ?? false;
  const hasLinkedCustomer = sheet.linked_customer !== null;
  //: A card without a linked customer can never be selected — call it
  //: out explicitly so the operator knows why the checkbox is disabled
  //: (fix is "attach a customer on the project workspace", not "keep
  //: clicking harder").
  const checkboxDisabled =
    !hasLinkedCustomer || (!isSelected && !(bulkSelection?.isSelectable(sheet) ?? false));
  const checkboxTitle = !hasLinkedCustomer
    ? t("card.bulk_select_no_customer")
    : checkboxDisabled
      ? t("card.bulk_select_locked")
      : t("bulk.sr_toggle");

  // Preference order:
  //   1. Kiosk-signed customer identity (the freshest source once a
  //      client actually signs the sheet — locks the display to whoever
  //      committed).
  //   2. Formulation's linked customer (set by sales on the project
  //      workspace — the single source of truth pre-signature).
  //   3. Scientist-typed ``client_*`` fields on the sheet itself
  //      (only populated when someone explicitly filled them in at
  //      draft time; often blank).
  //   4. Fallback copy.
  const client =
    sheet.customer_company ||
    sheet.customer_name ||
    sheet.linked_customer?.company ||
    sheet.linked_customer?.name ||
    sheet.client_company ||
    sheet.client_name ||
    t("card.no_client");

  // Spec sheets don't carry a director-signature timestamp on the
  // list DTO (only the render view-model has it), so the
  // ``approved`` mode falls back to ``updated_at`` — the moment
  // the status flipped is the cheapest proxy.
  const stampSource =
    mode === "signed" && sheet.customer_signed_at
      ? sheet.customer_signed_at
      : sheet.updated_at;
  const stampKey =
    mode === "approved"
      ? "card.approved_at"
      : mode === "signed"
        ? "card.signed_at"
        : "card.sent_at";
  const stampLabel = t(stampKey, {
    time: format.relativeTime(new Date(stampSource), now),
  });

  // ``approved`` mode is the "Ready to send" surface, where partners
  // are deciding whether each sheet still needs a quote — surface the
  // linked proposal chip there. We intentionally suppress it on the
  // ``sent`` / ``signed`` modes: by the time a sheet is out for kiosk
  // signature or already signed, the existence of a proposal is no
  // longer the relevant question.
  const showProposalChip = mode === "approved";

  return (
    <li
      className={`rounded-xl bg-ink-0 px-4 py-3 ring-1 ring-inset transition-colors ${
        isSelected
          ? "ring-orange-500/60 bg-orange-500/5"
          : "ring-ink-200 hover:bg-ink-50"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {showCheckbox ? (
            <label
              className="mt-1 inline-flex cursor-pointer items-center"
              title={checkboxTitle}
            >
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer rounded border-ink-300 text-orange-500 focus:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-40"
                checked={isSelected}
                disabled={checkboxDisabled}
                onChange={() => bulkSelection?.toggle(sheet)}
              />
              <span className="sr-only">{t("bulk.sr_toggle")}</span>
            </label>
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-semibold tracking-tight text-ink-1000">
              {sheet.code || t("card.no_formulation")} · {client}
            </span>
            <span className="text-xs text-ink-500">
              {sheet.formulation_name || t("card.no_formulation")} ·{" "}
              {t("card.version", { version: sheet.formulation_version_number })}
            </span>
            <span className="text-[11px] text-ink-400">{stampLabel}</span>
            {showProposalChip ? (
              <ProposalLinkageChip
                sheet={sheet}
                onCreate={() => setCreateOpen(true)}
              />
            ) : null}
          </div>
        </div>
        <Link
          href={`/specifications/${sheet.id}`}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <LinkIconSlot
            idleIcon={<ExternalLink className="h-4 w-4" />}
            spinnerSizeClassName="h-4 w-4"
          />
          {t("card.open")}
        </Link>
      </div>
      {showProposalChip && sheet.linked_proposal === null ? (
        <SpecCreateProposalModal
          orgId={orgId}
          sheet={sheet}
          isOpen={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </li>
  );
}


/**
 * Inline chip that answers "has a proposal been raised against this
 * sheet yet?" on the Ready-to-send Pipeline view. Two states:
 *
 *   * **Linked** — clickable chip with the proposal code + status.
 *     Clicking jumps to the proposal detail page.
 *   * **Unlinked** — warning chip + a secondary "Create proposal"
 *     button that deep-links to the project workspace's proposals
 *     tab. The workspace's New Proposal modal already pre-selects
 *     the formulation's approved version, so the operator only has
 *     to fill in customer + price.
 */
function ProposalLinkageChip({
  sheet,
  onCreate,
}: {
  sheet: SpecificationSheetDto;
  onCreate: () => void;
}) {
  const t = useTranslations("signed");
  const linked = sheet.linked_proposal;
  if (linked) {
    return (
      <Link
        href={`/proposals/${linked.id}`}
        className="mt-1 inline-flex items-center gap-1.5 self-start rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-700 ring-1 ring-inset ring-orange-500/30 hover:bg-orange-500/20"
      >
        <Paperclip className="h-3 w-3" />
        {t("card.proposal_linked", {
          code: linked.code,
          status: linked.status,
        })}
      </Link>
    );
  }
  return (
    <span className="mt-1 inline-flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/30">
        <AlertCircle className="h-3 w-3" />
        {t("card.proposal_missing")}
      </span>
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-700 hover:text-orange-800"
      >
        <Plus className="h-3 w-3" />
        {t("card.proposal_create")}
      </button>
    </span>
  );
}
