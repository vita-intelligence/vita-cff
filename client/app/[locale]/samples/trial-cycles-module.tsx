"use client";

/**
 * Trial-batch cycles module for the /samples page.
 *
 * Sits above the sample-fulfilment queue and gives the scientist
 * one-click access to every action a live cycle needs:
 *
 *   * ``Create sample batch`` — spawns a TrialBatch against the
 *     slot's ``formulation_version`` snapshot and links it
 *     atomically. Slot flips to IN_PRODUCTION; scientist can
 *     then jump into the batch detail to press "Create MO on PSP".
 *   * ``Open next slot`` — after a customer's NEEDS_ITERATION
 *     verdict; picks a freshly-saved FormulationVersion to bind.
 *   * ``Close cycle`` — team-override close when the customer is
 *     satisfied via out-of-band contact.
 *
 * Fetches from ``GET /api/organizations/<org>/trial-batch-cycles/``.
 * Mutations invalidate the same key so counts + slot rows update
 * in place.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle,
  Beaker,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";

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


interface Cycle {
  readonly id: string;
  readonly status: CycleStatus;
  readonly total_slots: number;
  readonly slots_used: number;
  readonly closed_at: string | null;
  readonly formulation: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
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


export function TrialCyclesModule({ orgId }: { orgId: string }) {
  const [bucket, setBucket] = useState<"all" | "needs_attention">(
    "needs_attention",
  );
  const query = useQuery<CyclesResponse>({
    queryKey: [rootQueryKey, CYCLES_KEY, orgId, bucket],
    queryFn: async () => {
      const { data } = await apiClient.get<CyclesResponse>(
        `/api/organizations/${orgId}/trial-batch-cycles/${
          bucket === "needs_attention" ? "?bucket=needs_attention" : ""
        }`,
      );
      return data;
    },
    refetchOnWindowFocus: false,
  });

  const counts = query.data?.counts ?? { total: 0, needs_attention: 0 };
  const items = query.data?.items ?? [];

  return (
    <section className="mb-8 border-2 border-black bg-white">
      <header className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Beaker className="h-4 w-4" />
          <p className="text-xs font-bold uppercase tracking-widest">
            Trial batches in flight
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setBucket(bucket === "all" ? "needs_attention" : "all")
            }
            className="inline-flex items-center gap-1 border-2 border-white bg-black px-2 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-white hover:text-black"
          >
            {bucket === "needs_attention"
              ? `Needs attention · ${counts.needs_attention}`
              : `All · ${counts.total}`}
          </button>
          <button
            type="button"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            title="Refresh"
            className="inline-flex items-center gap-1 border-2 border-white bg-black p-1 hover:bg-white hover:text-black disabled:opacity-50"
          >
            <RefreshCw
              className={
                "h-3 w-3 " + (query.isFetching ? "animate-spin" : "")
              }
            />
          </button>
        </div>
      </header>

      <div className="p-4">
        {query.isPending ? (
          <p className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading cycles…
          </p>
        ) : query.isError ? (
          <p className="text-sm text-red-700">
            Couldn&rsquo;t load cycles. Try refreshing.
          </p>
        ) : items.length === 0 ? (
          <p className="text-xs uppercase tracking-widest text-neutral-500">
            {bucket === "needs_attention"
              ? "Nothing needs your attention right now."
              : "No active trial-batch cycles."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((cycle) => (
              <CycleRow key={cycle.id} cycle={cycle} orgId={orgId} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


function CycleRow({ cycle, orgId }: { cycle: Cycle; orgId: string }) {
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
    <li className="border-2 border-black bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-black px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            {cycle.formulation.code || cycle.formulation.id.slice(0, 8)}
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

      <ul className="flex flex-col gap-2 px-4 py-3">
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

      <div className="flex flex-wrap items-center justify-end gap-2 border-t-2 border-black px-4 py-3">
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
            className="inline-flex items-center gap-1 border-2 border-black bg-white px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest hover:bg-neutral-100"
          >
            <X className="h-3 w-3" /> Close cycle (team override)
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="border-t-2 border-red-700 bg-red-100 px-4 py-2 text-xs text-red-900">
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
    </li>
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
    <li className="flex flex-wrap items-center justify-between gap-2 border border-neutral-300 bg-neutral-50 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-xs font-black uppercase">
          Slot {slot.sequence_no}/{totalSlots}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-neutral-500">
          {slot.formulation_version_label}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          · {slot.status.replace("_", " ")}
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
      {status.replace("_", " ")}
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
          <p className="text-xs font-bold uppercase tracking-widest">
            Open next slot
          </p>
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
            Pick the formulation version the next slot should be produced
            against. Usually the freshly-tweaked version you saved after the
            last feedback.
          </p>
          {versions.isPending ? (
            <p className="mt-4 inline-flex items-center gap-2 text-xs uppercase tracking-widest text-neutral-600">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading versions…
            </p>
          ) : versions.isError ? (
            <p className="mt-4 text-sm text-red-700">
              Couldn&rsquo;t load versions.
            </p>
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
  const [error, setError] = useState<string | null>(null);
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
      <div className="w-full max-w-lg border-2 border-black bg-white">
        <header className="flex items-center justify-between border-b-2 border-black bg-black px-4 py-3 text-white">
          <p className="text-xs font-bold uppercase tracking-widest">
            Close cycle (team override)
          </p>
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
            Use when the customer&rsquo;s satisfied via out-of-band contact.
            Remaining awaiting slots auto-cancel; final-spec-sign unlocks.
          </p>
          <label className="mt-4 block">
            <span className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              Reason (audit trail)
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              placeholder="Why are we closing this early?"
              className="mt-1 w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none"
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
              disabled={closeMutation.isPending}
              onClick={() => closeMutation.mutate()}
              className="inline-flex items-center gap-1 border-2 border-black bg-black px-4 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {closeMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
              Close cycle
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
