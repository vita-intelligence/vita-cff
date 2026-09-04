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
  Download,
  Eye,
  FileText,
  FlaskConical,
  Loader2,
  Plus,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { DispatchPhotoLightbox } from "@/components/portal/dispatch-photo-lightbox";
import { PortalModal } from "@/components/portal/portal-modal";


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
  /** Final Product Release documents attached on PSP (COA / BMR /
   *  micro / label proof / retain-sample photos). Empty array
   *  until the release ceremony has landed on PSP — the card is
   *  hidden in that case. */
  readonly release_documents: readonly ReleaseDocument[];
}


interface ReleaseDocument {
  readonly uuid: string;
  /** One of `coa`, `bmr`, `micro`, `label_proof`, `retain_sample`
   *  — the five required file kinds on PSP's Final Product Release
   *  ceremony. Extra kinds render as prettified enum values. */
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly uploaded_at: string;
}


interface SlotDispatch {
  /** Widened from ``picked_up | delivered`` when multi-visit landed.
   *  ``partially_picked`` means at least one truck has taken part of
   *  the qty and more visits are still owed. */
  readonly status: "partially_picked" | "picked_up" | "delivered";
  readonly qty: string | null;
  readonly picked_up_qty: string | null;
  readonly remaining_qty: string | null;
  readonly picked_up_at: string | null;
  readonly delivered_at: string | null;
  readonly carrier: string | null;
  readonly vehicle_registration: string | null;
  readonly driver_name: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly checklist: SlotDispatchChecklist;
  readonly photos: readonly {
    readonly uuid: string;
    readonly filename: string;
  }[];
  /** Per-truck timeline. One row per visit with its own qty, checklist,
   *  driver, paperwork, photos, and delivery POD. Empty on legacy
   *  single-visit shipments (in which case the ``checklist`` + top-
   *  level fields carry the whole story). */
  readonly pickup_events: readonly SlotPickupEvent[];
}

interface SlotDispatchChecklist {
  readonly packaging_intact: boolean | null;
  readonly labels_verified: boolean | null;
  readonly vehicle_clean_suitable: boolean | null;
  readonly transport_condition_acceptable: boolean | null;
  readonly dispatch_approved: boolean | null;
}

interface SlotPickupEventPhoto {
  readonly uuid: string;
  readonly filename: string;
  readonly mime: string;
}

interface SlotPickupEvent {
  readonly uuid: string;
  readonly qty: string;
  readonly picked_up_at: string;
  readonly driver_name: string | null;
  readonly vehicle_registration: string | null;
  readonly consignment_note_ref: string | null;
  readonly tracking_number: string | null;
  readonly seal_number: string | null;
  readonly temperature_c: string | null;
  readonly notes: string | null;
  readonly checklist: SlotDispatchChecklist;
  readonly delivered_at: string | null;
  readonly recipient_signatory: string | null;
  readonly delivery_notes: string | null;
  readonly photos: readonly SlotPickupEventPhoto[];
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
  /** Meaningful samples from a previous run — the cycle was closed
   *  by the team and the customer ordered more, resetting the
   *  current-run counter. These are shipped / delivered / verdict-
   *  landed samples the customer should still be able to look
   *  back on, but they don't count against the new "0 of N" run
   *  counter. Empty on a fresh cycle. */
  readonly previous_run_slots: readonly Slot[];
  readonly active_slot_id: string | null;
  readonly additional_requests: readonly AdditionalRequest[];
  /** ISO timestamp — set when the customer clicks "No, we're done"
   *  at the terminal choice prompt. Once populated the cycle can't
   *  slide back into an in-progress state; it's the signal the
   *  final-spec stage unlocks off. */
  readonly customer_confirmed_done_at: string | null;
  /** True while any AdditionalSampleRequest is still in
   *  ``awaiting_finance``. The terminal-choice prompt is suppressed
   *  in this state — the cycle waits for the finance decision
   *  before offering the customer the "more or done" choice again. */
  readonly has_pending_top_up: boolean;
  /** True while any slot is still in flight (awaiting scientist /
   *  in production / delivered without verdict). The terminal
   *  choice only surfaces once every paid-for sample has landed
   *  a verdict. */
  readonly has_active_slots: boolean;
  /** Server-computed: no pending top-up, no active slots, customer
   *  hasn't already answered — i.e. the terminal-choice prompt is
   *  the honest thing to render right now. */
  readonly can_finalise: boolean;
}


// Query-key factory so mutations across the file can invalidate
// this cycle consistently without stringly-typed keys.
function cycleQueryKey(projectId: string) {
  return ["portal", "trial-batch-cycle", projectId] as const;
}


export function TrialBatchCycleCard({ projectId }: { projectId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modal gates on the two consequential actions. `null` = closed.
  // Extra step prevents an accidental single click from spawning a
  // finance invoice or locking the cycle prematurely. Both modals
  // dismiss on Escape / backdrop click; only the primary button
  // fires the mutation.
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [confirmDoneOpen, setConfirmDoneOpen] = useState(false);

  // React Query owns the fetch so re-opening the project tab hits
  // the cache instead of round-tripping NPD + PSP for every slot's
  // dispatch and release documents. ``staleTime`` short enough that
  // a live PSP transition (delivery / release ceremony) surfaces on
  // the next natural refetch, long enough that quick tab-switching
  // stays instant. Mutations below explicitly invalidate on success.
  const cycleQuery = useQuery<Cycle, Error>({
    queryKey: cycleQueryKey(projectId),
    queryFn: async () => {
      const { data } = await apiClient.get<{ cycle: Cycle }>(
        `/api/portal/projects/${projectId}/trial-batches/`,
      );
      return data.cycle;
    },
    staleTime: 60_000,
    // Keep the previous cycle payload visible while a background
    // refetch runs — no "Loading your samples…" flash between
    // navigations for a customer who already opened this card.
    placeholderData: (prev) => prev,
    retry: 1,
  });

  const invalidateCycle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: cycleQueryKey(projectId) });
  }, [queryClient, projectId]);

  const cycle = cycleQuery.data ?? null;
  const phase: "loading" | "ready" | "error" = cycleQuery.isPending
    ? "loading"
    : cycleQuery.isError
      ? "error"
      : "ready";

  useEffect(() => {
    if (cycleQuery.isError) {
      setError(portalErrorMessage(cycleQuery.error));
    }
  }, [cycleQuery.isError, cycleQuery.error]);

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
  const teamOverride = cycle.status === "terminated_by_team";
  const customerConfirmedDone = cycle.customer_confirmed_done_at !== null;
  // "Confirmed done" — customer explicitly picked "No, we're done"
  // at the terminal prompt. Team-close ALONE no longer counts: the
  // team can wrap up their side but the customer still owes an
  // answer (more or done) before the pipeline advances. See
  // ``product_detail_views._build_pipeline`` for the mirrored gate.
  const confirmedDone = customerConfirmedDone;
  // Waiting on finance to approve/reject a top-up request. While
  // true, the terminal-choice prompt is suppressed — the customer
  // already asked for more and we're waiting on the finance loop.
  const awaitingTopUpDecision =
    cycle.has_pending_top_up && !hasRemainingSamples && !confirmedDone;
  // Terminal-choice state: every paid-for slot has resolved, no
  // top-up is pending, and the customer hasn't answered "more or
  // done" yet. This is when we show the explicit Yes/No prompt.
  const needsTerminalChoice = cycle.can_finalise && !confirmedDone;
  const finishingRemaining =
    cycleClosedStatus && hasRemainingSamples && !confirmedDone;
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
            {confirmedDone
              ? "Trial batches complete — final spec on its way"
              : awaitingTopUpDecision
                ? "Waiting on finance to approve your top-up"
                : needsTerminalChoice
                  ? teamOverride
                    ? "Our team wrapped your trial-batch run — what next?"
                    : `All ${cycle.total_slots} samples done — what next?`
                  : finishingRemaining
                    ? "Recipe approved — remaining samples still coming"
                    : maxReached
                      ? `All ${cycle.total_slots} samples sent — what next?`
                      : `${cycle.slots_used} of ${cycle.total_slots} samples sent`}
          </p>
          {!confirmedDone &&
          !awaitingTopUpDecision &&
          !needsTerminalChoice &&
          !maxReached &&
          activeSlot ? (
            <p className="mt-0.5 text-xs uppercase tracking-widest text-black">
              Sample #{activeSlot.sequence_no}
              {sampleHeaderSuffix(activeSlot)}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-neutral-800">
            {confirmedDone
              ? "Our team is preparing your final specification based on the recipe you approved. We'll email you the moment it's ready to sign — no action needed from you until then."
              : awaitingTopUpDecision
                ? "Finance is reviewing the invoice for your extra samples. Once they approve, we'll produce them right away — or if they reject it we'll ask again what you'd like to do."
                : needsTerminalChoice
                  ? teamOverride
                    ? "Our team closed the current run. If you'd like more samples we'll start a fresh batch — otherwise we'll lock the recipe in and move on to the final spec."
                    : "Want to try a few more variations, or are you happy with what you've got?"
                  : finishingRemaining
                    ? "You approved the recipe and asked us to keep sending the remaining samples. The final specification unlocks after every sample lands."
                    : maxReached
                      ? "Let us know if you're satisfied, or request another sample below."
                      : "One sample at a time. Give feedback on each and we'll iterate until it's right."}
          </p>
        </div>
      </div>

      {/* Previous-run history — samples the customer received on
          an earlier run before the team closed the cycle and they
          ordered more. Shown compact + collapsed by default so the
          current-run ladder stays the focus. */}
      {cycle.previous_run_slots.length > 0 ? (
        <div className="mt-5 border-2 border-dashed border-black bg-white/60 p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-700">
            Previous samples ({cycle.previous_run_slots.length})
          </p>
          <p className="mt-0.5 text-xs text-neutral-600">
            Samples from your earlier run — kept so you can look back on
            what we sent and what you thought.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {cycle.previous_run_slots.map((slot) => (
              <SlotRow key={slot.id} slot={slot} defaultOpen={false} />
            ))}
          </ul>
        </div>
      ) : null}

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
              invalidateCycle();
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

      {/* Whole-shipment "I've received it" fallback — kept only for
          legacy single-visit shipments where PSP didn't emit any
          pickup events (pre multi-visit). Once events exist, each
          truck has its own confirm-receipt affordance rendered inside
          ``DispatchDetailsCard`` per-event block, so we hide this
          catch-all to avoid double-confirmation. */}
      {inProduction &&
      activeSlot &&
      activeSlot.trial_batch_id &&
      isShippedOrLater(activeSlot.production_phase) &&
      (activeSlot.dispatch?.pickup_events?.length ?? 0) === 0 ? (
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
                invalidateCycle();
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

      {needsTerminalChoice ? (
        <TerminalChoicePanel
          busy={busy}
          onOpenRequestMore={() => setRequestModalOpen(true)}
          onOpenConfirmDone={() => setConfirmDoneOpen(true)}
        />
      ) : null}

      {/* Waiting on finance to approve/reject a pending top-up. No
          choice buttons here — the customer already asked; they can
          only wait for the finance decision (approve → new slots
          seeded, reject → back to the terminal-choice prompt). */}
      {awaitingTopUpDecision ? (
        <div className="mt-4 border-2 border-black bg-white p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black bg-amber-100 text-amber-700">
              <Clock className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-amber-700">
                Awaiting finance approval
              </p>
              <p className="mt-1 text-sm text-neutral-800">
                We can&rsquo;t move on to the final spec yet — your extra-
                samples invoice is with finance. As soon as they approve
                it we&rsquo;ll produce the new samples and the cycle
                continues. If it&rsquo;s rejected we&rsquo;ll bring the
                choice back.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {/* Mid-cycle "request more" — available while the cycle is still
          in flight and no top-up is already pending. Lets the customer
          front-load an extra order without waiting for the terminal
          prompt (finance approval takes real time). A modal gates
          the actual submit so a stray click on the trigger doesn't
          spawn a finance invoice. Hidden in the terminal-choice /
          waiting-hold / already-done states because those have their
          own affordances. */}
      {!confirmedDone &&
      !awaitingTopUpDecision &&
      !needsTerminalChoice &&
      hasRemainingSamples ? (
        <div className="mt-4 border-2 border-black bg-white p-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Need extra samples?
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            Order additional samples on top of what you paid for. Finance
            approves the invoice; we produce as soon as it lands.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setRequestModalOpen(true)}
            className="mt-3 inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Request additional samples
          </button>
        </div>
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

      {/* Modals live at the card root so they can be triggered from
          both the mid-cycle affordance and the terminal-choice panel
          without duplicating handlers. Portal'd to the body so the
          overlay escapes the card's stacking context. */}
      <RequestMoreModal
        open={requestModalOpen}
        currency={cycle.additional_requests[0]?.currency_code ?? "GBP"}
        busy={busy}
        onClose={() => (busy ? undefined : setRequestModalOpen(false))}
        onConfirm={async (qty) => {
          setBusy(true);
          setError(null);
          try {
            await apiClient.post(
              `/api/portal/projects/${projectId}/trial-batches/request-more/`,
              { quantity: qty },
            );
            setRequestModalOpen(false);
            invalidateCycle();
            router.refresh();
          } catch (err: unknown) {
            setError(portalErrorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      <ConfirmDoneModal
        open={confirmDoneOpen}
        totalSlots={cycle.total_slots}
        busy={busy}
        onClose={() => (busy ? undefined : setConfirmDoneOpen(false))}
        onConfirm={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiClient.post(
              `/api/portal/projects/${projectId}/trial-batches/confirm-done/`,
            );
            setConfirmDoneOpen(false);
            invalidateCycle();
            router.refresh();
          } catch (err: unknown) {
            setError(portalErrorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      />
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

      {/* Final Product Release documents — COA / BMR / micro / label
          proof / retain-sample photos. Sits above dispatch because
          the QA sign-off logically precedes the physical shipment,
          matching what the customer sees on the standalone samples
          view. */}
      {slot.release_documents.length > 0 ? (
        <div className="mt-3">
          <ReleaseDocumentsCard
            slotId={slot.id}
            documents={slot.release_documents}
          />
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

      {!verdictLabel
        && !slot.feedback_summary
        && !slot.dispatch
        && slot.release_documents.length === 0 ? (
        <p className="mt-2 text-[11px] italic text-neutral-500">
          No details recorded yet.
        </p>
      ) : null}
    </div>
  );
}


// Human-readable label for the five required Final Release doc
// kinds on PSP. Falls back to a prettified enum for anything else.
const RELEASE_DOC_LABEL: Readonly<Record<string, string>> = {
  coa: "Certificate of Analysis",
  bmr: "Batch Manufacturing Record",
  micro: "Microbiological report",
  label_proof: "Signed label proof",
  retain_sample: "Retain-sample record",
};

function releaseDocLabel(kind: string): string {
  return RELEASE_DOC_LABEL[kind] ?? kind.replace(/_/g, " ");
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Renders the Final Product Release documents attached to a slot's
// PSP CO — COA / BMR / micro / label proof / retain-sample photos.
// Each row: a Download button + inline Preview for PDF / image
// types (browser handles rendering natively). Mirrors the
// storefront samples ReleaseDocumentsCard so both surfaces feel
// identical to the customer.
function ReleaseDocumentsCard({
  slotId,
  documents,
}: {
  slotId: string;
  documents: readonly ReleaseDocument[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section className="border-2 border-black bg-white p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-black" />
        <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
          Release documents
        </p>
      </div>
      <p className="mt-1 text-xs text-neutral-600">
        QA-signed documents released with your sample. Keep them with
        your compliance records.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {documents.map((doc) => {
          const mime = (doc.mime || "").toLowerCase();
          const filename = (doc.filename || "").toLowerCase();
          // Filename-extension fallback: some PSP records upload the
          // BMR without a mime (or with a stale ``application/octet-
          // stream``), which used to fall through to the ``<img>``
          // branch and show a broken-image icon on the preview.
          const isPdf =
            mime.startsWith("application/pdf") || filename.endsWith(".pdf");
          const isImage =
            mime.startsWith("image/") ||
            /\.(png|jpe?g|gif|webp|avif)$/.test(filename);
          const isPreviewable = isPdf || isImage;
          const href =
            `/api/portal/trial-batches/slots/${encodeURIComponent(slotId)}` +
            `/release-documents/${encodeURIComponent(doc.uuid)}/`;
          const isOpen = expanded === doc.uuid;
          const uploaded = doc.uploaded_at
            ? new Date(doc.uploaded_at).toLocaleString()
            : "—";
          return (
            <li key={doc.uuid} className="border-2 border-black bg-white p-3">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-black bg-orange-100 text-orange-700">
                  <FileText className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black uppercase text-black">
                    {releaseDocLabel(doc.kind)}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-neutral-600">
                    {doc.filename}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    {uploaded} · {formatBytes(doc.byte_size)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Images preview inline. PDFs open in a new tab —
                      Chrome's built-in viewer often refuses to render
                      embedded PDFs (user has "Download instead of
                      open" set, or the site-wide CSP interferes) and
                      the mystery broken-icon that leaves behind is
                      worse than just opening the file directly. */}
                  {isImage && !isPdf ? (
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : doc.uuid)}
                      aria-label={isOpen ? "Hide preview" : "Preview"}
                      aria-expanded={isOpen}
                      title={isOpen ? "Hide preview" : "Preview"}
                      className="flex h-8 w-8 items-center justify-center border-2 border-black bg-white text-neutral-700 hover:bg-neutral-100"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  ) : null}
                  {isPdf ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open ${doc.filename} in a new tab`}
                      title="Open in a new tab"
                      className="flex h-8 w-8 items-center justify-center border-2 border-black bg-white text-neutral-700 hover:bg-neutral-100"
                    >
                      <Eye className="h-4 w-4" />
                    </a>
                  ) : null}
                  <a
                    href={href}
                    download={doc.filename}
                    aria-label={`Download ${doc.filename}`}
                    title="Download"
                    className="flex h-8 w-8 items-center justify-center border-2 border-black bg-black text-white hover:bg-neutral-800"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </div>
              </div>
              {isImage && !isPdf && isOpen ? (
                <div className="mt-3 border-2 border-black bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element --
                     operator-uploaded release evidence served through
                     an ownership-scoped proxy at unknown resolutions. */}
                  <img
                    src={href}
                    alt={releaseDocLabel(doc.kind)}
                    className="mx-auto block max-h-[500px] w-auto object-contain"
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
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
  const events = dispatch.pickup_events ?? [];
  const hasEvents = events.length > 0;
  const pickedTotal = Number(dispatch.picked_up_qty ?? 0);
  const totalQty = Number(dispatch.qty ?? 0);
  const pickedPct =
    totalQty > 0 && Number.isFinite(pickedTotal)
      ? Math.min(100, Math.round((pickedTotal / totalQty) * 100))
      : null;

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

      {hasEvents ? (
        <div className="mt-3 border-t border-black/10 pt-3">
          <div className="flex items-baseline justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
              Pickup progress ({events.length}{" "}
              {events.length === 1 ? "visit" : "visits"})
            </p>
            {pickedPct !== null && dispatch.qty && dispatch.picked_up_qty ? (
              <span className="text-[10px] text-neutral-600">
                {dispatch.picked_up_qty} of {dispatch.qty} · {pickedPct}%
              </span>
            ) : null}
          </div>
          {pickedPct !== null ? (
            <div className="mt-1 h-1.5 w-full overflow-hidden border border-black bg-white">
              <div
                className="h-full bg-orange-500"
                style={{ width: `${pickedPct}%` }}
              />
            </div>
          ) : null}
          <ul className="mt-3 space-y-2">
            {events.map((event, idx) => {
              const firstOpenIdx = events.findIndex((e) => !e.delivered_at);
              return (
                <SlotPickupEventBlock
                  key={event.uuid}
                  event={event}
                  eventIndex={idx}
                  totalEvents={events.length}
                  slotId={slotId}
                  defaultOpen={idx === firstOpenIdx || events.length === 1}
                />
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="mt-3 border-t border-black/10 pt-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Truck-arrival checklist
          </p>
          <ul className="mt-2 space-y-1">
            {DISPATCH_CHECKLIST.map(({ key, label }) => {
              const passed = dispatch.checklist[key] === true;
              return (
                <li key={key} className="flex items-center gap-2 text-xs">
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
                  <span
                    className={passed ? "text-neutral-900" : "text-neutral-500"}
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!hasEvents && lightboxPhotos.length > 0 ? (
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


/** Per-truck expandable block. Matches the samples/projects portal
 *  layout so the customer sees a consistent per-visit story across
 *  all three portals — collapsed header (visit qty + driver + status
 *  pill), expanded body with the carrier slab, checklist chips, load
 *  photos, and a per-visit "Confirm receipt" modal. Backend hits the
 *  slot-scoped confirm-delivery endpoint the sample per-event flow
 *  shares. */
function SlotPickupEventBlock({
  event,
  eventIndex,
  totalEvents,
  slotId,
  defaultOpen,
}: {
  event: SlotPickupEvent;
  eventIndex: number;
  totalEvents: number;
  slotId: string;
  defaultOpen: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(defaultOpen);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signatory, setSignatory] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const delivered = Boolean(event.delivered_at);
  const hasPhotos = event.photos && event.photos.length > 0;

  const pickedAt = new Date(event.picked_up_at).toLocaleString();
  const deliveredAt = event.delivered_at
    ? new Date(event.delivered_at).toLocaleString()
    : null;

  const lightboxPhotos = event.photos.map((photo) => ({
    uuid: photo.uuid,
    filename: photo.filename,
    href:
      `/api/portal/trial-batches/slots/${encodeURIComponent(slotId)}` +
      `/dispatch-photos/${encodeURIComponent(photo.uuid)}/`,
  }));

  const visitLabel =
    totalEvents === 1 ? "Pickup" : `Visit ${eventIndex + 1} of ${totalEvents}`;

  async function submitConfirm() {
    if (!signatory.trim()) {
      setConfirmError("Please enter who signed for the delivery.");
      return;
    }
    setPending(true);
    setConfirmError(null);
    try {
      await apiClient.post(
        `/api/portal/trial-batches/slots/${slotId}/pickup-events/${event.uuid}/confirm-delivery/`,
        {
          recipient_signatory: signatory.trim(),
          ...(notes.trim() ? { delivery_notes: notes.trim() } : {}),
        },
      );
      setConfirmOpen(false);
      router.refresh();
    } catch (err: unknown) {
      setConfirmError(portalErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="border-2 border-black bg-white">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-50 focus:outline-none focus-visible:bg-neutral-50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm font-bold text-black">{visitLabel}</p>
            <span className="font-mono text-xs text-neutral-700">
              {event.qty} units
            </span>
            <span className="text-[11px] text-neutral-500">· {pickedAt}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-neutral-600">
            {event.driver_name || "Driver name unavailable"}
            {event.vehicle_registration ? ` · ${event.vehicle_registration}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {delivered ? (
            <span className="border border-black bg-emerald-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-900">
              Received
            </span>
          ) : (
            <span className="border border-black bg-orange-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-orange-900">
              In transit
            </span>
          )}
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-neutral-500" aria-hidden />
          ) : (
            <ChevronDown
              className="h-4 w-4 -rotate-90 text-neutral-500"
              aria-hidden
            />
          )}
        </div>
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-black bg-neutral-50 p-3">
          <div className="border border-black/60 bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
              Carrier
            </p>
            <div className="mt-2 grid gap-3 text-sm sm:grid-cols-2">
              <DispatchField label="Driver" value={event.driver_name} />
              <DispatchField
                label="Vehicle registration"
                value={event.vehicle_registration}
                mono
              />
              <DispatchField
                label="Consignment note"
                value={event.consignment_note_ref}
                mono
              />
              <DispatchField
                label="Tracking number"
                value={event.tracking_number}
                mono
              />
              <DispatchField
                label="Seal number"
                value={event.seal_number}
                mono
              />
              <DispatchField
                label="Temperature"
                value={event.temperature_c ? `${event.temperature_c} °C` : null}
                mono
              />
              <DispatchField label="Picked up" value={pickedAt} />
              {deliveredAt ? (
                <DispatchField label="Delivered" value={deliveredAt} />
              ) : null}
              {event.recipient_signatory ? (
                <DispatchField
                  label="Signed by"
                  value={event.recipient_signatory}
                />
              ) : null}
            </div>
          </div>

          <div className="border border-black/60 bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
              Truck-arrival checklist
            </p>
            <ul className="mt-2 space-y-1">
              {DISPATCH_CHECKLIST.map(({ key, label }) => {
                const passed = event.checklist[key] === true;
                return (
                  <li key={key} className="flex items-center gap-2 text-xs">
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
                    <span
                      className={passed ? "text-neutral-900" : "text-neutral-500"}
                    >
                      {label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {hasPhotos ? (
            <div className="border border-black/60 bg-white p-3">
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

          {event.notes ? (
            <p className="text-xs italic text-neutral-600">{event.notes}</p>
          ) : null}

          {!delivered ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="inline-flex items-center gap-2 border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black]"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Confirm receipt of this visit
              </button>
            </div>
          ) : null}

          {confirmOpen && !delivered ? (
            <PortalModal
              onClose={() => setConfirmOpen(false)}
              ariaLabel="Confirm receipt of visit"
              locked={pending}
            >
              <PortalModal.Header>
                <p className="text-sm font-bold text-black">
                  Confirm receipt of {event.qty} units
                </p>
                <p className="mt-1 text-xs text-neutral-600">
                  Picked up on {pickedAt}. Enter the name of whoever signed
                  for this delivery on your side.
                </p>
              </PortalModal.Header>
              <PortalModal.Body>
                <div className="space-y-2 text-xs">
                  <div>
                    <label className="font-bold text-neutral-800">
                      Recipient name
                    </label>
                    <input
                      autoFocus
                      type="text"
                      value={signatory}
                      onChange={(e) => setSignatory(e.target.value)}
                      className="mt-1 w-full border-2 border-black px-2 py-1.5"
                      placeholder="e.g. Anna Kowalski"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-neutral-800">
                      Notes{" "}
                      <span className="font-normal text-neutral-500">
                        (optional)
                      </span>
                    </label>
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={2}
                      className="mt-1 w-full border-2 border-black px-2 py-1.5"
                    />
                  </div>
                  {confirmError ? (
                    <p className="text-xs text-red-700">{confirmError}</p>
                  ) : null}
                </div>
              </PortalModal.Body>
              <PortalModal.Footer>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmOpen(false)}
                    disabled={pending}
                    className="px-3 py-1.5 text-xs text-neutral-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={submitConfirm}
                    disabled={pending}
                    className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:opacity-50"
                  >
                    {pending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Record delivery
                  </button>
                </div>
              </PortalModal.Footer>
            </PortalModal>
          ) : null}

          {lightboxIndex !== null && lightboxPhotos.length > 0 ? (
            <DispatchPhotoLightbox
              photos={lightboxPhotos}
              openIndex={lightboxIndex}
              onClose={() => setLightboxIndex(null)}
              onIndexChange={setLightboxIndex}
            />
          ) : null}
        </div>
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


// Terminal-choice panel — surfaces the explicit "more or done"
// question once every paid-for sample has landed a verdict and no
// finance decision is pending. Both buttons open a modal so a stray
// click doesn't spawn a finance invoice or lock the cycle. The
// panel itself owns nothing beyond the two triggers.
function TerminalChoicePanel({
  busy,
  onOpenRequestMore,
  onOpenConfirmDone,
}: {
  busy: boolean;
  onOpenRequestMore: () => void;
  onOpenConfirmDone: () => void;
}) {
  return (
    <div className="mt-4 border-2 border-black bg-white p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
        What next?
      </p>
      <p className="mt-1 text-xs text-neutral-600">
        Either request another batch to keep iterating, or lock this in
        and move on to the final specification.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={onOpenRequestMore}
          className="flex-1 border-2 border-black bg-white p-3 text-left transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <p className="flex items-center gap-2 text-sm font-black uppercase">
            <Plus className="h-4 w-4" /> Request more samples
          </p>
          <p className="mt-1 text-xs text-neutral-600">
            We&rsquo;ll invoice you for the extras and produce another batch.
          </p>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onOpenConfirmDone}
          className="flex-1 border-2 border-black bg-black p-3 text-left text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <p className="flex items-center gap-2 text-sm font-black uppercase">
            <Check className="h-4 w-4" />
            No, we&rsquo;re done
          </p>
          <p className="mt-1 text-xs text-neutral-300">
            Lock in the recipe and move on to the final specification.
          </p>
        </button>
      </div>
    </div>
  );
}


function RequestMoreModal({
  open,
  currency,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (quantity: number) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(1);
  // Reset the picker back to 1 whenever the modal reopens so a
  // customer who bailed on 20 last time doesn't unknowingly submit
  // it a session later.
  useEffect(() => {
    if (open) setQuantity(1);
  }, [open]);
  if (!open) return null;
  return (
    <PortalModal
      onClose={onClose}
      ariaLabel="Request additional samples"
      locked={busy}
    >
      <PortalModal.Header>
        <div className="flex items-start justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Request additional samples
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-neutral-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </PortalModal.Header>
      <PortalModal.Body>
        <p className="text-sm text-neutral-800">
          How many extra samples would you like us to produce?
        </p>
        <p className="mt-1 text-xs text-neutral-600">
          {currency} per extra sample. Finance approves the invoice; we
          produce as soon as it lands.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <label className="text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Quantity
          </label>
          <input
            type="number"
            min={1}
            max={100}
            value={quantity}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v)) setQuantity(Math.max(1, Math.min(100, v)));
            }}
            disabled={busy}
            className="w-20 border-2 border-black bg-white px-3 py-1.5 text-center text-lg font-black focus:outline-none disabled:opacity-60"
          />
        </div>
      </PortalModal.Body>
      <PortalModal.Footer>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onConfirm(quantity)}
            className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Confirm — request {quantity}
          </button>
        </div>
      </PortalModal.Footer>
    </PortalModal>
  );
}


function ConfirmDoneModal({
  open,
  totalSlots,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  totalSlots: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  if (!open) return null;
  return (
    <PortalModal
      onClose={onClose}
      ariaLabel="Confirm samples complete"
      locked={busy}
    >
      <PortalModal.Header>
        <div className="flex items-start justify-between gap-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Sure you don&rsquo;t want more samples?
          </p>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-neutral-500 hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </PortalModal.Header>
      <PortalModal.Body>
        <p className="text-sm text-neutral-800">
          You&rsquo;ve had <strong>{totalSlots}</strong> sample
          {totalSlots === 1 ? "" : "s"}. If you say we&rsquo;re done, we&rsquo;ll
          take the last approved recipe as final and start preparing your final
          specification for sign-off.
        </p>
        <p className="mt-2 border-2 border-amber-500 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>Heads up:</strong> if you don&rsquo;t approve the final
          specification once we send it, changing the recipe means starting a
          fresh round of samples — which has to be paid for again before we
          can revise the spec. So make sure you&rsquo;re happy before locking
          it in.
        </p>
      </PortalModal.Body>
      <PortalModal.Footer>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest text-black transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Not yet
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-xs font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[3px_3px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Yes, we&rsquo;re done
          </button>
        </div>
      </PortalModal.Footer>
    </PortalModal>
  );
}
