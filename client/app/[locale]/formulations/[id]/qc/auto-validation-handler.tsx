"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import {
  useCreateValidation,
  useValidationForBatch,
} from "@/services/product_validation";

interface Props {
  orgId: string;
  formulationId: string;
  trialBatchId: string;
}

/**
 * Client-side handler triggered when the QC page lands with
 * ``?auto=1&trial_batch=<uuid>`` — the query string PSP's Output QC
 * page attaches to its "Open on NPD" deep-link.
 *
 * Flow:
 *   1. Look up whether a ProductValidation already exists for this
 *      trial batch. If yes → jump into its editor.
 *   2. If no → create one with an empty notes field and jump into
 *      the new editor. The create call is guarded by a ref so a
 *      React re-mount can't fire it twice.
 *
 * Renders a lightweight status card while the redirect resolves. On
 * error, surfaces the message inline so the operator knows to fall
 * back to the manual New-validation modal.
 */
export function AutoValidationHandler({
  orgId,
  formulationId,
  trialBatchId,
}: Props) {
  const router = useRouter();
  const createMutation = useCreateValidation(orgId);
  const validationForBatch = useValidationForBatch(orgId, trialBatchId);

  // Guard: React can double-mount effects in dev / with StrictMode.
  // A validation is a top-level artefact — never create two.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    if (validationForBatch.isLoading) return;

    startedRef.current = true;

    const existing = validationForBatch.data;
    if (existing) {
      router.replace(
        `/formulations/${formulationId}/trial-batches/${trialBatchId}/validation/${existing.id}`,
      );
      return;
    }

    createMutation.mutate(
      { trial_batch_id: trialBatchId, notes: "" },
      {
        onSuccess: (created) => {
          router.replace(
            `/formulations/${formulationId}/trial-batches/${trialBatchId}/validation/${created.id}`,
          );
        },
        onError: () => {
          // Reset the ref so a manual retry (e.g. a full refresh) can
          // fire again. The visible error below tells the operator
          // what to do next.
          startedRef.current = false;
        },
      },
    );
    // The mutation is intentionally not in the dep list — we invoke
    // it exactly once per trialBatchId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    validationForBatch.isLoading,
    validationForBatch.data,
    trialBatchId,
    formulationId,
    router,
  ]);

  const error =
    validationForBatch.error?.message ?? createMutation.error?.message ?? null;
  const busyLabel = validationForBatch.isLoading
    ? "Looking up existing validation…"
    : createMutation.isPending
      ? "Creating validation…"
      : "Redirecting…";

  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-sm text-ink-700">
      {error ? (
        <>
          <p className="font-semibold text-red-700">
            Couldn&apos;t open the validation automatically.
          </p>
          <p className="mt-1 text-xs text-red-700/80">{error}</p>
          <p className="mt-2 text-xs text-ink-500">
            Use the &quot;New validation&quot; button on this page instead.
          </p>
        </>
      ) : (
        <p>{busyLabel}</p>
      )}
    </div>
  );
}
