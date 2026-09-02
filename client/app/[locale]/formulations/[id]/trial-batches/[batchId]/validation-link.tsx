"use client";

import { Button } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateValidation,
  useValidationForBatch,
} from "@/services/product_validation";
import {
  useTrialBatchPspMoChain,
  type BatchKind,
} from "@/services/trial_batches";


/**
 * "Start / Open validation" CTA on the trial-batch detail page.
 *
 * Queries the batch's validation existence client-side. When none
 * exists the button creates one in-place and routes to the new
 * page; when one does, it's a plain link so the user can peek at
 * the draft status from the URL (shareable to the R&D manager).
 *
 * Gating rule (MO chain):
 *
 * ``kind === "sample"`` (customer-facing production — storefront
 * sample kits + cycle-slot sample batches) blocks the button until
 * a PSP MO is pushed AND every stage in the chain hits
 * ``status = completed``. You can't validate a product that hasn't
 * actually been produced yet, and a sample batch that never gets
 * pushed to PSP has produced nothing. Message steers the scientist
 * at the right next action ("Create MO on PSP" first, then wait
 * for production).
 *
 * ``kind === "trial"`` (bench-scale scientist run) keeps the
 * unrestricted CTA — bench trials legitimately don't need a PSP
 * MO. Scientist can pop the validation open whenever they want to
 * record the pen-and-paper QC verdict.
 *
 * Gating rule (sample kind + formulation validated): sample batches
 * for a formulation version that another batch has already validated
 * hide the "Start" CTA entirely — customer-sample runs inherit the
 * proof from the trial batch, so re-validating on every sample is
 * paperwork with no compliance value. Trial batches always show the
 * CTA (validation happens on trials, not samples). If a sample batch
 * has its own validation record on it, the "Open" link still renders
 * — that's data we don't want to hide behind the kind gate.
 */
export function ValidationLink({
  orgId,
  formulationId,
  batchId,
  kind,
  projectType,
  formulationValidated = false,
  linkedPspMoUuid = null,
}: {
  orgId: string;
  formulationId: string;
  batchId: string;
  /** ``"trial"`` or ``"sample"``. Sample batches hide the Start CTA
   *  when the formulation version is already validated — see the
   *  gating rule in the docstring above. */
  kind: BatchKind;
  /** ``custom`` vs ``ready_to_go``. On RTG projects the Start
   *  CTA is hidden entirely — the RTG SKU's FINAL-spec approval is
   *  the validation gate; sample fulfillment against it is just
   *  production, not R&D validation. Custom projects keep the CTA
   *  (validation happens per trial-batch record).
   *
   *  Empty string on legacy trial batches without the field set —
   *  falls through to the existing custom-flow gating so nothing
   *  regresses. */
  projectType?: "custom" | "ready_to_go" | "";
  /** ``true`` when *another* batch of the same formulation version
   *  has a passed validation. Comes from the batch read serializer;
   *  only load-bearing when ``kind === "sample"``. */
  formulationValidated?: boolean;
  /** PSP MO uuid from ``TrialBatch.psp_manufacturing_order_uuid``.
   *  When set, gates the Start button on the chain being fully
   *  completed. When null, no gate. */
  linkedPspMoUuid?: string | null;
}) {
  const tV = useTranslations("product_validation");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const existingQuery = useValidationForBatch(orgId, batchId);
  const createMutation = useCreateValidation(orgId);

  // Only fetch the chain when a PSP MO exists. Poll at the same 20s
  // cadence as the linked-MO chip so the gate lifts automatically
  // when the last stage completes, without the scientist refreshing.
  const chainQuery = useTrialBatchPspMoChain(orgId, batchId, {
    enabled: Boolean(linkedPspMoUuid),
    refetchInterval: linkedPspMoUuid ? 20_000 : undefined,
  });

  const moGate = useMemo(() => {
    // Bench-scale trials don't need a PSP MO to validate — scientist
    // records the pen-and-paper QC verdict directly.
    if (kind === "trial") return { blocked: false, reason: null as string | null };
    // Sample batches (customer-facing) MUST have production run
    // before validation. No linked MO ⇒ nothing has been produced,
    // so the button is blocked with a hint at the correct next
    // action.
    if (!linkedPspMoUuid) {
      return {
        blocked: true,
        reason:
          "Push the MO to PSP first — validation can't run until production has actually been produced.",
      };
    }
    const chain = chainQuery.data?.chain ?? [];
    if (chainQuery.isLoading && chain.length === 0) {
      return { blocked: true, reason: "Loading MO status…" };
    }
    if (chain.length === 0) {
      return {
        blocked: true,
        reason:
          "PSP MO chain not available yet — the trial run must complete before validation.",
      };
    }
    const pending = chain.filter((n) => n.status !== "completed");
    if (pending.length === 0) return { blocked: false, reason: null };
    return {
      blocked: true,
      reason: `Finish the trial run first — ${pending.length} of ${chain.length} stage MO${
        chain.length === 1 ? "" : "s"
      } still ${pending.length === 1 ? "is" : "are"} not completed on PSP.`,
    };
  }, [kind, linkedPspMoUuid, chainQuery.data, chainQuery.isLoading]);

  const isBusy = createMutation.isPending || existingQuery.isLoading;

  if (existingQuery.data) {
    const v = existingQuery.data;
    return (
      <Link
        href={`/formulations/${formulationId}/trial-batches/${batchId}/validation/${v.id}`}
        className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
      >
        <LinkIconSlot
          idleIcon={<ShieldCheck className="h-4 w-4" />}
          spinnerSizeClassName="h-4 w-4"
        />
        {tV("link.open")}
      </Link>
    );
  }

  // RTG sample batches are just production runs of a pre-validated
  // SKU — the RTG's FINAL-spec approval flow is what validates the
  // recipe. There's no per-batch validation to run here, so hide
  // the CTA entirely (no chip either — the "Start validation" tile
  // has no place on the fulfillment-run page, empty or with a
  // "product validated" message). Trial-kind batches on an RTG
  // project (in-house R&D validation runs BEFORE the SKU publishes)
  // keep the CTA.
  if (kind === "sample" && projectType === "ready_to_go") {
    return null;
  }

  // Sample batch for a formulation version that another batch has
  // already validated → hide the Start CTA. Show a subtle chip so
  // the operator understands why the button is missing (rather than
  // wondering if the page is broken). Trial batches skip this gate.
  if (kind === "sample" && formulationValidated) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
        <ShieldCheck className="h-4 w-4" />
        {tV("link.formulation_validated")}
      </span>
    );
  }

  const handleStart = async () => {
    // Client-side guard — the button is also disabled, but a race
    // where the chain query resolves "incomplete" between click
    // and mount is still possible on slow connections. Bail early.
    if (moGate.blocked) return;
    try {
      const created = await createMutation.mutateAsync({
        trial_batch_id: batchId,
      });
      router.push(
        `/formulations/${formulationId}/trial-batches/${batchId}/validation/${created.id}`,
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? translateCode(tErrors, firstErrorCode(err) ?? "generic")
          : tErrors("generic");
      // Surface via alert for now — the CTA is a single button,
      // a full inline error banner would be over-engineered.
      window.alert(message);
    }
  };

  const disabled = isBusy || moGate.blocked;

  return (
    // Wrapper span carries the hover tooltip because HeroUI's
    // Button doesn't accept ``title`` — and the gate's *why* needs
    // to be discoverable without a design-heavy Tooltip component.
    <span title={moGate.reason ?? undefined} className="inline-flex">
      <Button
        type="button"
        variant="primary"
        size="sm"
        className="rounded-lg bg-orange-500 px-3 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
        isDisabled={disabled}
        onClick={handleStart}
        aria-disabled={disabled}
      >
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4" />
          {tV("link.start")}
        </span>
      </Button>
    </span>
  );
}


function firstErrorCode(error: ApiError): string | null {
  for (const codes of Object.values(error.fieldErrors)) {
    if (Array.isArray(codes) && codes.length > 0) {
      return String(codes[0]);
    }
  }
  return null;
}
