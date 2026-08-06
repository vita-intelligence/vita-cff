"use client";

import { Button, Modal } from "@heroui/react";
import { FileCheck2, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import type {
  FinalSpecAvailableDto,
  ProjectOverviewDto,
} from "@/services/formulations";
import {
  useCreateFinalSpecFromTrial,
  useFormulationVersions,
} from "@/services/formulations";
import { useTrialBatches } from "@/services/trial_batches";


const INPUT_CLASS =
  "w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";


/**
 * Bright banner shown across every tab of the project workspace when
 * a trial batch has passed validation AND no FINAL spec exists yet.
 * Clicking the button opens a modal where the scientist picks the
 * trial batch + formulation version pair to cite on the FINAL —
 * the batch id lands in the FINAL's audit-row metadata as the
 * evidentiary basis (BRCGS Issue 9 § 5.6).
 *
 * Self-hides once a FINAL exists (server clears
 * ``overview.final_spec_available`` on next fetch).
 */
export function FinalSpecAvailableBanner({
  orgId,
  overview,
  canWrite,
}: {
  orgId: string;
  overview: ProjectOverviewDto;
  canWrite: boolean;
}) {
  const [open, setOpen] = useState(false);

  const state = overview.final_spec_available;
  if (state === null || !canWrite) return null;

  return (
    <>
      <div className="flex flex-col gap-2 rounded-lg border-2 border-emerald-400 bg-emerald-50 px-4 py-3 text-sm shadow-sm dark:border-emerald-500/60 dark:bg-emerald-950/40 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 sm:items-center">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300 sm:mt-0" />
          <div>
            <p className="font-semibold text-emerald-900 dark:text-emerald-100">
              Final spec is available for creation
            </p>
            <p className="mt-0.5 text-xs text-emerald-800/90 dark:text-emerald-200/80">
              Trial batch{" "}
              <span className="font-medium">
                {state.trial_batch_label}
              </span>{" "}
              passed validation on{" "}
              <span className="font-medium">
                {state.formulation_version_label}
              </span>
              . Freeze the recipe by cutting the FINAL spec — you can pick a
              different trial or version in the modal.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-emerald-500/70 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 shadow-sm transition-colors hover:bg-emerald-100 dark:border-emerald-600/70 dark:bg-emerald-950/60 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
        >
          <FileCheck2 className="h-3.5 w-3.5" />
          Create final spec
        </button>
      </div>

      <CreateFinalSpecModal
        open={open}
        onClose={() => setOpen(false)}
        orgId={orgId}
        formulationId={overview.id}
        defaults={state}
      />
    </>
  );
}


function CreateFinalSpecModal({
  open,
  onClose,
  orgId,
  formulationId,
  defaults,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  formulationId: string;
  defaults: FinalSpecAvailableDto;
}) {
  const tErrors = useTranslations("errors");
  const batchesQuery = useTrialBatches(orgId, formulationId);
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const createMutation = useCreateFinalSpecFromTrial(orgId, formulationId);

  const [trialBatchId, setTrialBatchId] = useState(defaults.trial_batch_id);
  const [versionId, setVersionId] = useState(defaults.formulation_version_id);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Only offer trial batches that passed validation — anything else
  // is a category error (the FINAL spec cites its evidentiary root).
  const passedBatches = useMemo(
    () =>
      (batchesQuery.data ?? []).filter(
        (b) => b.validation_status === "passed",
      ),
    [batchesQuery.data],
  );

  // Only offer versions that are ready — same filter the New Draft
  // Spec picker uses (see ``new-spec-sheet-button.tsx``): drop
  // ``is_auto=true`` intermediates AND versions that didn't pass the
  // readiness gate. A FINAL cut against a half-built version would
  // be a broken artefact from day one.
  const readyVersions = useMemo(
    () =>
      (versionsQuery.data ?? []).filter((v) => !v.is_auto && v.is_complete),
    [versionsQuery.data],
  );

  // Default from the banner snapshot may point at a version that's
  // no longer "ready" (someone edited it back into an incomplete
  // state between pass + open). Fall back to the newest ready
  // version so the dropdown lands on a valid option instead of
  // rendering a stale ghost selection.
  const effectiveVersionId = useMemo(() => {
    if (readyVersions.some((v) => v.id === versionId)) return versionId;
    return readyVersions[0]?.id ?? "";
  }, [readyVersions, versionId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trialBatchId || !effectiveVersionId) return;
    setErrorMessage(null);
    try {
      await createMutation.mutateAsync({
        trialBatchId,
        formulationVersionId: effectiveVersionId,
      });
      onClose();
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  Create final spec sheet
                </Modal.Heading>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full p-1 text-ink-500 hover:bg-ink-100"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  The FINAL spec is a frozen record — cite the trial batch
                  that provides its evidentiary basis + the formulation
                  version it locks against. Pre-selected below from the most
                  recent passed trial; swap either dropdown before creating.
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>Trial batch</span>
                  <select
                    value={trialBatchId}
                    onChange={(e) => setTrialBatchId(e.target.value)}
                    className={INPUT_CLASS}
                    disabled={batchesQuery.isLoading}
                    required
                  >
                    {passedBatches.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.label || `Batch ${batch.id.slice(0, 8)}`} (v
                        {batch.formulation_version_number})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>Formulation version</span>
                  <select
                    value={effectiveVersionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className={INPUT_CLASS}
                    disabled={versionsQuery.isLoading}
                    required
                  >
                    {readyVersions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                  {readyVersions.length === 0 && !versionsQuery.isLoading ? (
                    <span className="text-xs text-warning">
                      No named + complete versions on this project yet.
                      Save a named version from the builder first.
                    </span>
                  ) : null}
                </label>

                {errorMessage ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {errorMessage}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={onClose}
                  isDisabled={createMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:bg-ink-200 disabled:text-ink-500"
                  isDisabled={
                    createMutation.isPending ||
                    !trialBatchId ||
                    !effectiveVersionId
                  }
                >
                  Create final spec
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
