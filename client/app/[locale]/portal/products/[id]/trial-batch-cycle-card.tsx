"use client";

/**
 * NPD-portal trial-batch cycle card.
 *
 * Fetches the cycle snapshot from
 * ``/api/portal/projects/<formulation_id>/trial-batches/`` on mount,
 * renders the slot ladder, the feedback form on the active DELIVERED
 * slot, and the "Request another sample" affordance when the cycle
 * runs out of paid-for slots. On any state change asks the parent
 * server component for a re-render via ``router.refresh()`` so the
 * pipeline chip and the enclosing NoActionBanner suppression update
 * in lockstep.
 *
 * Wire types + fetch shape mirror the web-site portal's
 * ``TrialBatchCycleCard`` one-for-one so both portals convey the
 * same options.
 */

import { Check, CheckCircle2, Circle, FlaskConical, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";


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
  readonly keep_producing_remaining: boolean;
  readonly trial_batch_id: string | null;
  /** Live pulled from PSP on every fetch. ``"not_pushed"`` = batch
   *  linked but scientist hasn't spawned a PSP MO. ``"in_progress"``
   *  = at least one stage MO is non-terminal. ``"completed"`` = every
   *  stage finished — the "I've received it" button unlocks off this
   *  signal, matching how the storefront sample-detail view only
   *  shows Confirm-delivery once PSP marks the shipment picked-up. */
  readonly production_state:
    | "not_pushed"
    | "in_progress"
    | "completed"
    | "unknown";
  readonly production_stages_total: number;
  readonly production_stages_done: number;
}


interface AdditionalRequest {
  readonly id: string;
  readonly requested_quantity: number;
  readonly currency_code: string;
  readonly total_amount_snapshot: string;
  readonly status: "awaiting_finance" | "approved" | "rejected";
}


interface Cycle {
  readonly id: string;
  readonly status: CycleStatus;
  readonly total_slots: number;
  readonly slots_used: number;
  readonly slots: readonly Slot[];
  readonly active_slot_id: string | null;
  readonly additional_requests: readonly AdditionalRequest[];
}


export function TrialBatchCycleCard({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ cycle: Cycle }>(
        `/api/portal/projects/${projectId}/trial-batches/`,
      );
      setCycle(data.cycle);
      setPhase("ready");
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
      setPhase("error");
    }
  }, [projectId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  if (phase === "loading") {
    return (
      <div className="mt-4 border-2 border-black bg-white p-4 text-xs uppercase tracking-widest text-neutral-600">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your samples…
        </span>
      </div>
    );
  }
  if (phase === "error" || !cycle) {
    return (
      <div className="mt-4 border-2 border-black bg-white p-4 text-sm text-red-700">
        Couldn&rsquo;t load your trial batches. Please refresh.
      </div>
    );
  }

  const activeSlot = cycle.slots.find((s) => s.id === cycle.active_slot_id);
  const inFeedback =
    activeSlot &&
    (activeSlot.status === "delivered" || activeSlot.status === "feedback_pending");
  const inProduction =
    activeSlot &&
    (activeSlot.status === "in_production" ||
      activeSlot.status === "shipped" ||
      activeSlot.status === "awaiting_scientist");
  const cycleDone = cycle.status === "satisfied" || cycle.status === "terminated_by_team";
  const maxReached = cycle.status === "max_reached";

  return (
    <section className="mb-10 border-2 border-black bg-orange-50 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black bg-orange-500 text-black">
          <FlaskConical className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Trial batches
          </p>
          <p className="mt-1 text-lg font-black uppercase leading-tight">
            {cycleDone
              ? "You're happy — final spec incoming."
              : maxReached
                ? `All ${cycle.total_slots} samples sent — what next?`
                : `Sample ${activeSlot?.sequence_no ?? cycle.slots_used} of ${cycle.total_slots}${sampleHeaderSuffix(activeSlot)}`}
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {cycleDone
              ? "We're preparing the final specification. Sign it to authorise full production."
              : maxReached
                ? "Let us know if you're satisfied, or request another sample below."
                : "One sample at a time. Give feedback on each and we'll iterate until it's right."}
          </p>
        </div>
      </div>

      <ul className="mt-5 flex flex-col gap-2">
        {cycle.slots.map((slot) => (
          <SlotRow key={slot.id} slot={slot} totalSlots={cycle.total_slots} />
        ))}
      </ul>

      {inFeedback && activeSlot ? (
        <FeedbackForm
          slot={activeSlot}
          totalSlots={cycle.total_slots}
          busy={busy}
          onSubmit={async ({ verdict, feedback, keepProducing }) => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.post(
                `/api/portal/trial-batches/slots/${activeSlot.id}/feedback/`,
                {
                  verdict,
                  feedback_summary: feedback,
                  keep_producing_remaining: keepProducing,
                },
              );
              await refetch();
              router.refresh();
            } catch (err: unknown) {
              setError(portalErrorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {inProduction && activeSlot ? (
        <ProductionStrip slot={activeSlot} />
      ) : null}

      {inProduction && activeSlot && activeSlot.trial_batch_id
        && activeSlot.production_state === "completed" ? (
        <div className="mt-4">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post(
                  `/api/portal/trial-batches/slots/${activeSlot.id}/confirm-delivery/`,
                );
                await refetch();
                router.refresh();
              } catch (err: unknown) {
                setError(portalErrorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            I&rsquo;ve received it
          </button>
        </div>
      ) : null}

      {(maxReached || cycleDone) && cycle.status !== "terminated_by_team" ? (
        <RequestMoreControl
          currency={cycle.additional_requests[0]?.currency_code ?? "GBP"}
          busy={busy}
          onRequested={async (qty) => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.post(
                `/api/portal/projects/${projectId}/trial-batches/request-more/`,
                { quantity: qty },
              );
              await refetch();
              router.refresh();
            } catch (err: unknown) {
              setError(portalErrorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {cycle.additional_requests.length > 0 ? (
        <div className="mt-4 border-t-2 border-black pt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Top-up requests
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {cycle.additional_requests.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between text-xs text-neutral-800"
              >
                <span>
                  {r.requested_quantity} sample
                  {r.requested_quantity !== 1 ? "s" : ""} · {r.currency_code}{" "}
                  {r.total_amount_snapshot}
                </span>
                <span
                  className={
                    "border-2 border-black px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest " +
                    (r.status === "approved"
                      ? "bg-emerald-200 text-black"
                      : r.status === "rejected"
                        ? "bg-red-200 text-black"
                        : "bg-amber-200 text-black")
                  }
                >
                  {r.status.replace("_", " ")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 border-2 border-red-700 bg-red-100 px-3 py-2 text-sm font-medium text-red-900">
          {error}
        </p>
      ) : null}
    </section>
  );
}


// Pipeline strip for the active in-production slot — mirrors the
// storefront /portal/samples/[id] roadmap so a customer moving
// between a sample-kit order and a cycle sample sees the same
// visual language. Stages:
//   1. Batch prepared        (trial_batch linked)
//   2. In production         (production_state=in_progress)
//   3. Ready to confirm      (production_state=completed)
// The "I've received it" button only unlocks when stage 3 lights up.
// Header suffix that reflects the active slot's actual status so the
// customer never reads "Sample 1 of 3" flat while the slot is
// awaiting the scientist. Kept as a tiny helper next to the strip
// so header and strip stay in lockstep.
function sampleHeaderSuffix(slot: Slot | undefined): string {
  if (!slot) return "";
  switch (slot.status) {
    case "awaiting_scientist":
      return " — waiting for R&D";
    case "in_production":
    case "shipped":
      if (slot.production_state === "completed") return " — ready for you";
      return " — in production";
    case "delivered":
    case "feedback_pending":
      return " — ready for your feedback";
    default:
      return "";
  }
}


function ProductionStrip({ slot }: { slot: Slot }) {
  const hasBatch = Boolean(slot.trial_batch_id);
  const isReceived =
    slot.status === "delivered" || slot.status === "feedback_pending";
  const productionState = slot.production_state;
  const productionDone = productionState === "completed";
  const productionRunning =
    productionState === "in_progress" ||
    productionState === "not_pushed" ||
    productionState === "unknown";
  const total = slot.production_stages_total;
  const done = slot.production_stages_done;

  // Every stage has a distinct copy per state (done / current /
  // future) so the future-stage detail never bleeds into a
  // spinner-flavoured message like "Live status will refresh in a
  // moment" when we're still waiting on an earlier stage.
  const batchState: "done" | "current" | "future" = hasBatch ? "done" : "current";
  const productionStage: "done" | "current" | "future" = productionDone
    ? "done"
    : hasBatch
      ? "current"
      : "future";
  const readyStage: "done" | "current" | "future" = isReceived
    ? "done"
    : productionDone
      ? "current"
      : "future";

  const stages: ReadonlyArray<{
    key: string;
    label: string;
    state: "done" | "current" | "future";
    detail: string;
  }> = [
    {
      key: "batch",
      label: "Batch prepared",
      state: batchState,
      detail:
        batchState === "done"
          ? "Your R&D scientist has spun up the run."
          : "Waiting for your R&D scientist to open the batch.",
    },
    {
      key: "production",
      label:
        productionStage === "current" && productionState === "in_progress" && total > 0
          ? `In production (${done}/${total} stages)`
          : "In production",
      state: productionStage,
      detail:
        productionStage === "done"
          ? "Every stage is complete — your sample is ready."
          : productionStage === "future"
            ? "Starts once your scientist opens the batch."
            : productionState === "not_pushed"
              ? "Your scientist will push this to the shop floor shortly."
              : productionState === "unknown"
                ? "Live status will refresh in a moment."
                : "The shop floor is producing your sample right now.",
    },
    {
      key: "ready",
      label: "Ready — waiting for you",
      state: readyStage,
      detail:
        readyStage === "done"
          ? "Thanks — we've marked it received."
          : readyStage === "current"
            ? "It's on the way. Click below the moment it lands."
            : productionRunning && hasBatch
              ? "You'll get to confirm receipt once production wraps."
              : "Unlocks after the batch is produced.",
    },
  ];
  return (
    <ol className="mt-4 flex flex-col gap-1.5">
      {stages.map((s) => {
        const dot =
          s.state === "done" ? (
            <Check className="h-3 w-3 text-emerald-700" />
          ) : s.state === "current" ? (
            <Loader2 className="h-3 w-3 animate-spin text-orange-600" />
          ) : (
            <Circle className="h-3 w-3 text-neutral-400" />
          );
        return (
          <li key={s.key} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2 border-black bg-white">
              {dot}
            </span>
            <div className="min-w-0">
              <p className="font-black uppercase leading-tight">{s.label}</p>
              <p className="text-neutral-600">{s.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}


function SlotRow({ slot, totalSlots }: { slot: Slot; totalSlots: number }) {
  const icon =
    slot.status === "closed_satisfied" || slot.status === "closed_iterated" ? (
      <Check className="h-3.5 w-3.5 text-emerald-700" />
    ) : slot.status === "closed_cancelled" ? (
      <Circle className="h-3.5 w-3.5 text-neutral-400" />
    ) : slot.status === "delivered" || slot.status === "feedback_pending" ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-orange-600" />
    ) : slot.status === "in_production" || slot.status === "shipped" ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-600" />
    ) : (
      <Circle className="h-3.5 w-3.5 text-neutral-500" />
    );
  const label =
    slot.status === "closed_satisfied"
      ? "You confirmed this is right"
      : slot.status === "closed_iterated"
        ? "Iterating from your feedback"
        : slot.status === "closed_cancelled"
          ? "Skipped"
          : slot.status === "delivered" || slot.status === "feedback_pending"
            ? "Delivered — ready for feedback"
            : slot.status === "in_production" && slot.production_state === "completed"
              ? "Production complete — waiting for you to confirm receipt"
              : slot.status === "in_production" && slot.production_state === "in_progress"
                ? `In production (${slot.production_stages_done}/${slot.production_stages_total})`
                : slot.status === "in_production" || slot.status === "shipped"
                  ? "In production"
                  : slot.status === "awaiting_scientist"
                    ? "Scientist preparing"
                    : slot.status;
  return (
    <li className="flex items-center justify-between border-2 border-black bg-white px-3 py-2">
      <span className="flex items-center gap-2 text-sm">
        {icon}
        <span className="font-black">
          Sample {slot.sequence_no} of {totalSlots}
        </span>
        <span className="text-xs text-neutral-600">{label}</span>
      </span>
      {slot.verdict === "satisfied" && slot.keep_producing_remaining ? (
        <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-700">
          + finish the batch
        </span>
      ) : null}
    </li>
  );
}


function FeedbackForm({
  slot,
  totalSlots,
  busy,
  onSubmit,
}: {
  slot: Slot;
  totalSlots: number;
  busy: boolean;
  onSubmit: (input: {
    verdict: "satisfied" | "needs_iteration";
    feedback: string;
    keepProducing: boolean;
  }) => Promise<void>;
}) {
  const [verdict, setVerdict] = useState<"satisfied" | "needs_iteration" | null>(null);
  const [feedback, setFeedback] = useState("");
  const [keepProducing, setKeepProducing] = useState(false);
  const canSubmit = verdict !== null && (verdict === "satisfied" || feedback.trim().length > 0);
  const hasRemaining = slot.sequence_no < totalSlots;
  return (
    <div className="mt-4 border-2 border-black bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
        Your feedback on sample {slot.sequence_no}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => setVerdict("satisfied")}
          className={
            "flex-1 border-2 border-black p-3 text-left transition-colors " +
            (verdict === "satisfied" ? "bg-orange-200" : "bg-white hover:shadow-[3px_3px_0_0_black]")
          }
        >
          <p className="text-sm font-black uppercase">This one&rsquo;s the one</p>
          <p className="mt-1 text-xs text-neutral-600">Move on to the final spec.</p>
        </button>
        <button
          type="button"
          onClick={() => setVerdict("needs_iteration")}
          className={
            "flex-1 border-2 border-black p-3 text-left transition-colors " +
            (verdict === "needs_iteration"
              ? "bg-orange-200"
              : "bg-white hover:shadow-[3px_3px_0_0_black]")
          }
        >
          <p className="text-sm font-black uppercase">Close, but needs tweaks</p>
          <p className="mt-1 text-xs text-neutral-600">
            Tell us what to change and we&rsquo;ll iterate.
          </p>
        </button>
      </div>

      {verdict === "needs_iteration" ? (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
          placeholder="What should we change? (taste, texture, colour, dosage)"
          className="mt-3 w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none"
        />
      ) : null}

      {verdict === "satisfied" ? (
        <>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={3}
            placeholder="Anything you want to note? (optional)"
            className="mt-3 w-full border-2 border-black bg-white px-3 py-2 text-sm focus:outline-none"
          />
          {hasRemaining ? (
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepProducing}
                onChange={(e) => setKeepProducing(e.target.checked)}
                className="mt-0.5 h-4 w-4 border-2 border-black"
              />
              <span>
                I&rsquo;m happy — but still send me the remaining samples I paid
                for.
                <span className="mt-0.5 block text-xs text-neutral-600">
                  We&rsquo;ll keep producing to the same recipe you approved.
                </span>
              </span>
            </label>
          ) : null}
        </>
      ) : null}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={busy || !canSubmit}
          onClick={() =>
            verdict && onSubmit({ verdict, feedback: feedback.trim(), keepProducing })
          }
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[4px_4px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
          Send feedback
        </button>
      </div>
    </div>
  );
}


function RequestMoreControl({
  currency,
  busy,
  onRequested,
}: {
  currency: string;
  busy: boolean;
  onRequested: (quantity: number) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  return (
    <div className="mt-4 border-2 border-black bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
        Request another sample
      </p>
      <p className="mt-1 text-xs text-neutral-600">
        {currency} per extra sample. Finance approves the invoice; we produce as
        soon as it lands.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="number"
          min={1}
          max={100}
          value={quantity}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(v)) setQuantity(Math.max(1, Math.min(100, v)));
          }}
          className="w-20 border-2 border-black bg-white px-3 py-1.5 text-center text-lg font-black focus:outline-none"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onRequested(quantity)}
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          Request {quantity} more
        </button>
      </div>
    </div>
  );
}
