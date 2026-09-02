"use client";

import { Button, Modal } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { FileCheck2, ShieldCheck, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { apiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import type {
  FinalSpecAvailableDto,
  FormulationVersionDto,
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


/** Render one dropdown row as ``v3 · 1 Sep 2026 — Optional label``.
 *  Date parse defensive against malformed / missing ``created_at``.
 *  Mirrors the helper on ``new-spec-sheet-button.tsx`` — kept as a
 *  local copy rather than shared util because the two callers live
 *  in unrelated components with no natural common module. */
function formatVersionOptionLabel(v: FormulationVersionDto): string {
  const parts: string[] = [`v${v.version_number}`];
  const created = v.created_at ? new Date(v.created_at) : null;
  if (created && !Number.isNaN(created.getTime())) {
    parts.push(
      created.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    );
  }
  const head = parts.join(" · ");
  return v.label ? `${head} — ${v.label}` : head;
}


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
  // Optimistic dismiss. The overview comes in as an SSR prop, so the
  // parent's cache write from the create mutation isn't observed here
  // until the page revalidates. We drop the banner locally the moment
  // the create succeeds and call ``router.refresh()`` in parallel so
  // the next SSR pass returns ``final_spec_available: null`` on its
  // own. Without this the operator sees the banner linger for a full
  // reload after their click.
  const [dismissed, setDismissed] = useState(false);

  const state = overview.final_spec_available;
  if (state === null || dismissed || !canWrite) return null;

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
        onCreated={() => setDismissed(true)}
        orgId={orgId}
        formulationId={overview.id}
        projectCode={overview.code ?? ""}
        defaults={state}
      />
    </>
  );
}


function CreateFinalSpecModal({
  open,
  onClose,
  onCreated,
  orgId,
  formulationId,
  projectCode,
  defaults,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  orgId: string;
  formulationId: string;
  //: Project code (e.g. "MA01446"). Seeds the ``code`` input so the
  //: FINAL sheet's code lands as ``<projectCode>-FINAL`` by default.
  //: Scientist can still override before submitting.
  projectCode: string;
  defaults: FinalSpecAvailableDto;
}) {
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const batchesQuery = useTrialBatches(orgId, formulationId);
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const createMutation = useCreateFinalSpecFromTrial(orgId, formulationId);

  // Trial-batch cycle lookup — used to seed the run-quantity input
  // from the proposal's contracted quantity. Same endpoint the spec-
  // sheets tab already hits (`useCycleForSpecTab`); 404 is expected
  // when no cycle exists yet, treat any error as "no default" rather
  // than blocking the modal.
  const cycleQuery = useQuery<{ proposal_line_quantity: number | null } | null>({
    queryKey: ["trial-batch-cycle-by-formulation", orgId, formulationId],
    queryFn: async () => {
      try {
        const { data } = await apiClient.get<{
          cycle: { proposal_line_quantity: number | null };
        }>(
          `/api/organizations/${orgId}/formulations/${formulationId}/trial-batch-cycle/`,
        );
        return data.cycle;
      } catch {
        return null;
      }
    },
    staleTime: 30_000,
    enabled: open,
  });
  const defaultQuantity = cycleQuery.data?.proposal_line_quantity ?? null;

  const [trialBatchId, setTrialBatchId] = useState(defaults.trial_batch_id);
  // Deliberately do NOT seed from ``defaults.formulation_version_id``
  // (the trial's pinned version). Scientists iterate the recipe post-
  // trial and expect the FINAL to pin against their newest save, not
  // the one the trial physically consumed. Empty initial → the
  // effectiveVersionId memo below falls through to the newest ready
  // version. User can still manually swap either dropdown.
  const [versionId, setVersionId] = useState("");
  // Extra fields matching the button-modal UX — code, run quantity,
  // cover notes. Scientist can leave any of them blank and the
  // backend falls back to the source-draft copy (or a dosage-form
  // default) so the modal stays lightweight when nothing's being
  // overridden.
  const [code, setCode] = useState(
    projectCode ? `${projectCode}-FINAL` : "",
  );
  const [quantity, setQuantity] = useState<string>(
    defaultQuantity != null ? String(defaultQuantity) : "",
  );
  const [coverNotes, setCoverNotes] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Late-arriving cycle → sync the quantity seed only if the user
  // hasn't typed yet (matches the button-modal's ``defaultQuantity``
  // sync pattern). Same effect keeps the code seed in step if the
  // projectCode prop changes after mount.
  useEffect(() => {
    if (defaultQuantity == null) return;
    if (quantity.trim().length > 0) return;
    setQuantity(String(defaultQuantity));
  }, [defaultQuantity, quantity]);

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
  //
  // Sort newest-first (``version_number DESC``) so the latest
  // iteration sits at the TOP of the dropdown AND becomes the default
  // preselection. Scientists iterating a recipe post-trial expect the
  // freshly-saved version to be the one the FINAL pins against —
  // "the trial batch validated the direction; the last save is what
  // the customer's actually signing". The trial-batch dropdown above
  // still shows which trial provided the evidentiary basis; the
  // version dropdown is a separate choice they can override.
  const readyVersions = useMemo(
    () =>
      (versionsQuery.data ?? [])
        .filter((v) => !v.is_auto && v.is_complete)
        .slice()
        .sort((a, b) => b.version_number - a.version_number),
    [versionsQuery.data],
  );

  // Default: the user's most recent named + complete version. The
  // banner-supplied ``defaults.formulation_version_id`` (the trial's
  // pinned version) used to win here, but scientists iterating past
  // the trial expected the newest — not the trial's — to pre-select.
  // Falls back to whatever the user manually re-picked when it's
  // still in the ready list.
  const effectiveVersionId = useMemo(() => {
    if (readyVersions.some((v) => v.id === versionId)) return versionId;
    return readyVersions[0]?.id ?? "";
  }, [readyVersions, versionId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trialBatchId || !effectiveVersionId) return;
    setErrorMessage(null);
    const parsedQty = Number.parseInt(quantity, 10);
    try {
      await createMutation.mutateAsync({
        trialBatchId,
        formulationVersionId: effectiveVersionId,
        // Only send fields the user actually typed — blank/empty ones
        // fall through to the backend's source-draft copy fallback.
        // Quantity is intentionally the one field where an out-of-
        // range value gets swallowed here (backend returns 400 on 0
        // or negative) so we don't send a garbage number the modal
        // silently accepts.
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(Number.isFinite(parsedQty) && parsedQty > 0
          ? { quantity: parsedQty }
          : {}),
        ...(coverNotes.trim() ? { coverNotes: coverNotes.trim() } : {}),
      });
      // Drop the banner locally + trigger an SSR revalidation. The
      // overview is loaded server-side (`load-project.ts`), so the
      // query-cache write inside the hook wouldn't cascade to the
      // banner prop on its own — refresh re-runs the loader.
      onCreated();
      router.refresh();
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
              <Modal.Header className="flex items-center justify-between gap-3 border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  Create final spec sheet
                </Modal.Heading>
                {/* Green "Final" badge — matches the badge on the
                    button-modal path so both surfaces read as the
                    same commercial-authoring flow. */}
                <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 ring-1 ring-emerald-500/30">
                  <ShieldCheck className="h-3 w-3" /> Final
                </span>
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
                {/* Same emerald info card the button-modal shows, so
                    scientists opening either surface get the same
                    context on what a FINAL sheet is + why it's a
                    load-bearing commitment. */}
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/70 p-3 text-xs text-emerald-950">
                  <p className="font-semibold">
                    This is the customer-facing final specification.
                  </p>
                  <p className="mt-1">
                    Cite the trial batch that provides its evidentiary basis +
                    the formulation version it locks against. Pre-selected
                    from the most recent passed trial; swap either dropdown
                    before creating. Once created, the customer will be asked
                    to sign it — that signature authorises full production.
                  </p>
                </div>

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
                        {formatVersionOptionLabel(v)}
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

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>Code</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>Run quantity</span>
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className={INPUT_CLASS}
                  />
                  <span className="text-xs text-ink-500">
                    {defaultQuantity != null
                      ? `Seeded from the proposal (${defaultQuantity} units). This is the last time you can change the run size — once the customer signs, it's locked.`
                      : "This is the last time you can change the run size — once the customer signs, it's locked."}
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>Cover notes</span>
                  <textarea
                    rows={3}
                    value={coverNotes}
                    onChange={(e) => setCoverNotes(e.target.value)}
                    className={INPUT_CLASS}
                  />
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
