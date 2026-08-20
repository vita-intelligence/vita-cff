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
import { useMemo, useState } from "react";

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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [needsOnly, setNeedsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [showAllAttention, setShowAllAttention] = useState(false);

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
    const q = search.trim().toLowerCase();
    return all.filter((c) => {
      if (statusFilter !== "all" && c.status !== statusFilter) return false;
      if (needsOnly && !c.action_needed && !c.can_open_next_slot) return false;
      if (q) {
        const hay = [
          c.formulation.code,
          c.formulation.name,
          c.customer?.name ?? "",
          c.status,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, statusFilter, needsOnly, search]);

  return (
    <section className="mt-4 flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4 text-neutral-700" />
          <h1 className="text-lg font-black uppercase tracking-tight text-neutral-900">
            Trial batches
          </h1>
          <span className="border-2 border-black bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-neutral-700">
            {all.length} live
          </span>
          {needsAttention.length > 0 ? (
            <span className="border-2 border-red-700 bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-red-800">
              {needsAttention.length} need action
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          className="inline-flex items-center gap-1 border-2 border-black bg-white p-1.5 text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw className={"h-3.5 w-3.5 " + (query.isFetching ? "animate-spin" : "")} />
        </button>
      </header>

      {query.isPending ? (
        <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cycles…
        </p>
      ) : query.isError ? (
        <p className="border-2 border-red-700 bg-red-50 p-3 text-sm text-red-800">
          Couldn&rsquo;t load cycles. Try refreshing.
        </p>
      ) : all.length === 0 ? (
        <p className="border-2 border-black bg-white p-6 text-center text-xs uppercase tracking-widest text-neutral-500">
          No active trial-batch cycles.
        </p>
      ) : (
        <>
          {needsAttention.length > 0 ? (
            <AttentionPane
              orgId={orgId}
              cycles={needsAttention}
              visibleMax={showAllAttention ? needsAttention.length : ATTENTION_VISIBLE_MAX}
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
            search={search}
            onSearch={setSearch}
            statusFilter={statusFilter}
            onStatusFilter={setStatusFilter}
            needsOnly={needsOnly}
            onNeedsOnly={setNeedsOnly}
          />
        </>
      )}
    </section>
  );
}


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
    <div className="border-2 border-red-700 bg-red-50/40">
      <header className="border-b-2 border-red-700 bg-red-700 px-4 py-2.5 text-white">
        <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest">
          <AlertTriangle className="h-3.5 w-3.5" /> Needs your attention · {cycles.length}
        </p>
      </header>
      <div className="flex flex-col gap-2 p-3">
        {visible.map((c) => (
          <CycleCard key={c.id} cycle={c} orgId={orgId} />
        ))}
      </div>
      {onToggleShowAll ? (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="w-full border-t-2 border-red-700 bg-white px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-red-700 hover:bg-red-50"
        >
          {showAll ? "Show fewer" : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}


function CyclesTable({
  orgId,
  cycles,
  totalCount,
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  needsOnly,
  onNeedsOnly,
}: {
  orgId: string;
  cycles: readonly Cycle[];
  totalCount: number;
  search: string;
  onSearch: (v: string) => void;
  statusFilter: StatusFilter;
  onStatusFilter: (v: StatusFilter) => void;
  needsOnly: boolean;
  onNeedsOnly: (v: boolean) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="border-2 border-black bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-black px-3 py-2">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search formulation code, customer, status…"
            className="w-full border-2 border-black bg-white py-1.5 pl-7 pr-2 text-sm focus:outline-none"
          />
        </div>
        <StatusChip active={statusFilter === "all"} onClick={() => onStatusFilter("all")}>
          All
        </StatusChip>
        <StatusChip
          active={statusFilter === "in_progress"}
          onClick={() => onStatusFilter("in_progress")}
          tone="orange"
        >
          In progress
        </StatusChip>
        <StatusChip
          active={statusFilter === "max_reached"}
          onClick={() => onStatusFilter("max_reached")}
          tone="amber"
        >
          Max reached
        </StatusChip>
        <StatusChip
          active={statusFilter === "satisfied"}
          onClick={() => onStatusFilter("satisfied")}
          tone="emerald"
        >
          Satisfied
        </StatusChip>
        <StatusChip
          active={statusFilter === "terminated_by_team"}
          onClick={() => onStatusFilter("terminated_by_team")}
        >
          Terminated
        </StatusChip>
        <StatusChip
          active={needsOnly}
          onClick={() => onNeedsOnly(!needsOnly)}
          tone="red"
        >
          Needs action
        </StatusChip>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-black bg-neutral-100 text-[10px] uppercase tracking-widest text-neutral-600">
            <th className="w-4 px-2 py-2"></th>
            <th className="px-3 py-2 text-left font-black">Formulation</th>
            <th className="px-3 py-2 text-left font-black">Customer</th>
            <th className="px-3 py-2 text-left font-black">Active slot</th>
            <th className="px-3 py-2 text-left font-black">Status</th>
            <th className="px-3 py-2 text-left font-black">Slots</th>
            <th className="px-3 py-2 text-left font-black">Updated</th>
          </tr>
        </thead>
        <tbody>
          {cycles.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-xs uppercase tracking-widest text-neutral-500">
                {totalCount > 0 ? "No cycles match your filters." : "No active cycles."}
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
  );
}


function StatusChip({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "orange" | "amber" | "emerald" | "red";
  children: React.ReactNode;
}) {
  const activeTone =
    tone === "orange"
      ? "bg-orange-200"
      : tone === "amber"
        ? "bg-amber-200"
        : tone === "emerald"
          ? "bg-emerald-200"
          : tone === "red"
            ? "bg-red-200"
            : "bg-black text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "border-2 border-black px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors " +
        (active ? activeTone : "bg-white hover:bg-neutral-100")
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
  return (
    <>
      <tr
        className={
          "border-b border-neutral-200 hover:bg-neutral-50 " +
          (cycle.action_needed || cycle.can_open_next_slot
            ? "bg-red-50/40"
            : "")
        }
      >
        <td className="px-2 py-2 text-center">
          <button
            type="button"
            onClick={onToggle}
            title={expanded ? "Collapse" : "Expand"}
            className="text-neutral-600 hover:text-black"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        </td>
        <td className="px-3 py-2 text-sm">
          <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
            {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
          </p>
          <p className="truncate font-black uppercase">
            {cycle.formulation.name || "Untitled"}
          </p>
        </td>
        <td className="px-3 py-2 text-sm text-neutral-800">
          {cycle.customer?.name || <span className="text-neutral-400">—</span>}
        </td>
        <td className="px-3 py-2 text-xs text-neutral-800">
          {active ? (
            <span>
              #{active.sequence_no}{" "}
              <span className="text-[10px] uppercase tracking-widest text-neutral-500">
                · {active.status.replace(/_/g, " ")}
              </span>
            </span>
          ) : (
            <span className="text-neutral-400">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          <CycleStatusPill status={cycle.status} />
        </td>
        <td className="px-3 py-2 text-xs font-black">
          {cycle.slots_used}/{cycle.total_slots}
        </td>
        <td className="px-3 py-2 text-xs text-neutral-600">
          {new Date(cycle.updated_at).toLocaleDateString()}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={7} className="border-b border-neutral-200 bg-neutral-50 p-4">
            <CycleCard cycle={cycle} orgId={orgId} embedded />
          </td>
        </tr>
      ) : null}
    </>
  );
}


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

  return (
    <div className={"border-2 border-black " + (embedded ? "bg-white" : "bg-white")}>
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-black px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">
              {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
              {cycle.customer ? ` · ${cycle.customer.name}` : ""}
            </p>
            <p className="mt-0.5 truncate text-sm font-black uppercase">
              {cycle.formulation.name || "Untitled formulation"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <CycleStatusPill status={cycle.status} />
            <span className="border-2 border-black bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
              {cycle.slots_used}/{cycle.total_slots}
            </span>
          </div>
        </div>
      ) : null}

      <ul className={"flex flex-col gap-2 " + (embedded ? "p-0" : "px-4 py-3")}>
        {cycle.slots.map((slot) => (
          <SlotLine
            key={slot.id}
            slot={slot}
            totalSlots={cycle.total_slots}
            busy={busySlotId === slot.id}
            onCreateBatch={() => createAndLink.mutate(slot.id)}
          />
        ))}
      </ul>

      <div
        className={
          "flex flex-wrap items-center justify-end gap-2 " +
          (embedded ? "pt-3" : "border-t-2 border-black px-4 py-3")
        }
      >
        {cycle.can_open_next_slot ? (
          <button
            type="button"
            onClick={() => setOpenNext(true)}
            className="inline-flex items-center gap-1 border-2 border-black bg-orange-200 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest hover:bg-orange-300"
          >
            <Sparkles className="h-3 w-3" /> Open next slot
          </button>
        ) : null}
        {cycle.status === "in_progress" || cycle.status === "max_reached" ? (
          <button
            type="button"
            onClick={() => setCloseOpen(true)}
            className="inline-flex items-center gap-1 border-2 border-red-700 bg-red-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-red-800 hover:bg-red-100"
          >
            <AlertTriangle className="h-3 w-3" /> Close cycle (team override)
          </button>
        ) : null}
      </div>

      {error ? (
        <p className={"text-xs text-red-900 " + (embedded ? "mt-3 border-2 border-red-700 bg-red-100 px-3 py-2" : "border-t-2 border-red-700 bg-red-100 px-4 py-2")}>
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


function SlotLine({
  slot,
  totalSlots,
  busy,
  onCreateBatch,
}: {
  slot: Slot;
  totalSlots: number;
  busy: boolean;
  onCreateBatch: () => void;
}) {
  const icon =
    slot.status === "closed_satisfied" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700" />
    ) : slot.status === "closed_iterated" ? (
      <AlertCircle className="h-3.5 w-3.5 text-amber-700" />
    ) : slot.status === "closed_cancelled" ? (
      <X className="h-3.5 w-3.5 text-neutral-400" />
    ) : slot.status === "delivered" || slot.status === "feedback_pending" ? (
      <ChevronRight className="h-3.5 w-3.5 text-orange-600" />
    ) : slot.status === "in_production" || slot.status === "shipped" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-600" />
    ) : (
      <Sparkles className="h-3.5 w-3.5 text-neutral-500" />
    );
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border border-neutral-300 bg-white px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-xs font-black uppercase">
          Slot {slot.sequence_no}/{totalSlots}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          {slot.formulation_version_label}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          · {slot.status.replace(/_/g, " ")}
        </span>
      </div>
      {slot.status === "awaiting_scientist" ? (
        <button
          type="button"
          disabled={busy}
          onClick={onCreateBatch}
          className="inline-flex items-center gap-1 border-2 border-black bg-black px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          Create sample batch
        </button>
      ) : slot.trial_batch_id ? (
        <a
          href={`/formulations/${slot.formulation_version_id}/trial-batches/${slot.trial_batch_id}`}
          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-neutral-700 hover:text-black"
        >
          Open batch <ChevronRight className="h-3 w-3" />
        </a>
      ) : null}
      {slot.status === "closed_iterated" && slot.feedback_summary ? (
        <p className="w-full border-t border-neutral-200 pt-2 text-xs text-neutral-700">
          <span className="font-bold uppercase tracking-widest text-neutral-500">
            Feedback:
          </span>{" "}
          {slot.feedback_summary}
        </p>
      ) : null}
    </li>
  );
}


function CycleStatusPill({ status }: { status: CycleStatus }) {
  const tone =
    status === "satisfied"
      ? "bg-emerald-200 text-black"
      : status === "terminated_by_team"
        ? "bg-neutral-200 text-black"
        : status === "max_reached"
          ? "bg-amber-200 text-black"
          : "bg-orange-200 text-black";
  return (
    <span
      className={
        "border-2 border-black px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest " +
        tone
      }
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}


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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg border-2 border-black bg-white">
        <header className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-3 text-white">
          <p className="text-xs font-bold uppercase tracking-widest">Open next slot</p>
          <button
            type="button"
            onClick={onClose}
            className="border-2 border-white p-1 hover:bg-white hover:text-black"
          >
            <X className="h-3 w-3" />
          </button>
        </header>
        <div className="p-4">
          <p className="text-xs text-neutral-700">
            Pick the formulation version the next slot should be produced against.
            Usually the freshly-tweaked version you saved after the last feedback.
          </p>
          {versions.isPending ? (
            <p className="mt-4 inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-600">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading versions…
            </p>
          ) : versions.isError ? (
            <p className="mt-4 text-sm text-red-700">Couldn&rsquo;t load versions.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {(versions.data?.items ?? []).map((v) => (
                <li key={v.id}>
                  <label className="flex cursor-pointer items-center gap-2 border-2 border-black bg-white px-3 py-2 hover:bg-orange-50">
                    <input
                      type="radio"
                      name="fv"
                      value={v.id}
                      checked={selected === v.id}
                      onChange={() => setSelected(v.id)}
                      className="h-4 w-4"
                    />
                    <span className="font-black uppercase">{v.label}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-widest text-neutral-500">
                      {new Date(v.created_at).toLocaleDateString()}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error ? (
            <p className="mt-4 border-2 border-red-700 bg-red-100 px-3 py-2 text-sm text-red-900">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest hover:bg-neutral-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selected || openMutation.isPending}
              onClick={() => openMutation.mutate()}
              className="inline-flex items-center gap-1 border-2 border-black bg-black px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg border-2 border-red-700 bg-white">
        <header className="flex items-center justify-between border-b-2 border-red-700 bg-red-700 px-4 py-3 text-white">
          <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest">
            <AlertTriangle className="h-4 w-4" /> Close cycle — destructive
          </p>
          <button
            type="button"
            onClick={onClose}
            className="border-2 border-white p-1 hover:bg-white hover:text-red-700"
          >
            <X className="h-3 w-3" />
          </button>
        </header>
        <div className="p-4">
          <div className="border-2 border-red-700 bg-red-50 p-3 text-xs text-red-900">
            <p className="font-black uppercase tracking-widest">
              This cancels every remaining awaiting slot
            </p>
            <p className="mt-1">
              The customer paid for those slots and won&rsquo;t receive them.
              You can&rsquo;t undo this from the UI. Use only when the customer
              is satisfied via out-of-band contact (email, call). The audit
              trail records who + when + why.
            </p>
          </div>

          <label className="mt-4 block">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              Reason (audit trail, required)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Who confirmed and how — e.g. Customer emailed Sarah on 2026-08-20 saying slot 2 is perfect, doesn't want more samples."
              className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none"
            />
          </label>

          <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={ackChecked}
              onChange={(e) => setAckChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 border-2 border-black"
            />
            <span>
              I understand this cancels every remaining awaiting slot the
              customer paid for and cannot be undone from the UI.
            </span>
          </label>

          <label className="mt-4 block">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              Type <span className="font-mono text-red-800">{CONFIRM_PHRASE}</span> to confirm
            </span>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full border-2 border-black bg-white px-3 py-2 font-mono text-sm uppercase focus:outline-none"
              autoComplete="off"
            />
          </label>

          {error ? (
            <p className="mt-4 border-2 border-red-700 bg-red-100 px-3 py-2 text-sm text-red-900">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest hover:bg-neutral-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit || closeMutation.isPending}
              onClick={() => closeMutation.mutate()}
              className="inline-flex items-center gap-1 border-2 border-red-700 bg-red-700 px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_0_rgb(185,28,28)] disabled:cursor-not-allowed disabled:opacity-50"
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
