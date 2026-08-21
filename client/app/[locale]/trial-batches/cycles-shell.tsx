"use client";

/**
 * Trial-batch cycles — scientist surface.
 *
 * Dedicated page (moved out of /samples, which was mixing the cycle
 * workflow with the storefront sample-kit queue). Scales to
 * hundreds of active cycles by defaulting to a compact table with
 * a small "needs attention" pane pinned at the top.
 *
 * Layout:
 *   1. AttentionPane      — the ≤5 cycles a scientist has to click.
 *                           Full-fat cards (slot ladder + actions).
 *                           Anything past 5 hides behind "show all".
 *   2. CyclesTable        — every active cycle. One row each with
 *                           formulation, customer, active slot,
 *                           status pill, updated_at. Search across
 *                           formulation code + customer; filter
 *                           chips by status; row expands inline for
 *                           slot ladder + actions.
 *
 * All mutations go through react-query with invalidation on the
 * shared cycles key so both surfaces update in lockstep.
 *
 * Visual language mirrors ``/samples`` (ink palette, rounded
 * corners, ring-1 outlines, pill-shaped controls) so scientists
 * moving between the two R&D pages don't experience a jarring
 * design shift.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiClient } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";


type SlotStatus =
  | "awaiting_scientist"
  | "in_production"
  | "shipped"
  | "delivered"
  | "feedback_pending"
  | "closed_iterated"
  | "closed_satisfied"
  | "closed_cancelled";


type CycleStatus =
  | "in_progress"
  | "satisfied"
  | "terminated_by_team"
  | "max_reached";


interface Slot {
  readonly id: string;
  readonly sequence_no: number;
  readonly status: SlotStatus;
  readonly verdict: "satisfied" | "needs_iteration" | null;
  readonly verdict_at: string | null;
  readonly keep_producing_remaining: boolean;
  readonly feedback_summary: string;
  readonly trial_batch_id: string | null;
  readonly formulation_version_id: string;
  readonly formulation_version_label: string;
  readonly formulation_id: string | null;
}


interface CustomerRef {
  readonly id: string;
  readonly name: string;
}


interface Cycle {
  readonly id: string;
  readonly status: CycleStatus;
  readonly total_slots: number;
  readonly slots_used: number;
  readonly closed_at: string | null;
  readonly updated_at: string;
  readonly formulation: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
  readonly customer: CustomerRef | null;
  readonly active_slot_id: string | null;
  readonly latest_iterated_slot_id: string | null;
  readonly can_open_next_slot: boolean;
  readonly action_needed: boolean;
  readonly slots: readonly Slot[];
}


interface PipelinePage {
  readonly stage: PipelineStage;
  readonly total: number;
  readonly items: readonly Cycle[];
  readonly next_cursor: string | null;
}


interface FormulationVersionOption {
  readonly id: string;
  /** Short tag ("v3"). Sorts + display headline. */
  readonly label: string;
  /** Sequential version number — kept alongside label for FE
   *  sorting when the API list order isn't stable. */
  readonly version_number: number;
  /** Scientist-written note (e.g. "caffeine bumped to 200mg"). Empty
   *  string when the scientist saved without a note. */
  readonly note: string;
  /** Human-readable author name (or email fallback, "—" when
   *  neither is available). */
  readonly created_by_name: string;
  readonly created_at: string;
  /** True when the version was auto-cut on a Save Draft (silent
   *  restore point). FE dims + tags these so scientists don't ship
   *  a slot against a mid-edit snapshot. */
  readonly is_auto: boolean;
  /** Passed the builder-readiness gate at save time. FE surfaces a
   *  subtle warning when False so scientists don't ship an
   *  incomplete recipe. */
  readonly is_complete: boolean;
}


const CYCLES_KEY = "trial-batch-cycles";
const PIPELINE_KEY = "trial-batch-cycles-pipeline";

/** Kanban stages, ordered left→right. Mirrors the BE
 *  ``TrialBatchCyclePipelineColumnView`` accepted values. */
type PipelineStage = "needs_click" | "in_flight" | "closed";

interface StageConfig {
  readonly key: PipelineStage;
  readonly title: string;
  readonly blurb: string;
  readonly tone: "amber" | "sky" | "ink";
}

const STAGES: readonly StageConfig[] = [
  {
    key: "needs_click",
    title: "Needs your click",
    blurb: "Scientist action pending — awaiting a batch or a next slot.",
    tone: "amber",
  },
  {
    key: "in_flight",
    title: "In flight",
    blurb: "Samples in production / shipped / awaiting customer feedback.",
    tone: "sky",
  },
  {
    key: "closed",
    title: "Closed",
    blurb: "Satisfied / terminated / max reached.",
    tone: "ink",
  },
];


export function TrialCyclesShell({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [openCycleId, setOpenCycleId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(searchInput.trim().toLowerCase()),
      250,
    );
    return () => clearTimeout(t);
  }, [searchInput]);

  // Refresh every column at once when a mutation invalidates the
  // shared cycles key. Individual columns fetch independently so
  // this is a single client-side broadcast.
  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: [rootQueryKey, PIPELINE_KEY, orgId],
    });
    // Legacy list key — kept invalidated in case anything else still
    // subscribes to the old feed while both surfaces coexist.
    queryClient.invalidateQueries({
      queryKey: [rootQueryKey, CYCLES_KEY, orgId],
    });
  }, [queryClient, orgId]);

  // Bumps on every pipeline-query cache event so the imperative
  // ``getQueryData`` read below stays reactive. Without this, the
  // modal's ``cycle`` prop stays stale after mutations (Open next
  // slot, close cycle, etc.) — invalidation refetches the columns
  // and updates the cache, but the useMemo below doesn't re-run
  // because none of its explicit deps changed. Result: operator
  // clicks "Open next slot", sees success, but the new slot
  // doesn't appear in the modal until they close + reopen it.
  const [pipelineCacheTick, setPipelineCacheTick] = useState(0);
  useEffect(() => {
    const unsub = queryClient.getQueryCache().subscribe((event) => {
      const key = event?.query?.queryKey as unknown as unknown[] | undefined;
      if (
        Array.isArray(key) &&
        key[0] === rootQueryKey &&
        key[1] === PIPELINE_KEY &&
        key[2] === orgId
      ) {
        setPipelineCacheTick((n) => (n + 1) % 1_000_000);
      }
    });
    return () => unsub();
  }, [queryClient, orgId]);

  const openModalCycle = useMemo(() => {
    if (!openCycleId) return null;
    // Search every cached column page for the modal cycle. Cheap —
    // page maps stay in memory while the tab is open and Q's cache
    // is shared across columns. ``pipelineCacheTick`` in deps keeps
    // this reactive to background refetches (see subscribe above).
    for (const stage of STAGES) {
      const cached = queryClient.getQueryData<{
        pages: readonly PipelinePage[];
      }>([rootQueryKey, PIPELINE_KEY, orgId, stage.key, debouncedSearch]);
      const hit = cached?.pages
        .flatMap((p) => p.items)
        .find((c) => c.id === openCycleId);
      if (hit) return hit;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pipelineCacheTick is the reactive signal for imperative cache reads
  }, [openCycleId, queryClient, orgId, debouncedSearch, pipelineCacheTick]);

  return (
    <section className="mt-6 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            Trial batches
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Custom-formulation projects producing samples slot-by-slot.
            Left → right: what needs your click, what's flowing, what's done.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SearchBar value={searchInput} onChange={setSearchInput} />
          <button
            type="button"
            onClick={invalidateAll}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-ink-200 bg-ink-0 text-ink-600 hover:bg-ink-50"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Three lifecycle columns. Each queries its own paginated
          slice so a big Closed archive can't starve the small
          Needs-click bucket. Load-more per column. */}
      <div className="grid gap-4 lg:grid-cols-3">
        {STAGES.map((stage) => (
          <CycleColumn
            key={stage.key}
            stage={stage}
            orgId={orgId}
            search={debouncedSearch}
            onOpenCycle={setOpenCycleId}
          />
        ))}
      </div>

      {openCycleId && openModalCycle ? (
        <CycleDetailsModal
          orgId={orgId}
          cycle={openModalCycle}
          onClose={() => setOpenCycleId(null)}
          onChanged={() => {
            invalidateAll();
          }}
        />
      ) : null}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Kanban column — paginated per stage
// ---------------------------------------------------------------------------


function CycleColumn({
  stage,
  orgId,
  search,
  onOpenCycle,
}: {
  stage: StageConfig;
  orgId: string;
  search: string;
  onOpenCycle: (cycleId: string) => void;
}) {
  const query = useInfiniteQuery<PipelinePage>({
    queryKey: [rootQueryKey, PIPELINE_KEY, orgId, stage.key, search],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (typeof pageParam === "string" && pageParam) {
        params.set("cursor", pageParam);
      }
      if (search) params.set("search", search);
      const qs = params.toString();
      const { data } = await apiClient.get<PipelinePage>(
        `/api/organizations/${orgId}/trial-batch-cycles/pipeline/${stage.key}/${qs ? `?${qs}` : ""}`,
      );
      return data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor ?? null,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const total = query.data?.pages[0]?.total ?? 0;

  const headerTone =
    stage.tone === "amber"
      ? "border-amber-200 bg-amber-50"
      : stage.tone === "sky"
        ? "border-sky-200 bg-sky-50"
        : "border-ink-200 bg-ink-50";
  const countTone =
    stage.tone === "amber"
      ? "bg-amber-200 text-amber-900"
      : stage.tone === "sky"
        ? "bg-sky-200 text-sky-900"
        : "bg-ink-200 text-ink-800";

  return (
    <div className="flex min-h-[240px] flex-col overflow-hidden rounded-2xl bg-ink-0 ring-1 ring-ink-200">
      <header
        className={
          "flex items-start justify-between gap-2 border-b px-4 py-3 " + headerTone
        }
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-ink-1000">
              {stage.title}
            </p>
            <span
              className={
                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums " +
                countTone
              }
              title={`${total} cycle${total === 1 ? "" : "s"}`}
            >
              {total}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-600">{stage.blurb}</p>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-2 p-3">
        {query.isPending ? (
          <p className="p-4 text-center text-[11px] text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : query.isError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            Couldn&rsquo;t load. Refresh to try again.
          </p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-[11px] text-ink-400">
            {search ? "Nothing matches your search." : "Nothing here."}
          </p>
        ) : (
          rows.map((cycle) => (
            <CycleKanbanCard
              key={cycle.id}
              cycle={cycle}
              onClick={() => onOpenCycle(cycle.id)}
            />
          ))
        )}

        {query.hasNextPage ? (
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="mt-1 rounded-full border border-ink-200 bg-ink-0 px-3 py-1.5 text-[11px] font-semibold text-ink-700 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {query.isFetchingNextPage ? (
              <>
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
              </>
            ) : (
              "Load more"
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Kanban card — clickable, opens the CycleDetailsModal
// ---------------------------------------------------------------------------


function CycleKanbanCard({
  cycle,
  onClick,
}: {
  cycle: Cycle;
  onClick: () => void;
}) {
  const active = cycle.slots.find((s) => s.id === cycle.active_slot_id);
  const highlight = cycle.action_needed || cycle.can_open_next_slot;
  const actionLabel = cycle.action_needed
    ? "Create sample batch"
    : cycle.can_open_next_slot
      ? "Open next slot"
      : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors hover:bg-ink-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-300 " +
        (highlight
          ? "border-amber-300 bg-amber-50/60"
          : "border-ink-100 bg-ink-0")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink-1000">
            {cycle.formulation.name || "Untitled formulation"}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-500">
            {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
          </p>
        </div>
        <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-700">
          {cycle.slots_used}/{cycle.total_slots}
        </span>
      </div>

      {cycle.customer ? (
        <p className="flex items-center gap-1 truncate text-[11px] text-ink-600">
          <Users className="h-3 w-3 shrink-0 text-ink-400" />
          {cycle.customer.name}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <CycleStatusPill status={cycle.status} />
        <span className="text-[10px] text-ink-500">
          {formatDate(cycle.updated_at)}
        </span>
      </div>

      {actionLabel ? (
        <span className="mt-1 inline-flex items-center gap-1 self-start rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
          {cycle.action_needed ? (
            <AlertCircle className="h-3 w-3" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          {actionLabel}
        </span>
      ) : active ? (
        <span className="mt-1 inline-flex items-center gap-1 self-start text-[10px] text-ink-500">
          <ChevronRight className="h-3 w-3 text-ink-400" />
          Slot #{active.sequence_no} · {active.status.replace(/_/g, " ")}
        </span>
      ) : null}
    </button>
  );
}


// ---------------------------------------------------------------------------
// Cycle details modal — full slot ladder + actions
// ---------------------------------------------------------------------------


function CycleDetailsModal({
  orgId,
  cycle,
  onClose,
  onChanged,
}: {
  orgId: string;
  cycle: Cycle;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const [openNext, setOpenNext] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(
    cycle.active_slot_id ?? cycle.slots[cycle.slots.length - 1]?.id ?? null,
  );

  const createAndLink = useMutation({
    mutationFn: async (slotId: string) => {
      const { data } = await apiClient.post(
        `/api/organizations/${orgId}/trial-batch-cycles/${cycle.id}/slots/${slotId}/create-and-link-batch/`,
        {},
      );
      return data;
    },
    onMutate: (slotId: string) => setBusySlotId(slotId),
    onSuccess: () => onChanged(),
    onError: (err: unknown) => {
      setError(
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Could not create the batch.",
      );
    },
    onSettled: () => setBusySlotId(null),
  });

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasFooterActions =
    cycle.can_open_next_slot ||
    cycle.status === "in_progress" ||
    cycle.status === "max_reached";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Fixed 720x640 dialog on desktop; falls back to viewport-
          minus-gutter on smaller screens so the card never
          overflows. Height is fixed (not just capped) so the modal
          doesn't jump size as slots expand — inner flex column
          keeps the header + footer pinned while the middle slot
          list scrolls independently. */}
      <div
        className="flex w-[720px] max-w-[calc(100vw-2rem)] h-[640px] max-h-[calc(100vh-4rem)] flex-col overflow-hidden rounded-2xl bg-ink-0 shadow-lg ring-1 ring-ink-200"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ink-100 p-4">
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-ink-1000">
              {cycle.formulation.name || "Untitled formulation"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-500">
              <span className="font-mono">
                {cycle.formulation.code ||
                  cycle.formulation.id.slice(0, 8)}
              </span>
              {cycle.customer ? ` · ${cycle.customer.name}` : ""}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CycleStatusPill status={cycle.status} />
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-ink-700">
                {cycle.slots_used}/{cycle.total_slots} slots produced
              </span>
              <span className="text-[10px] text-ink-500">
                Updated {formatDate(cycle.updated_at)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
            Slots
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {cycle.slots.map((slot) => (
              <SlotDetailRow
                key={slot.id}
                slot={slot}
                busy={busySlotId === slot.id}
                onCreateBatch={() => createAndLink.mutate(slot.id)}
                expanded={expandedSlotId === slot.id}
                onToggle={() =>
                  setExpandedSlotId((cur) => (cur === slot.id ? null : slot.id))
                }
              />
            ))}
          </ul>

          {error ? (
            <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        {hasFooterActions ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ink-100 p-4">
            {cycle.can_open_next_slot ? (
              <button
                type="button"
                onClick={() => setOpenNext(true)}
                className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-3 py-1.5 text-[11px] font-semibold text-ink-0 hover:bg-ink-900"
              >
                <Sparkles className="h-3 w-3" /> Open next slot
              </button>
            ) : null}
            {cycle.status === "in_progress" ||
            cycle.status === "max_reached" ? (
              <button
                type="button"
                onClick={() => setCloseOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-semibold text-red-800 hover:bg-red-100"
              >
                <AlertTriangle className="h-3 w-3" /> Close cycle
              </button>
            ) : null}
          </div>
        ) : null}

        {openNext ? (
          <OpenNextSlotModal
            orgId={orgId}
            cycleId={cycle.id}
            onClose={() => setOpenNext(false)}
            onOpened={() => {
              setOpenNext(false);
              onChanged();
            }}
          />
        ) : null}
        {closeOpen ? (
          <TeamCloseModal
            orgId={orgId}
            cycleId={cycle.id}
            onClose={() => setCloseOpen(false)}
            onClosed={() => {
              setCloseOpen(false);
              onChanged();
              onClose();
            }}
          />
        ) : null}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Slot detail row — expandable to show verdict + feedback + timestamps
// ---------------------------------------------------------------------------


function SlotDetailRow({
  slot,
  busy,
  onCreateBatch,
  expanded,
  onToggle,
}: {
  slot: Slot;
  busy: boolean;
  onCreateBatch: () => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const verdictTone =
    slot.verdict === "satisfied"
      ? "bg-emerald-100 text-emerald-800"
      : slot.verdict === "needs_iteration"
        ? "bg-amber-100 text-amber-800"
        : "bg-ink-100 text-ink-600";
  const statusIcon =
    slot.status === "closed_satisfied" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
    ) : slot.status === "closed_iterated" ? (
      <AlertCircle className="h-3.5 w-3.5 text-amber-700" />
    ) : slot.status === "closed_cancelled" ? (
      <X className="h-3.5 w-3.5 text-ink-400" />
    ) : slot.status === "delivered" || slot.status === "feedback_pending" ? (
      <ChevronRight className="h-3.5 w-3.5 text-sky-700" />
    ) : slot.status === "in_production" || slot.status === "shipped" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-700" />
    ) : (
      <Sparkles className="h-3.5 w-3.5 text-ink-500" />
    );

  return (
    <li className="rounded-xl border border-ink-100 bg-ink-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-ink-50"
      >
        {statusIcon}
        <span className="text-xs font-semibold text-ink-1000">
          Slot #{slot.sequence_no}
        </span>
        <span className="text-[10px] text-ink-500">
          {slot.formulation_version_label}
        </span>
        <span className="text-[10px] text-ink-500">
          · {slot.status.replace(/_/g, " ")}
        </span>
        {slot.verdict ? (
          <span
            className={
              "ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold " +
              verdictTone
            }
          >
            {slot.verdict.replace(/_/g, " ")}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-ink-100 px-3 py-2">
          <div className="grid gap-2 text-[11px] text-ink-700 sm:grid-cols-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                Version
              </p>
              <p className="mt-0.5 font-mono text-ink-800">
                {slot.formulation_version_label}
              </p>
            </div>
            {slot.verdict_at ? (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  Verdict at
                </p>
                <p className="mt-0.5 text-ink-800">
                  {formatDate(slot.verdict_at)}
                </p>
              </div>
            ) : null}
          </div>

          {slot.feedback_summary ? (
            <div className="rounded-lg border border-ink-100 bg-ink-50/60 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                Customer feedback
              </p>
              <p className="mt-1 whitespace-pre-line text-[11px] text-ink-800">
                {slot.feedback_summary}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {slot.status === "awaiting_scientist" ? (
              <button
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateBatch();
                }}
                className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-3 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Create sample batch
              </button>
            ) : null}
            {slot.trial_batch_id && slot.formulation_id ? (
              <a
                href={`/formulations/${slot.formulation_id}/trial-batches/${slot.trial_batch_id}`}
                className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-3 py-1 text-[10px] font-semibold text-ink-700 hover:bg-ink-50"
              >
                Open batch <ChevronRight className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}




function CycleStatusPill({ status }: { status: CycleStatus }) {
  const tone =
    status === "satisfied"
      ? "bg-emerald-100 text-emerald-800"
      : status === "terminated_by_team"
        ? "bg-ink-100 text-ink-700"
        : status === "max_reached"
          ? "bg-amber-100 text-amber-800"
          : "bg-sky-100 text-sky-800";
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] font-semibold " + tone
      }
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}


// ---------------------------------------------------------------------------
// Search bar (matches /samples)
// ---------------------------------------------------------------------------


function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative w-full max-w-md min-w-[220px]">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search formulation, customer, status…"
        className="h-10 w-full rounded-full border border-ink-200 bg-ink-0 pl-9 pr-9 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
      />
      {value ? (
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


// ---------------------------------------------------------------------------
// Open-next-slot modal
// ---------------------------------------------------------------------------


function OpenNextSlotModal({
  orgId,
  cycleId,
  onClose,
  onOpened,
}: {
  orgId: string;
  cycleId: string;
  onClose: () => void;
  onOpened: () => void;
}) {
  const versions = useQuery<{ items: readonly FormulationVersionOption[] }>({
    queryKey: [rootQueryKey, "trial-batch-cycle-versions", cycleId],
    queryFn: async () => {
      const { data } = await apiClient.get(
        `/api/organizations/${orgId}/trial-batch-cycles/${cycleId}/formulation-versions/`,
      );
      return data;
    },
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return;
      await apiClient.post(
        `/api/organizations/${orgId}/trial-batch-cycles/${cycleId}/open-next-slot/`,
        { formulation_version_id: selected },
      );
    },
    onSuccess: onOpened,
    onError: (err: unknown) => {
      setError(
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Could not open the next slot.",
      );
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-ink-0 shadow-lg ring-1 ring-ink-200">
        <header className="flex items-center justify-between gap-2 border-b border-ink-100 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ink-700" aria-hidden />
            <p className="text-sm font-semibold text-ink-1000">Open next slot</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">
          <p className="text-xs text-ink-600">
            Pick the formulation version the next slot should be produced
            against. Usually the freshly-tweaked version you saved after the
            last feedback.
          </p>
          {versions.isPending ? (
            <p className="mt-4 text-xs text-ink-500">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading versions…
            </p>
          ) : versions.isError ? (
            <p className="mt-4 text-sm text-danger">Couldn&rsquo;t load versions.</p>
          ) : (
            <ul className="mt-4 flex max-h-[50vh] flex-col gap-2 overflow-y-auto pr-1">
              {(versions.data?.items ?? []).map((v) => {
                const disabled = v.is_auto;
                return (
                  <li key={v.id}>
                    <label
                      className={
                        "flex cursor-pointer flex-col gap-1 rounded-xl border px-3 py-2 text-sm transition-colors " +
                        (disabled
                          ? "cursor-not-allowed border-ink-100 bg-ink-50/60 opacity-70"
                          : selected === v.id
                            ? "border-ink-900 bg-ink-100/40 ring-2 ring-ink-300"
                            : "border-ink-100 bg-ink-0 hover:bg-ink-50")
                      }
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="fv"
                          value={v.id}
                          checked={selected === v.id}
                          onChange={() => setSelected(v.id)}
                          disabled={disabled}
                          className="h-4 w-4"
                        />
                        <span className="font-semibold text-ink-1000">
                          {v.label}
                        </span>
                        {v.is_auto ? (
                          <span
                            title="Auto-cut on Save draft — internal restore point, not a scientist-committed milestone."
                            className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-500"
                          >
                            auto
                          </span>
                        ) : null}
                        {!v.is_complete && !v.is_auto ? (
                          <span
                            title="This version didn't pass the builder-readiness gate — the recipe may be mid-edit."
                            className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800"
                          >
                            incomplete
                          </span>
                        ) : null}
                        <span className="ml-auto text-[10px] text-ink-500">
                          {formatDate(v.created_at)}
                        </span>
                      </div>
                      {v.note ? (
                        <p className="pl-6 text-[11px] text-ink-700">
                          &ldquo;{v.note}&rdquo;
                        </p>
                      ) : null}
                      <p className="pl-6 text-[10px] text-ink-500">
                        by {v.created_by_name}
                      </p>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? (
            <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-ink-200 bg-ink-0 px-3 py-1.5 text-[11px] font-semibold text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selected || openMutation.isPending}
              onClick={() => openMutation.mutate()}
              className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-4 py-1.5 text-[11px] font-semibold text-ink-0 hover:bg-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {openMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              Open slot
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Close-cycle modal (danger-friction, three-gate confirm)
// ---------------------------------------------------------------------------


function TeamCloseModal({
  orgId,
  cycleId,
  onClose,
  onClosed,
}: {
  orgId: string;
  cycleId: string;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [ackChecked, setAckChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const CONFIRM_PHRASE = "CLOSE";
  const canSubmit =
    ackChecked &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    reason.trim().length > 0;

  const closeMutation = useMutation({
    mutationFn: async () => {
      await apiClient.post(
        `/api/organizations/${orgId}/trial-batch-cycles/${cycleId}/team-override-close/`,
        { reason },
      );
    },
    onSuccess: onClosed,
    onError: (err: unknown) => {
      setError(
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Could not close the cycle.",
      );
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-ink-0 shadow-lg ring-1 ring-red-200">
        <header className="flex items-center justify-between gap-2 rounded-t-2xl border-b border-red-200 bg-red-50 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-700" aria-hidden />
            <p className="text-sm font-semibold text-red-900">
              Close cycle — destructive
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-red-700 hover:bg-red-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">
          <div className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs text-red-900">
            <p className="font-semibold">
              This cancels every remaining awaiting slot.
            </p>
            <p className="mt-1 text-red-800">
              The customer paid for those slots and won&rsquo;t receive them.
              You can&rsquo;t undo this from the UI. Use only when the
              customer is satisfied via out-of-band contact (email, call).
              The audit trail records who + when + why.
            </p>
          </div>

          <label className="mt-4 block">
            <span className="text-[11px] font-semibold text-ink-700">
              Reason (audit trail, required)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Who confirmed and how — e.g. Customer emailed Sarah on 2026-08-20 saying slot 2 is perfect, doesn't want more samples."
              className="mt-1 w-full rounded-xl border border-ink-200 bg-ink-0 p-2.5 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
            />
          </label>

          <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-ink-800">
            <input
              type="checkbox"
              checked={ackChecked}
              onChange={(e) => setAckChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-ink-300"
            />
            <span>
              I understand this cancels every remaining awaiting slot the
              customer paid for and cannot be undone from the UI.
            </span>
          </label>

          <label className="mt-4 block">
            <span className="text-[11px] font-semibold text-ink-700">
              Type <span className="font-mono text-red-800">{CONFIRM_PHRASE}</span> to confirm
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded-full border border-ink-200 bg-ink-0 px-3 py-1.5 font-mono text-sm uppercase text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
              autoComplete="off"
            />
          </label>

          {error ? (
            <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-ink-200 bg-ink-0 px-3 py-1.5 text-[11px] font-semibold text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit || closeMutation.isPending}
              onClick={() => closeMutation.mutate()}
              className="inline-flex items-center gap-1 rounded-full bg-red-700 px-4 py-1.5 text-[11px] font-semibold text-ink-0 hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {closeMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              Close cycle permanently
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Format helpers (mirror /samples)
// ---------------------------------------------------------------------------


function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso ?? "—";
  }
}
