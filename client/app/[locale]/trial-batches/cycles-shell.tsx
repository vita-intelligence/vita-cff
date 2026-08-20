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
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  AlertTriangle,
  Beaker,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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


interface CyclesResponse {
  readonly items: readonly Cycle[];
  readonly counts: { readonly total: number; readonly needs_attention: number };
}


interface FormulationVersionOption {
  readonly id: string;
  readonly label: string;
  readonly created_at: string;
}


const CYCLES_KEY = "trial-batch-cycles";
const ATTENTION_VISIBLE_MAX = 5;

type StatusFilter = "all" | CycleStatus;


export function TrialCyclesShell({ orgId }: { orgId: string }) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [needsOnly, setNeedsOnly] = useState(false);
  const [showAllAttention, setShowAllAttention] = useState(false);

  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(searchInput.trim().toLowerCase()),
      250,
    );
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = useQuery<CyclesResponse>({
    queryKey: [rootQueryKey, CYCLES_KEY, orgId],
    queryFn: async () => {
      const { data } = await apiClient.get<CyclesResponse>(
        `/api/organizations/${orgId}/trial-batch-cycles/`,
      );
      return data;
    },
    refetchOnWindowFocus: false,
  });

  const all = query.data?.items ?? [];
  const needsAttention = useMemo(
    () => all.filter((c) => c.action_needed || c.can_open_next_slot),
    [all],
  );

  const filtered = useMemo(() => {
    return all.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (needsOnly && !c.action_needed && !c.can_open_next_slot) return false;
      if (debouncedSearch) {
        const hay = [
          c.formulation.code,
          c.formulation.name,
          c.customer?.name ?? "",
          c.status,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(debouncedSearch)) return false;
      }
      return true;
    });
  }, [all, statusFilter, needsOnly, debouncedSearch]);

  return (
    <section className="mt-6 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            Trial batches
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Custom-formulation projects producing samples slot-by-slot.
            Cycles above need a click; browse the table for everything else.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SearchBar value={searchInput} onChange={setSearchInput} />
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-ink-200 bg-ink-0 text-ink-600 hover:bg-ink-50 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw
              className={"h-4 w-4 " + (query.isFetching ? "animate-spin" : "")}
            />
          </button>
        </div>
      </header>

      {query.isPending ? (
        <p className="p-6 text-center text-xs text-ink-500">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading cycles…
        </p>
      ) : query.isError ? (
        <p className="rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
          Couldn&rsquo;t load cycles. Refresh to try again.
        </p>
      ) : all.length === 0 ? (
        <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
          <Beaker className="mx-auto h-6 w-6 text-ink-400" aria-hidden />
          <p className="mt-2 text-sm text-ink-600">
            No active trial-batch cycles.
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Cycles are seeded when finance approves a bundled deposit for a
            custom-formulation project.
          </p>
        </div>
      ) : (
        <>
          {needsAttention.length > 0 ? (
            <AttentionPane
              orgId={orgId}
              cycles={needsAttention}
              visibleMax={
                showAllAttention ? needsAttention.length : ATTENTION_VISIBLE_MAX
              }
              onToggleShowAll={
                needsAttention.length > ATTENTION_VISIBLE_MAX
                  ? () => setShowAllAttention((v) => !v)
                  : null
              }
              showAll={showAllAttention}
            />
          ) : null}

          <CyclesTable
            orgId={orgId}
            cycles={filtered}
            totalCount={all.length}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            needsOnly={needsOnly}
            onNeedsOnly={setNeedsOnly}
            hasSearch={debouncedSearch.length > 0}
          />
        </>
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Attention pane
// ---------------------------------------------------------------------------


function AttentionPane({
  orgId,
  cycles,
  visibleMax,
  onToggleShowAll,
  showAll,
}: {
  orgId: string;
  cycles: readonly Cycle[];
  visibleMax: number;
  onToggleShowAll: (() => void) | null;
  showAll: boolean;
}) {
  const visible = cycles.slice(0, visibleMax);
  const hidden = cycles.length - visible.length;
  return (
    <article className="flex flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-amber-200">
      <header className="flex items-center justify-between gap-2 border-b border-amber-200 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden />
          <h2 className="text-sm font-semibold text-ink-1000">
            Needs your attention
          </h2>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
            {cycles.length}
          </span>
        </div>
        <p className="hidden text-[11px] text-ink-500 sm:block">
          Awaiting a click from you — create a batch or open the next slot.
        </p>
      </header>
      <div className="flex flex-col gap-3 p-4">
        {visible.map((c) => (
          <CycleCard key={c.id} cycle={c} orgId={orgId} />
        ))}
      </div>
      {onToggleShowAll ? (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="border-t border-amber-200 p-3 text-[11px] font-semibold text-amber-800 hover:bg-amber-50"
        >
          {showAll ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </article>
  );
}


// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------


function CyclesTable({
  orgId,
  cycles,
  totalCount,
  statusFilter,
  onStatusFilter,
  needsOnly,
  onNeedsOnly,
  hasSearch,
}: {
  orgId: string;
  cycles: readonly Cycle[];
  totalCount: number;
  statusFilter: StatusFilter;
  onStatusFilter: (v: StatusFilter) => void;
  needsOnly: boolean;
  onNeedsOnly: (v: boolean) => void;
  hasSearch: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <article className="flex flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 p-4">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-ink-700" aria-hidden />
          <h2 className="text-sm font-semibold text-ink-1000">All cycles</h2>
          <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-700">
            {cycles.length}
            {cycles.length !== totalCount ? ` of ${totalCount}` : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={statusFilter === "all"} onClick={() => onStatusFilter("all")}>
            All
          </FilterChip>
          <FilterChip
            active={statusFilter === "in_progress"}
            onClick={() => onStatusFilter("in_progress")}
            tone="sky"
          >
            In progress
          </FilterChip>
          <FilterChip
            active={statusFilter === "max_reached"}
            onClick={() => onStatusFilter("max_reached")}
            tone="amber"
          >
            Max reached
          </FilterChip>
          <FilterChip
            active={statusFilter === "satisfied"}
            onClick={() => onStatusFilter("satisfied")}
            tone="emerald"
          >
            Satisfied
          </FilterChip>
          <FilterChip
            active={statusFilter === "terminated_by_team"}
            onClick={() => onStatusFilter("terminated_by_team")}
          >
            Terminated
          </FilterChip>
          <span className="mx-1 h-4 w-px bg-ink-200" aria-hidden />
          <FilterChip
            active={needsOnly}
            onClick={() => onNeedsOnly(!needsOnly)}
            tone="amber"
          >
            Needs action
          </FilterChip>
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-ink-500">
              <th className="w-6 px-3 py-2"></th>
              <th className="px-3 py-2 font-medium">Formulation</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Active slot</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Slots</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {cycles.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-xs text-ink-500">
                  {hasSearch || statusFilter !== "all" || needsOnly
                    ? "Nothing matches your filters."
                    : "No active cycles."}
                </td>
              </tr>
            ) : (
              cycles.map((c) => (
                <CycleRow
                  key={c.id}
                  cycle={c}
                  orgId={orgId}
                  expanded={expandedId === c.id}
                  onToggle={() =>
                    setExpandedId(expandedId === c.id ? null : c.id)
                  }
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}


function FilterChip({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "sky" | "amber" | "emerald";
  children: React.ReactNode;
}) {
  const activeTone =
    tone === "sky"
      ? "bg-sky-100 text-sky-800 ring-sky-200"
      : tone === "amber"
        ? "bg-amber-100 text-amber-800 ring-amber-200"
        : tone === "emerald"
          ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
          : "bg-ink-900 text-ink-0 ring-ink-900";
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-2.5 py-1 text-[10px] font-semibold ring-1 transition-colors " +
        (active
          ? activeTone
          : "bg-ink-0 text-ink-600 ring-ink-200 hover:bg-ink-50")
      }
    >
      {children}
    </button>
  );
}


function CycleRow({
  cycle,
  orgId,
  expanded,
  onToggle,
}: {
  cycle: Cycle;
  orgId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const active = cycle.slots.find((s) => s.id === cycle.active_slot_id);
  const highlight = cycle.action_needed || cycle.can_open_next_slot;
  return (
    <>
      <tr
        className={
          "border-t border-ink-100 hover:bg-ink-50 " +
          (highlight ? "bg-amber-50/50" : "")
        }
      >
        <td className="px-3 py-3 align-top">
          <button
            type="button"
            onClick={onToggle}
            title={expanded ? "Collapse" : "Expand"}
            className="text-ink-500 hover:text-ink-1000"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="px-3 py-3 align-top">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {cycle.formulation.name || "Untitled formulation"}
          </p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-500">
            {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
          </p>
        </td>
        <td className="px-3 py-3 align-top text-xs text-ink-700">
          {cycle.customer?.name || <span className="text-ink-400">—</span>}
        </td>
        <td className="px-3 py-3 align-top text-xs text-ink-700">
          {active ? (
            <>
              <span className="font-semibold text-ink-1000">#{active.sequence_no}</span>{" "}
              <span className="text-ink-500">
                · {active.status.replace(/_/g, " ")}
              </span>
            </>
          ) : (
            <span className="text-ink-400">—</span>
          )}
        </td>
        <td className="px-3 py-3 align-top">
          <CycleStatusPill status={cycle.status} />
        </td>
        <td className="px-3 py-3 align-top text-xs font-semibold tabular-nums text-ink-800">
          {cycle.slots_used}/{cycle.total_slots}
        </td>
        <td className="px-3 py-3 align-top text-[11px] text-ink-500">
          {formatDate(cycle.updated_at)}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-t border-ink-100 bg-ink-50/60">
          <td colSpan={7} className="p-4">
            <CycleCard cycle={cycle} orgId={orgId} embedded />
          </td>
        </tr>
      ) : null}
    </>
  );
}


// ---------------------------------------------------------------------------
// Cycle card (attention + expanded row)
// ---------------------------------------------------------------------------


function CycleCard({
  cycle,
  orgId,
  embedded = false,
}: {
  cycle: Cycle;
  orgId: string;
  embedded?: boolean;
}) {
  const queryClient = useQueryClient();
  const [busySlotId, setBusySlotId] = useState<string | null>(null);
  const [openNext, setOpenNext] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: [rootQueryKey, CYCLES_KEY, orgId],
    });

  const createAndLink = useMutation({
    mutationFn: async (slotId: string) => {
      const { data } = await apiClient.post(
        `/api/organizations/${orgId}/trial-batch-cycles/${cycle.id}/slots/${slotId}/create-and-link-batch/`,
        {},
      );
      return data;
    },
    onMutate: (slotId: string) => setBusySlotId(slotId),
    onSuccess: () => invalidate(),
    onError: (err: unknown) => {
      setError(
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Could not create the batch.",
      );
    },
    onSettled: () => setBusySlotId(null),
  });

  const shell = embedded
    ? "flex flex-col gap-3"
    : "flex flex-col gap-3 rounded-xl border border-ink-100 bg-ink-0 p-4 shadow-sm";

  return (
    <div className={shell}>
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink-1000">
              {cycle.formulation.name || "Untitled formulation"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-500">
              <span className="font-mono">
                {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
              </span>
              {cycle.customer ? ` · ${cycle.customer.name}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CycleStatusPill status={cycle.status} />
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-ink-700">
              {cycle.slots_used}/{cycle.total_slots}
            </span>
          </div>
        </div>
      ) : null}

      <ul className="flex flex-col gap-2">
        {cycle.slots.map((slot) => (
          <SlotLine
            key={slot.id}
            slot={slot}
            busy={busySlotId === slot.id}
            onCreateBatch={() => createAndLink.mutate(slot.id)}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {cycle.can_open_next_slot ? (
          <button
            type="button"
            onClick={() => setOpenNext(true)}
            className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-3 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Sparkles className="h-3 w-3" /> Open next slot
          </button>
        ) : null}
        {cycle.status === "in_progress" || cycle.status === "max_reached" ? (
          <button
            type="button"
            onClick={() => setCloseOpen(true)}
            className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-3 py-1 text-[10px] font-semibold text-red-800 hover:bg-red-100"
          >
            <AlertTriangle className="h-3 w-3" /> Close cycle
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/5 p-2 text-xs text-danger">
          {error}
        </p>
      ) : null}

      {openNext ? (
        <OpenNextSlotModal
          orgId={orgId}
          cycleId={cycle.id}
          onClose={() => setOpenNext(false)}
          onOpened={() => {
            setOpenNext(false);
            invalidate();
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
            invalidate();
          }}
        />
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Slot line
// ---------------------------------------------------------------------------


function SlotLine({
  slot,
  busy,
  onCreateBatch,
}: {
  slot: Slot;
  busy: boolean;
  onCreateBatch: () => void;
}) {
  const icon =
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
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 bg-ink-0 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {icon}
        <span className="font-semibold text-ink-1000">
          Slot #{slot.sequence_no}
        </span>
        <span className="text-[10px] text-ink-500">
          {slot.formulation_version_label}
        </span>
        <span className="text-[10px] text-ink-500">
          · {slot.status.replace(/_/g, " ")}
        </span>
      </div>
      {slot.status === "awaiting_scientist" ? (
        <button
          type="button"
          disabled={busy}
          onClick={onCreateBatch}
          className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-3 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          Create sample batch
        </button>
      ) : slot.trial_batch_id && slot.formulation_id ? (
        <a
          href={`/formulations/${slot.formulation_id}/trial-batches/${slot.trial_batch_id}`}
          className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-3 py-1 text-[10px] font-semibold text-ink-700 hover:bg-ink-50"
        >
          Open batch <ChevronRight className="h-3 w-3" />
        </a>
      ) : null}
      {slot.status === "closed_iterated" && slot.feedback_summary ? (
        <p className="w-full border-t border-ink-100 pt-2 text-[11px] text-ink-700">
          <span className="font-semibold text-ink-500">Feedback:</span>{" "}
          {slot.feedback_summary}
        </p>
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
            <ul className="mt-4 flex flex-col gap-2">
              {(versions.data?.items ?? []).map((v) => (
                <li key={v.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-ink-100 bg-ink-0 px-3 py-2 text-sm hover:bg-ink-50">
                    <input
                      type="radio"
                      name="fv"
                      value={v.id}
                      checked={selected === v.id}
                      onChange={() => setSelected(v.id)}
                      className="h-4 w-4"
                    />
                    <span className="font-semibold text-ink-1000">{v.label}</span>
                    <span className="ml-auto text-[10px] text-ink-500">
                      {formatDate(v.created_at)}
                    </span>
                  </label>
                </li>
              ))}
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
