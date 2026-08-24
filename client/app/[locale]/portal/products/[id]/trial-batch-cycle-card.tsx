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

import {
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  FlaskConical,
  Loader2,
  Plus,
  Truck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { DispatchPhotoLightbox } from "@/components/portal/dispatch-photo-lightbox";


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


/** PSP OrderWizard phase keys we render. Coarse "unknown phase" left
 *  as null on the wire so the FE can fall back to production_state. */
type ProductionPhase =
  | "setup"
  | "approval"
  | "production_planning"
  | "awaiting_ingredients"
  | "in_production"
  | "closeout"
  | "final_release"
  | "awaiting_routing"
  | "ready_to_dispatch"
  | "awaiting_pickup"
  | "dispatched"
  | "delivered";


interface Slot {
  readonly id: string;
  readonly sequence_no: number;
  readonly status: SlotStatus;
  readonly verdict: "satisfied" | "needs_iteration" | null;
  /** ISO timestamp the customer recorded their verdict. Null until
   *  a verdict is submitted. Rendered in the expanded slot story so
   *  the customer can see when each decision was made. */
  readonly verdict_at: string | null;
  readonly keep_producing_remaining: boolean;
  /** Full free-text feedback the customer left when submitting the
   *  verdict. Preserved verbatim so re-reading the story shows
   *  exactly what was said. */
  readonly feedback_summary: string;
  readonly trial_batch_id: string | null;
  /** Human-readable recipe version label ("v3") the slot was
   *  produced against. Server-emitted (mirrors the scientist's
   *  version picker). */
  readonly formulation_version_label: string;
  /** Coarse MO-chain bucket — kept as a fallback signal. The primary
   *  production signal is ``production_phase`` (below). */
  readonly production_state:
    | "not_pushed"
    | "in_progress"
    | "completed"
    | "unknown";
  readonly production_stages_total: number;
  readonly production_stages_done: number;
  /** PSP OrderWizard phase for the slot's Sample CO. Drives the
   *  strip. Null when PSP fetch soft-failed or slot has no MO yet.
   *  Chain-status "completed" (all MOs done) does NOT mean the
   *  shipment has left — PSP still walks closeout / final_release
   *  (QC) / awaiting_routing / dispatched / delivered after. */
  readonly production_phase: ProductionPhase | null;
  /** Customer-safe title for the current phase (from server). */
  readonly production_phase_title: string | null;
  /** Customer-safe one-line detail for the current phase. */
  readonly production_phase_note: string | null;
  /** PSP dispatch-confirmation snapshot when the shipment has left
   *  the building. ``null`` until PSP marks it ``picked_up`` — the
   *  card is hidden in that case rather than showing a placeholder. */
  readonly dispatch: SlotDispatch | null;
}


interface SlotDispatch {
  readonly status: "picked_up" | "delivered";
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly carrier: string | null;
  readonly vehicle_registration: string | null;
  readonly driver_name: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly checklist: {
    readonly packaging_intact: boolean | null;
    readonly labels_verified: boolean | null;
    readonly vehicle_clean_suitable: boolean | null;
    readonly transport_condition_acceptable: boolean | null;
    readonly dispatch_approved: boolean | null;
  };
  readonly photos: readonly {
    readonly uuid: string;
    readonly filename: string;
  }[];
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
  // "Remaining work" = any slot the customer is still expecting.
  // Approving a slot with "keep sending the rest" locks the remaining
  // AWAITING_SCIENTIST slots to the approved recipe rather than
  // cancelling them, so those still count as in-flight even though
  // the cycle itself flips to SATISFIED. Without this the portal
  // switches to "final spec incoming" while boxes are still shipping.
  const hasRemainingSamples = cycle.slots.some(
    (s) =>
      s.status === "awaiting_scientist" ||
      s.status === "in_production" ||
      s.status === "shipped" ||
      s.status === "delivered" ||
      s.status === "feedback_pending",
  );
  const cycleClosedStatus =
    cycle.status === "satisfied" || cycle.status === "terminated_by_team";
  const cycleDone = cycleClosedStatus && !hasRemainingSamples;
  const finishingRemaining = cycleClosedStatus && hasRemainingSamples;
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
              : finishingRemaining
                ? "Recipe approved — remaining samples still coming"
                : maxReached
                  ? `All ${cycle.total_slots} samples sent — what next?`
                  : `${cycle.slots_used} of ${cycle.total_slots} samples sent`}
          </p>
          {!cycleDone && !maxReached && activeSlot ? (
            <p className="mt-0.5 text-xs uppercase tracking-widest text-black">
              Sample #{activeSlot.sequence_no}
              {sampleHeaderSuffix(activeSlot)}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-neutral-800">
            {cycleDone
              ? "We're preparing the final specification. Sign it to authorise full production."
              : finishingRemaining
                ? "You approved the recipe and asked us to keep sending the remaining samples. The final specification unlocks after every sample lands."
                : maxReached
                  ? "Let us know if you're satisfied, or request another sample below."
                  : "One sample at a time. Give feedback on each and we'll iterate until it's right."}
          </p>
        </div>
      </div>

      <ul className="mt-5 flex flex-col gap-2">
        {cycle.slots.map((slot) => (
          <SlotRow
            key={slot.id}
            slot={slot}
            defaultOpen={slot.id === cycle.active_slot_id}
          />
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
      {/* Dispatch details live inside the active slot's expanded
          story now — no duplicate below-ladder card. */}

      {inProduction && activeSlot && activeSlot.trial_batch_id
        && isShippedOrLater(activeSlot.production_phase) ? (
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
            {activeSlot.production_phase === "delivered"
              ? "Confirm receipt"
              : "I’ve received it"}
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
// storefront /portal/samples/[id] roadmap by reading PSP's OrderWizard
// phase directly. Six stages track the real physical progress from
// "we have your batch drafted" through QC and dispatch to delivery:
//
//   1. Batch prepared     (trial batch linked to a PSP MO)
//   2. In production      (phase: in_production / closeout)
//   3. Pending QC         (phase: final_release)
//   4. Preparing dispatch (phase: awaiting_routing / ready_to_dispatch
//                                 / awaiting_pickup)
//   5. On the way         (phase: dispatched)
//   6. Delivered          (phase: delivered)
//
// PSP is the source of truth for phase transitions. If phase fetch
// soft-fails, we fall back to the coarse MO-chain state so the strip
// still lights up something useful.


/** Ordered PSP phases the strip renders — used to derive stage
 *  states from "highest-reached phase". */
const PHASE_ORDER: readonly ProductionPhase[] = [
  "setup",
  "approval",
  "production_planning",
  "awaiting_ingredients",
  "in_production",
  "closeout",
  "final_release",
  "awaiting_routing",
  "ready_to_dispatch",
  "awaiting_pickup",
  "dispatched",
  "delivered",
] as const;


function phaseIndex(phase: ProductionPhase | null): number {
  if (phase === null) return -1;
  const idx = PHASE_ORDER.indexOf(phase);
  return idx;
}


/** True when the physical shipment is en route or already with the
 *  customer — the gate for the "I've received it" button (either
 *  the customer confirms here, or the backend auto-flips the slot
 *  to DELIVERED once PSP reports ``delivered``). */
function isShippedOrLater(phase: ProductionPhase | null): boolean {
  return phase === "dispatched" || phase === "delivered";
}


// Header suffix that reflects the active slot's actual status so the
// customer never reads "Sample 1 of 3" flat while the slot is
// awaiting the scientist. Kept as a tiny helper next to the strip
// so header and strip stay in lockstep.
function sampleHeaderSuffix(slot: Slot | undefined): string {
  if (!slot) return "";
  switch (slot.status) {
    case "awaiting_scientist":
      return slot.trial_batch_id
        ? " — scientist preparing batch"
        : " — waiting for R&D";
    case "in_production":
    case "shipped": {
      const phase = slot.production_phase;
      if (phase === "delivered") return " — delivered";
      if (phase === "dispatched") return " — on the way";
      if (
        phase === "awaiting_routing" ||
        phase === "ready_to_dispatch" ||
        phase === "awaiting_pickup"
      )
        return " — preparing dispatch";
      if (phase === "final_release") return " — pending QC";
      if (phase === "closeout") return " — wrapping up";
      return " — in production";
    }
    case "delivered":
    case "feedback_pending":
      return " — ready for your feedback";
    default:
      return "";
  }
}


function ProductionStrip({ slot }: { slot: Slot }) {
  const hasBatch = Boolean(slot.trial_batch_id);
  // A draft trial batch on NPD isn't "batch prepared" — nothing
  // physical exists until the scientist pushes a PSP MO. Slot status
  // is the honest signal for that jump.
  const productionHasStarted =
    slot.status === "in_production" ||
    slot.status === "shipped" ||
    slot.status === "delivered" ||
    slot.status === "feedback_pending";
  const isReceived =
    slot.status === "delivered" || slot.status === "feedback_pending";
  const phase = slot.production_phase;
  const idx = phaseIndex(phase);
  const productionIdx = phaseIndex("in_production");
  const qcIdx = phaseIndex("final_release");
  const dispatchPrepIdx = phaseIndex("awaiting_routing");
  const dispatchedIdx = phaseIndex("dispatched");
  const deliveredIdx = phaseIndex("delivered");

  // Fallback: if PSP snapshot soft-failed, roll the coarse MO-chain
  // state into a synthetic phase so the strip still moves.
  //   completed → treat as ready_to_dispatch so the customer sees
  //     "Preparing dispatch" instead of jumping to "On the way".
  //   in_progress → treat as in_production.
  const effectiveIdx =
    idx >= 0
      ? idx
      : slot.production_state === "completed"
        ? phaseIndex("ready_to_dispatch")
        : slot.production_state === "in_progress"
          ? productionIdx
          : -1;

  const stageState = (
    reachedIdx: number,
    myStart: number,
    myEnd: number,
  ): "done" | "current" | "future" => {
    if (isReceived) return reachedIdx <= myEnd ? "done" : "future";
    if (reachedIdx < myStart) return "future";
    if (reachedIdx > myEnd) return "done";
    return "current";
  };

  const batchState: "done" | "current" | "future" = productionHasStarted
    ? "done"
    : "current";
  const productionStage = productionHasStarted
    ? stageState(effectiveIdx, productionIdx, qcIdx - 1)
    : "future";
  const qcStage = productionHasStarted
    ? stageState(effectiveIdx, qcIdx, qcIdx)
    : "future";
  const dispatchStage = productionHasStarted
    ? stageState(effectiveIdx, dispatchPrepIdx, dispatchedIdx - 1)
    : "future";
  const shippingStage = productionHasStarted
    ? stageState(effectiveIdx, dispatchedIdx, dispatchedIdx)
    : "future";
  const deliveredStage: "done" | "current" | "future" = isReceived
    ? "done"
    : productionHasStarted && effectiveIdx >= deliveredIdx
      ? "current"
      : "future";

  const currentTitle = slot.production_phase_title;
  const currentNote = slot.production_phase_note;

  const stages: ReadonlyArray<{
    key: string;
    label: string;
    state: "done" | "current" | "future";
    detail: string;
  }> = [
    {
      key: "batch",
      label: batchState === "current" ? "Preparing batch" : "Batch prepared",
      state: batchState,
      detail:
        batchState === "done"
          ? "Your R&D scientist has pushed the batch to the shop floor."
          : hasBatch
            ? "Your R&D scientist has drafted the recipe and is finalising it before pushing to production."
            : "Waiting for your R&D scientist to draft the batch recipe.",
    },
    {
      key: "production",
      label: "In production",
      state: productionStage,
      detail:
        productionStage === "done"
          ? "The shop floor has finished building your sample."
          : productionStage === "current"
            ? currentNote ?? "The shop floor is producing your sample right now."
            : "Starts once your scientist pushes the batch to the shop floor.",
    },
    {
      key: "qc",
      label: "Pending QC",
      state: qcStage,
      detail:
        qcStage === "done"
          ? "Quality control has cleared your sample for release."
          : qcStage === "current"
            ? currentNote ?? "Quality control is signing off before we release it for dispatch."
            : "Quality control runs once production wraps.",
    },
    {
      key: "dispatch",
      label: "Preparing dispatch",
      state: dispatchStage,
      detail:
        dispatchStage === "done"
          ? "Paperwork is done and the courier is booked."
          : dispatchStage === "current"
            ? currentNote ?? "We're getting your shipment paperwork ready and arranging pickup."
            : "Kicks off once QC clears the batch.",
    },
    {
      key: "shipping",
      label: "On the way",
      state: shippingStage,
      detail:
        shippingStage === "done"
          ? "Your sample has been delivered."
          : shippingStage === "current"
            ? currentNote ?? "Your sample is on its way to you."
            : "Starts once the courier collects your sample.",
    },
    {
      key: "delivered",
      label: "Delivered",
      state: deliveredStage,
      detail:
        deliveredStage === "done"
          ? "Thanks — we've marked it received."
          : deliveredStage === "current"
            ? "Confirm receipt below to unlock the feedback card."
            : "Unlocks once the courier drops it off.",
    },
  ];
  const showBanner =
    (currentTitle || currentNote) && productionHasStarted && !isReceived;

  return (
    <>
      {showBanner ? (
        <div className="mt-4 border-2 border-black bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black bg-orange-100 text-orange-600">
              <Clock className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-orange-600">
                Current status
              </p>
              {currentTitle ? (
                <p className="mt-1 text-base font-black uppercase leading-tight text-black">
                  {currentTitle}
                </p>
              ) : null}
              {currentNote ? (
                <p className="mt-1 text-sm text-neutral-800">{currentNote}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
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
    </>
  );
}


function compactSlotLabel(slot: Slot): string {
  switch (slot.status) {
    case "closed_satisfied":
      return "You confirmed this is right";
    case "closed_iterated":
      return "Iterating from your feedback";
    case "closed_cancelled":
      return "Skipped";
    case "delivered":
    case "feedback_pending":
      return "Delivered — ready for feedback";
    case "awaiting_scientist":
      return slot.trial_batch_id
        ? "Scientist preparing batch"
        : "Waiting for scientist";
    case "in_production":
    case "shipped":
      // Phase-aware label when we know PSP's current phase.
      if (slot.production_phase_title) {
        return slot.production_phase_title;
      }
      // Fallbacks when PSP snapshot is unavailable.
      if (slot.production_state === "completed") {
        return "Preparing dispatch";
      }
      if (slot.production_state === "in_progress") {
        return `In production (${slot.production_stages_done}/${slot.production_stages_total})`;
      }
      return "In production";
    default:
      return slot.status;
  }
}


function SlotRow({
  slot,
  defaultOpen = false,
}: {
  slot: Slot;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  const label = compactSlotLabel(slot);
  // "Story" content is only meaningful once the slot has started —
  // an awaiting_scientist row with no batch yet has nothing to tell.
  // Everything past that (in-production, delivered, iterated,
  // satisfied, cancelled) has a story worth exposing.
  const hasStory =
    slot.status !== "awaiting_scientist" || Boolean(slot.trial_batch_id);
  return (
    <li className="border-2 border-black bg-white">
      <button
        type="button"
        onClick={() => hasStory && setOpen((v) => !v)}
        aria-expanded={hasStory ? open : undefined}
        disabled={!hasStory}
        className={
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left " +
          (hasStory ? "hover:bg-orange-50" : "cursor-default")
        }
      >
        <span className="flex min-w-0 items-center gap-2 text-sm">
          {icon}
          <span className="font-black">Sample #{slot.sequence_no}</span>
          <span className="truncate text-xs text-neutral-600">{label}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {slot.verdict === "satisfied" && slot.keep_producing_remaining ? (
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-700">
              + finish the batch
            </span>
          ) : null}
          {hasStory ? (
            <ChevronDown
              className={
                "h-4 w-4 shrink-0 text-neutral-500 transition-transform " +
                (open ? "rotate-180" : "")
              }
            />
          ) : null}
        </span>
      </button>
      {open && hasStory ? <SlotStory slot={slot} /> : null}
    </li>
  );
}


// Expanded per-slot detail — the "story" of a previous (or ongoing)
// sample: which recipe version, what the customer said, and when.
// Feedback text is preserved verbatim from the ``feedback_summary``
// the customer submitted so they can re-read their own words later.
// The active slot's live progress (production strip / dispatch card /
// receive button / feedback form) still renders below the ladder —
// this component only shows the after-the-fact story bits.
function SlotStory({ slot }: { slot: Slot }) {
  const verdictAt = slot.verdict_at
    ? new Date(slot.verdict_at).toLocaleString()
    : null;
  const verdictLabel =
    slot.verdict === "satisfied"
      ? "You said this is the one"
      : slot.verdict === "needs_iteration"
        ? "You asked for iteration"
        : null;
  const verdictTone =
    slot.verdict === "satisfied"
      ? "bg-emerald-100 text-emerald-800"
      : slot.verdict === "needs_iteration"
        ? "bg-amber-100 text-amber-800"
        : "bg-neutral-100 text-neutral-700";
  return (
    <div className="border-t-2 border-black bg-orange-50/40 px-3 py-3">
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Recipe version
          </p>
          <p className="mt-0.5 font-mono text-neutral-900">
            {slot.formulation_version_label || "—"}
          </p>
        </div>
        {verdictAt ? (
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
              Verdict recorded
            </p>
            <p className="mt-0.5 text-neutral-900">{verdictAt}</p>
          </div>
        ) : null}
      </div>

      {verdictLabel ? (
        <div className="mt-3">
          <span
            className={
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest " +
              verdictTone
            }
          >
            {verdictLabel}
          </span>
        </div>
      ) : null}

      {slot.feedback_summary ? (
        <div className="mt-3 border-2 border-black/10 bg-white p-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Your feedback
          </p>
          <p className="mt-1 whitespace-pre-line text-sm text-neutral-900">
            {slot.feedback_summary}
          </p>
        </div>
      ) : null}

      {/* Shipment details — carrier / vehicle / driver / waybill /
          tracking / seal / temperature + 5-point checklist + loading
          photos. Backend eager-fetches dispatch for every non-
          cancelled trial-batch-linked slot so the customer can
          re-review any prior sample's paperwork from the story. */}
      {slot.dispatch ? (
        <div className="mt-3">
          <DispatchDetailsCard slotId={slot.id} dispatch={slot.dispatch} />
        </div>
      ) : null}

      {!verdictLabel && !slot.feedback_summary && !slot.dispatch ? (
        <p className="mt-2 text-[11px] italic text-neutral-500">
          No details recorded yet.
        </p>
      ) : null}
    </div>
  );
}


// Renders carrier + vehicle + driver + waybill + tracking + seal
// + temperature + 5-point checklist once PSP marks the shipment
// picked_up. Mirrors the storefront samples-only Dispatch card so
// customers see the same info on both surfaces. Loading photos are
// omitted here for now (would need a portal proxy route for the
// slot-scoped file endpoint — sample flow has one, custom-project
// flow doesn't yet).
const DISPATCH_CHECKLIST: readonly {
  key: keyof SlotDispatch["checklist"];
  label: string;
}[] = [
  { key: "packaging_intact", label: "Packaging intact" },
  { key: "labels_verified", label: "Labels verified" },
  { key: "vehicle_clean_suitable", label: "Vehicle clean & suitable" },
  {
    key: "transport_condition_acceptable",
    label: "Transport condition acceptable",
  },
  { key: "dispatch_approved", label: "Dispatch approved" },
];


function DispatchDetailsCard({
  slotId,
  dispatch,
}: {
  slotId: string;
  dispatch: SlotDispatch;
}) {
  const dispatchedAt = dispatch.picked_up_at
    ? new Date(dispatch.picked_up_at).toLocaleString()
    : null;
  const deliveredAt = dispatch.delivered_at
    ? new Date(dispatch.delivered_at).toLocaleString()
    : null;
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxPhotos = dispatch.photos.map((photo) => ({
    uuid: photo.uuid,
    filename: photo.filename,
    href:
      `/api/portal/trial-batches/slots/${encodeURIComponent(slotId)}` +
      `/dispatch-photos/${encodeURIComponent(photo.uuid)}/`,
  }));

  const isDelivered = dispatch.status === "delivered";

  return (
    <section className="mt-4 border-2 border-black bg-white p-4">
      <div className="flex items-center gap-2">
        <Truck className="h-4 w-4 text-orange-600" />
        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
          Shipment details
        </p>
        <span
          className={
            "ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest " +
            (isDelivered
              ? "bg-emerald-200 text-emerald-900"
              : "bg-orange-200 text-orange-900")
          }
        >
          {isDelivered ? "Delivered" : "In transit"}
        </span>
      </div>

      {/* Explicit two-line timeline — the old single-sentence
          "Delivered. Left warehouse X. Delivered Y." was repetitive
          and buried the delivery date. Split into labelled rows so
          the "when did this actually arrive?" answer is obvious at
          a glance for both in-transit and delivered shipments. */}
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="flex items-baseline gap-2">
          <dt className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Picked up
          </dt>
          <dd className="text-neutral-900">
            {dispatchedAt || (
              <span className="italic text-neutral-500">Not yet</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Delivered
          </dt>
          <dd className="text-neutral-900">
            {deliveredAt ||
              (isDelivered ? (
                <span className="text-neutral-900">Confirmed</span>
              ) : (
                <span className="italic text-neutral-500">
                  {dispatchedAt ? "On the way" : "Waiting for pickup"}
                </span>
              ))}
          </dd>
        </div>
      </dl>

      <div className="mt-3 grid gap-3 border-t border-black/10 pt-3 text-sm sm:grid-cols-2">
        <DispatchField label="Delivery company" value={dispatch.carrier} />
        <DispatchField
          label="Vehicle registration"
          value={dispatch.vehicle_registration}
          mono
        />
        <DispatchField label="Driver" value={dispatch.driver_name} />
        <DispatchField
          label="Waybill / CN ref"
          value={dispatch.consignment_note_ref}
          mono
        />
        <DispatchField
          label="Tracking number"
          value={dispatch.tracking_number}
          mono
        />
        {dispatch.seal_number ? (
          <DispatchField label="Seal number" value={dispatch.seal_number} mono />
        ) : null}
        {dispatch.temperature_c ? (
          <DispatchField
            label="Temperature"
            value={`${dispatch.temperature_c} °C`}
          />
        ) : null}
      </div>

      <div className="mt-3 border-t border-black/10 pt-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
          Truck-arrival checklist
        </p>
        <ul className="mt-2 space-y-1">
          {DISPATCH_CHECKLIST.map(({ key, label }) => {
            const passed = dispatch.checklist[key] === true;
            return (
              <li
                key={key}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  className={
                    "flex h-4 w-4 shrink-0 items-center justify-center border border-black " +
                    (passed
                      ? "bg-emerald-200 text-emerald-800"
                      : "bg-white text-neutral-400")
                  }
                >
                  {passed ? (
                    <Check className="h-2.5 w-2.5" />
                  ) : (
                    <span>—</span>
                  )}
                </span>
                <span className={passed ? "text-neutral-900" : "text-neutral-500"}>
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {lightboxPhotos.length > 0 ? (
        <div className="mt-3 border-t border-black/10 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Loading photos ({lightboxPhotos.length})
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {lightboxPhotos.map((photo, index) => (
              <li key={photo.uuid}>
                <button
                  type="button"
                  onClick={() => setLightboxIndex(index)}
                  title={photo.filename}
                  aria-label={`Open ${photo.filename} in a larger view`}
                  className="block aspect-square w-full overflow-hidden border-2 border-black bg-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] focus:outline-none focus-visible:shadow-[3px_3px_0_0_black]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element --
                     operator-uploaded evidence served via ownership-
                     scoped proxy at unknown resolutions. */}
                  <img
                    src={photo.href}
                    alt={photo.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {lightboxIndex !== null && lightboxPhotos.length > 0 ? (
        <DispatchPhotoLightbox
          photos={lightboxPhotos}
          openIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onIndexChange={setLightboxIndex}
        />
      ) : null}
    </section>
  );
}


function DispatchField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  const shown = value?.trim();
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
        {label}
      </p>
      <p
        className={
          "text-sm " +
          (mono ? "font-mono " : "") +
          (shown ? "text-neutral-900" : "italic text-neutral-400")
        }
      >
        {shown || "—"}
      </p>
    </div>
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
