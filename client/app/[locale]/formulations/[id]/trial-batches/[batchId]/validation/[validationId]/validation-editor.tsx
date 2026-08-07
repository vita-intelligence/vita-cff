"use client";

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  PlayCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { PassedValidationSheet } from "./passed-validation-sheet";
import { SignatureDialog } from "@/components/ui/signature-dialog";
import { Link, useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { clientUuid } from "@/lib/utils";
import {
  ALLOWED_VALIDATION_TRANSITIONS,
  useTransitionValidationStatus,
  useUpdateValidation,
  useValidation,
  useValidationStats,
  type ProductValidationDto,
  type ValidationStatsDto,
  type ValidationStatus,
} from "@/services/product_validation";


/** Transitions that demand a captured signature before the backend
 * will accept them — mirrors ``_SIGNATURE_TRANSITIONS`` in
 * ``apps/product_validation/services.py``. Each entry is
 * ``"<fromStatus>:<toStatus>"``. Other transitions (rewinds) skip
 * the signature dialog entirely. */
const SIGNATURE_TRANSITIONS: ReadonlySet<string> = new Set([
  "draft:in_progress",
  "in_progress:passed",
  "in_progress:failed",
]);


/**
 * Multi-section editor for a :class:`ProductValidation`. Each test
 * section maintains its own draft state; a single "Save" button
 * pushes everything back to the server in one PATCH. Stats are
 * re-fetched automatically after save so the scientist sees the
 * updated pass/fail roll-up without a manual refresh.
 */
export function ValidationEditor({
  orgId,
  formulationId,
  batchId,
  initialValidation,
  initialStats,
  canWrite,
}: {
  orgId: string;
  formulationId: string;
  batchId: string;
  initialValidation: ProductValidationDto;
  initialStats: ValidationStatsDto;
  canWrite: boolean;
}) {
  const tV = useTranslations("product_validation");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const validationQuery = useValidation(orgId, initialValidation.id);
  const statsQuery = useValidationStats(orgId, initialValidation.id);

  const validation = validationQuery.data ?? initialValidation;
  const stats = statsQuery.data ?? initialStats;

  const updateMutation = useUpdateValidation(orgId, initialValidation.id);
  const transitionMutation = useTransitionValidationStatus(
    orgId,
    initialValidation.id,
  );

  const [error, setError] = useState<string | null>(null);

  // Draft state — initialised from the server values, reset each
  // time ``validation.updated_at`` changes so a save-then-edit
  // flow doesn't clobber the freshly-loaded values. Samples are
  // modelled as ``SampleEntry[]`` (one row per measurement) so the
  // scientist can add / remove / edit individual samples without
  // hand-parsing a comma-separated blob.
  const [weightSamples, setWeightSamples] = useState<SampleEntry[]>(
    () => samplesToEntries(validation.weight_test.samples),
  );
  const [weightTarget, setWeightTarget] = useState<string>(
    validation.weight_test.target_mg?.toString() ?? "",
  );
  const [weightTolerance, setWeightTolerance] = useState<string>(
    validation.weight_test.tolerance_pct?.toString() ?? "10",
  );
  const [weightNotes, setWeightNotes] = useState<string>(
    validation.weight_test.notes ?? "",
  );

  const [disintegrationLimit, setDisintegrationLimit] = useState<string>(
    validation.disintegration_test.limit_minutes?.toString() ?? "60",
  );
  const [disintegrationTemp, setDisintegrationTemp] = useState<string>(
    validation.disintegration_test.temperature_c?.toString() ?? "37",
  );
  const [disintegrationSamples, setDisintegrationSamples] = useState<
    SampleEntry[]
  >(() => samplesToEntries(validation.disintegration_test.samples));
  const [disintegrationNotes, setDisintegrationNotes] = useState<string>(
    validation.disintegration_test.notes ?? "",
  );

  const [orgTargetColour, setOrgTargetColour] = useState(
    validation.organoleptic_test.target.colour,
  );
  const [orgTargetTaste, setOrgTargetTaste] = useState(
    validation.organoleptic_test.target.taste,
  );
  const [orgTargetOdour, setOrgTargetOdour] = useState(
    validation.organoleptic_test.target.odour,
  );
  const [orgActualColour, setOrgActualColour] = useState(
    validation.organoleptic_test.actual.colour,
  );
  const [orgActualTaste, setOrgActualTaste] = useState(
    validation.organoleptic_test.actual.taste,
  );
  const [orgActualOdour, setOrgActualOdour] = useState(
    validation.organoleptic_test.actual.odour,
  );
  const [orgPassed, setOrgPassed] = useState<boolean | null>(
    validation.organoleptic_test.passed,
  );
  const [orgNotes, setOrgNotes] = useState(validation.organoleptic_test.notes);

  const [notes, setNotes] = useState(validation.notes);

  const isBusy = updateMutation.isPending || transitionMutation.isPending;
  const isReadOnly = !canWrite;

  const handleSave = async () => {
    setError(null);
    try {
      await updateMutation.mutateAsync({
        weight_test: {
          target_mg: parseNumberOrNull(weightTarget),
          tolerance_pct: parseNumberOrZero(weightTolerance),
          samples: entriesToSamples(weightSamples),
          notes: weightNotes,
        },
        disintegration_test: {
          limit_minutes: parseNumberOrNull(disintegrationLimit),
          temperature_c: parseNumberOrNull(disintegrationTemp),
          samples: entriesToSamples(disintegrationSamples),
          notes: disintegrationNotes,
        },
        organoleptic_test: {
          target: {
            colour: orgTargetColour,
            taste: orgTargetTaste,
            odour: orgTargetOdour,
          },
          actual: {
            colour: orgActualColour,
            taste: orgActualTaste,
            odour: orgActualOdour,
          },
          passed: orgPassed,
          notes: orgNotes,
        },
        notes,
      });
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const [pendingTransition, setPendingTransition] =
    useState<ValidationStatus | null>(null);
  const [sigError, setSigError] = useState<string | null>(null);

  const handleTransition = async (next: ValidationStatus) => {
    setError(null);
    const key = `${validation.status}:${next}`;
    if (SIGNATURE_TRANSITIONS.has(key)) {
      // Sign-off move — open the signature dialog and wait for the
      // canvas capture before hitting the API.
      setSigError(null);
      setPendingTransition(next);
      return;
    }
    // Rewind-style transition (back to draft, etc.) — no signature
    // needed; straight through to the server.
    try {
      await transitionMutation.mutateAsync({ status: next });
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const handleSignatureConfirm = async (dataUrl: string) => {
    if (!pendingTransition) return;
    setSigError(null);
    try {
      await transitionMutation.mutateAsync({
        status: pendingTransition,
        signature_image: dataUrl,
      });
      setPendingTransition(null);
      router.refresh();
    } catch (err) {
      setSigError(extractApiErrorMessage(err, tErrors));
    }
  };

  const allowedNext = ALLOWED_VALIDATION_TRANSITIONS[validation.status] ?? [];

  // While the validation is still in draft AND the operator can edit,
  // render the targets wizard (3 steps for weight / disintegration /
  // organoleptic spec fields). Once in_progress it flips to the full
  // section-based editor so the scientist can record samples against
  // the targets they set. Read-only viewers always see the section
  // layout — the wizard is an editing affordance, not a viewer.
  const isDraftWizard = validation.status === "draft" && canWrite;

  // Once passed, the validation is a compliance artefact — render
  // the WeasyPrint sheet in place of the editor so QA sees the
  // final document form. The editor stays reachable via a rewind to
  // in_progress (allowed transition).
  const isPassedSheet = validation.status === "passed";

  // Client-side mirror of the BE `_missing_target_fields` gate. Used
  // by the wizard to disable the "Start validation" button and by the
  // step tracker to show which step is still incomplete.
  const missingTargets = collectMissingTargets({
    weightTarget,
    weightTolerance,
    disintegrationLimit,
    disintegrationTemp,
    orgTargetColour,
    orgTargetTaste,
    orgTargetOdour,
  });

  // Draft is "dirty" when any local field differs from the last
  // server snapshot. Powers the Save button's disabled state — no
  // point offering to save something that's already saved.
  const isDirty = useMemo(
    () =>
      draftDiffersFromServer({
        server: validation,
        weightTarget,
        weightTolerance,
        weightSamples,
        weightNotes,
        disintegrationLimit,
        disintegrationTemp,
        disintegrationSamples,
        disintegrationNotes,
        orgTargetColour,
        orgTargetTaste,
        orgTargetOdour,
        orgActualColour,
        orgActualTaste,
        orgActualOdour,
        orgPassed,
        orgNotes,
        notes,
      }),
    [
      validation,
      weightTarget,
      weightTolerance,
      weightSamples,
      weightNotes,
      disintegrationLimit,
      disintegrationTemp,
      disintegrationSamples,
      disintegrationNotes,
      orgTargetColour,
      orgTargetTaste,
      orgTargetOdour,
      orgActualColour,
      orgActualTaste,
      orgActualOdour,
      orgPassed,
      orgNotes,
      notes,
    ],
  );

  // Live-recompute stats from the current draft state so the
  // operator sees mean/std-dev/allowed-range/pass update the moment
  // they type a sample — not only after Save. Server stats
  // (`statsQuery`) are kept as a fallback for fields we don't
  // compute locally.
  const liveStats = useMemo(
    () =>
      computeLiveStats({
        server: stats,
        weightTarget,
        weightTolerance,
        weightSamples,
        disintegrationLimit,
        disintegrationSamples,
        orgTargetColour,
        orgTargetTaste,
        orgTargetOdour,
        orgActualColour,
        orgActualTaste,
        orgActualOdour,
        orgPassed,
      }),
    [
      stats,
      weightTarget,
      weightTolerance,
      weightSamples,
      disintegrationLimit,
      disintegrationSamples,
      orgTargetColour,
      orgTargetTaste,
      orgTargetOdour,
      orgActualColour,
      orgActualTaste,
      orgActualOdour,
      orgPassed,
    ],
  );

  // Client-side mirror of the BE `_missing_sample_fields` gate. Used
  // to disable the "Advance to passed" button while any section still
  // lacks samples / actual readings. `failed` deliberately skips this
  // check server-side, so we don't apply it to that button either.
  const missingSamples = collectMissingSamples({
    weightSamples,
    disintegrationSamples,
    orgActualColour,
    orgActualTaste,
    orgActualOdour,
    orgPassed,
  });

  const startValidation = async () => {
    // Persist the targets first so the BE has the latest values when
    // it re-runs the gate. If save fails, don't attempt the transition
    // — handleSave already surfaced the error.
    setError(null);
    try {
      await updateMutation.mutateAsync({
        weight_test: {
          target_mg: parseNumberOrNull(weightTarget),
          tolerance_pct: parseNumberOrZero(weightTolerance),
          samples: entriesToSamples(weightSamples),
          notes: weightNotes,
        },
        disintegration_test: {
          limit_minutes: parseNumberOrNull(disintegrationLimit),
          temperature_c: parseNumberOrNull(disintegrationTemp),
          samples: entriesToSamples(disintegrationSamples),
          notes: disintegrationNotes,
        },
        organoleptic_test: {
          target: {
            colour: orgTargetColour,
            taste: orgTargetTaste,
            odour: orgTargetOdour,
          },
          actual: {
            colour: orgActualColour,
            taste: orgActualTaste,
            odour: orgActualOdour,
          },
          passed: orgPassed,
          notes: orgNotes,
        },
        notes,
      });
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
      return;
    }
    // Now trigger the draft → in_progress transition. That opens the
    // scientist signature dialog (see SIGNATURE_TRANSITIONS); the BE
    // enforces the same missing-targets gate as a defense-in-depth.
    await handleTransition("in_progress");
  };

  return (
    <div className="mt-8 flex flex-col gap-6">
      <SignatureDialog
        isOpen={pendingTransition !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingTransition(null);
            setSigError(null);
          }
        }}
        title={
          pendingTransition
            ? tV("signature.title", {
                role:
                  pendingTransition === "in_progress"
                    ? tV("signature.role_scientist")
                    : tV("signature.role_rd_manager"),
              })
            : ""
        }
        subtitle={tV("signature.subtitle")}
        confirmLabel={tV("signature.confirm")}
        cancelLabel={tV("signature.cancel")}
        padLabel={
          pendingTransition === "in_progress"
            ? tV("signature.role_scientist")
            : tV("signature.role_rd_manager")
        }
        busy={transitionMutation.isPending}
        errorMessage={sigError}
        onConfirm={handleSignatureConfirm}
      />

      {/* Header + status transitions */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {validation.formulation_name} · v
            {validation.formulation_version_number}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {tV("title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {validation.batch_label || tV("untitled_batch")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip
            status={validation.status}
            overall={liveStats.overall_passed}
            tV={tV}
          />
          <Link
            href={`/formulations/${formulationId}/trial-batches/${batchId}`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <ArrowLeft className="h-4 w-4" />
            {tV("back")}
          </Link>
        </div>
      </header>

      {canWrite && allowedNext.length > 0 && !isDraftWizard ? (
        <section className="flex flex-wrap items-center gap-2">
          {allowedNext.map((next) => {
            // Mirror BE gate: passing the validation while any
            // section still lacks samples / actual readings would let
            // the RD manager sign off on empty test data. Failing is
            // still allowed early — bad weight doesn't force you to
            // record disintegration + organoleptic first.
            const blockedByMissingSamples =
              next === "passed" && missingSamples.length > 0;
            return (
            <Button
              key={next}
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
              isDisabled={isBusy || blockedByMissingSamples}
              onClick={() => handleTransition(next)}
            >
              {tV("advance_to")} {tV(`status.${next}` as "status.draft")}
            </Button>
            );
          })}
        </section>
      ) : null}

      {/* Missing samples hint when in_progress + user tried to pass */}
      {canWrite &&
      validation.status === "in_progress" &&
      missingSamples.length > 0 ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-500/30">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{tV("wizard.missing_samples_hint")}</span>
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      {/* Signatures */}
      <section className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SignatureCard
          role={tV("signature.scientist")}
          actor={validation.scientist}
          signedAt={validation.scientist_signed_at}
          imageDataUrl={validation.scientist_signature_image}
          emptyLabel={tV("signature.pending")}
        />
        <SignatureCard
          role={tV("signature.rd_manager")}
          actor={validation.rd_manager}
          signedAt={validation.rd_manager_signed_at}
          imageDataUrl={validation.rd_manager_signature_image}
          emptyLabel={tV("signature.pending")}
        />
      </section>

      {isDraftWizard && (
        <TargetsWizardPanel
          weightTarget={weightTarget}
          weightTolerance={weightTolerance}
          onWeightTargetChange={setWeightTarget}
          onWeightToleranceChange={setWeightTolerance}
          disintegrationLimit={disintegrationLimit}
          disintegrationTemp={disintegrationTemp}
          onDisintegrationLimitChange={setDisintegrationLimit}
          onDisintegrationTempChange={setDisintegrationTemp}
          orgTargetColour={orgTargetColour}
          orgTargetTaste={orgTargetTaste}
          orgTargetOdour={orgTargetOdour}
          onOrgTargetColourChange={setOrgTargetColour}
          onOrgTargetTasteChange={setOrgTargetTaste}
          onOrgTargetOdourChange={setOrgTargetOdour}
          missingFields={missingTargets}
          isBusy={isBusy}
          onStartValidation={startValidation}
        />
      )}

      {isPassedSheet && (
        <PassedValidationSheet
          orgId={orgId}
          validationId={validation.id}
        />
      )}

      {/* Weight test */}
      {!isDraftWizard && !isPassedSheet && (
      <>
      <TestSection title={tV("weight.title")} passed={liveStats.weight.passed}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <TextField
            label={tV("weight.target")}
            value={weightTarget}
            onChange={setWeightTarget}
            placeholder="1270"
            readOnly={isReadOnly}
            suffix="mg"
          />
          <TextField
            label={tV("weight.tolerance")}
            value={weightTolerance}
            onChange={setWeightTolerance}
            placeholder="10"
            readOnly={isReadOnly}
            suffix="%"
          />
          <ReadOnlyField
            label={tV("weight.allowed_range")}
            value={
              liveStats.weight.min_allowed_mg != null &&
              liveStats.weight.max_allowed_mg != null
                ? `${formatNumber(liveStats.weight.min_allowed_mg, 2)} – ${formatNumber(liveStats.weight.max_allowed_mg, 2)} mg`
                : "—"
            }
          />
        </div>
        <SampleList
          label={tV("weight.samples")}
          entries={weightSamples}
          onChange={setWeightSamples}
          readOnly={isReadOnly}
          unit="mg"
          hint={tV("weight.samples_hint")}
          addLabel={tV("samples.add")}
          emptyLabel={tV("samples.empty")}
          sampleLabel={(n) => tV("samples.nth", { n })}
          removeLabel={tV("samples.remove")}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label={tV("weight.n")} value={String(liveStats.weight.samples.length)} />
          <StatCard
            label={tV("weight.mean")}
            value={liveStats.weight.mean != null ? `${formatNumber(liveStats.weight.mean, 2)} mg` : "—"}
          />
          <StatCard
            label={tV("weight.stdev")}
            value={liveStats.weight.stdev != null ? `${formatNumber(liveStats.weight.stdev, 2)} mg` : "—"}
          />
          <StatCard
            label={tV("weight.out_of_range")}
            value={String(
              liveStats.weight.per_sample_passed.filter((p) => !p).length,
            )}
          />
        </div>
        <TextAreaField
          label={tV("notes")}
          value={weightNotes}
          onChange={setWeightNotes}
          readOnly={isReadOnly}
        />
      </TestSection>

      {/* Disintegration test */}
      <TestSection
        title={tV("disintegration.title")}
        passed={liveStats.disintegration.passed}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <TextField
            label={tV("disintegration.limit")}
            value={disintegrationLimit}
            onChange={setDisintegrationLimit}
            placeholder="60"
            readOnly={isReadOnly}
            suffix={tV("disintegration.minutes")}
          />
          <TextField
            label={tV("disintegration.temperature")}
            value={disintegrationTemp}
            onChange={setDisintegrationTemp}
            placeholder="37"
            readOnly={isReadOnly}
            suffix="°C"
          />
          <ReadOnlyField
            label={tV("disintegration.worst")}
            value={
              liveStats.disintegration.worst_minutes != null
                ? `${formatNumber(liveStats.disintegration.worst_minutes, 1)} ${tV("disintegration.minutes")}`
                : "—"
            }
          />
        </div>
        <SampleList
          label={tV("disintegration.samples")}
          entries={disintegrationSamples}
          onChange={setDisintegrationSamples}
          readOnly={isReadOnly}
          unit={tV("disintegration.minutes")}
          hint={tV("disintegration.samples_hint")}
          addLabel={tV("samples.add")}
          emptyLabel={tV("samples.empty")}
          sampleLabel={(n) => tV("samples.nth", { n })}
          removeLabel={tV("samples.remove")}
        />
        <TextAreaField
          label={tV("notes")}
          value={disintegrationNotes}
          onChange={setDisintegrationNotes}
          readOnly={isReadOnly}
        />
      </TestSection>

      {/* Organoleptic test */}
      <TestSection
        title={tV("organoleptic.title")}
        passed={liveStats.organoleptic.passed}
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {tV("organoleptic.target")}
            </p>
            <TextField
              label={tV("organoleptic.colour")}
              value={orgTargetColour}
              onChange={setOrgTargetColour}
              readOnly={isReadOnly}
            />
            <TextField
              label={tV("organoleptic.taste")}
              value={orgTargetTaste}
              onChange={setOrgTargetTaste}
              readOnly={isReadOnly}
            />
            <TextField
              label={tV("organoleptic.odour")}
              value={orgTargetOdour}
              onChange={setOrgTargetOdour}
              readOnly={isReadOnly}
            />
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {tV("organoleptic.actual")}
            </p>
            <TextField
              label={tV("organoleptic.colour")}
              value={orgActualColour}
              onChange={setOrgActualColour}
              readOnly={isReadOnly}
            />
            <TextField
              label={tV("organoleptic.taste")}
              value={orgActualTaste}
              onChange={setOrgActualTaste}
              readOnly={isReadOnly}
            />
            <TextField
              label={tV("organoleptic.odour")}
              value={orgActualOdour}
              onChange={setOrgActualOdour}
              readOnly={isReadOnly}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tV("organoleptic.judgement")}
          </span>
          <TriStateToggle
            value={orgPassed}
            onChange={setOrgPassed}
            trueLabel={tV("pass")}
            falseLabel={tV("fail")}
            nullLabel={tV("pending")}
            disabled={isReadOnly}
          />
        </div>
        <TextAreaField
          label={tV("notes")}
          value={orgNotes}
          onChange={setOrgNotes}
          readOnly={isReadOnly}
        />
      </TestSection>

      {/* Overall notes */}
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <h2 className="text-sm font-medium text-ink-700">
          {tV("overall_notes")}
        </h2>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          readOnly={isReadOnly}
          className="mt-3 w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
      </section>

      {canWrite ? (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-end gap-3 rounded-2xl bg-ink-0 px-4 py-3 shadow-md ring-1 ring-ink-200">
          {isDirty ? (
            <span className="mr-auto text-xs font-medium text-amber-700">
              {tV("unsaved_changes")}
            </span>
          ) : (
            <span className="mr-auto text-xs text-ink-500">
              {tV("all_saved")}
            </span>
          )}
          <Button
            type="button"
            variant="primary"
            size="md"
            className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:bg-ink-200 disabled:text-ink-500"
            isDisabled={isBusy || !isDirty}
            onClick={handleSave}
          >
            {tV("save")}
          </Button>
        </div>
      ) : null}
      </>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Targets wizard — draft-mode-only
// ---------------------------------------------------------------------------

interface TargetsWizardPanelProps {
  weightTarget: string;
  weightTolerance: string;
  onWeightTargetChange: (v: string) => void;
  onWeightToleranceChange: (v: string) => void;
  disintegrationLimit: string;
  disintegrationTemp: string;
  onDisintegrationLimitChange: (v: string) => void;
  onDisintegrationTempChange: (v: string) => void;
  orgTargetColour: string;
  orgTargetTaste: string;
  orgTargetOdour: string;
  onOrgTargetColourChange: (v: string) => void;
  onOrgTargetTasteChange: (v: string) => void;
  onOrgTargetOdourChange: (v: string) => void;
  missingFields: readonly string[];
  isBusy: boolean;
  onStartValidation: () => Promise<void> | void;
}

/**
 * Three-step wizard rendered while the validation is in ``draft`` and
 * the operator can edit. Walks the scientist through defining the
 * pass/fail criteria (weight target/tolerance, disintegration limit/
 * temperature, organoleptic descriptors) before any samples are
 * recorded. The final step's "Start validation" fires the
 * draft → in_progress transition, which prompts for the scientist's
 * signature and syncs the state to PSP.
 *
 * The BE (`transition_status`) enforces the same missing-targets
 * gate so a bug in the wizard can't ship a half-defined validation
 * into `in_progress`.
 */
function TargetsWizardPanel(props: TargetsWizardPanelProps) {
  const tV = useTranslations("product_validation");
  const [step, setStep] = useState(0);

  const stepDefs = [
    {
      key: "weight" as const,
      title: tV("weight.title"),
      fields: ["weight.target_mg", "weight.tolerance_pct"] as const,
    },
    {
      key: "disintegration" as const,
      title: tV("disintegration.title"),
      fields: [
        "disintegration.limit_minutes",
        "disintegration.temperature_c",
      ] as const,
    },
    {
      key: "organoleptic" as const,
      title: tV("organoleptic.title"),
      fields: [
        "organoleptic.target.colour",
        "organoleptic.target.taste",
        "organoleptic.target.odour",
      ] as const,
    },
  ];

  const currentStep = stepDefs[step] ?? stepDefs[0]!;
  const isLastStep = step === stepDefs.length - 1;
  const missingSet = new Set(props.missingFields);
  const stepIsIncomplete = currentStep.fields.some((f) => missingSet.has(f));
  const allTargetsFilled = props.missingFields.length === 0;

  const handleNext = () => {
    if (isLastStep) return;
    setStep((s) => Math.min(s + 1, stepDefs.length - 1));
  };
  const handleBack = () => setStep((s) => Math.max(s - 1, 0));

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      {/* Step tracker */}
      <ol className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-500">
        {stepDefs.map((def, i) => {
          const isCurrent = i === step;
          const isDone = i < step;
          const stepMissing = def.fields.some((f) => missingSet.has(f));
          return (
            <li key={def.key} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(i)}
                className={
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 " +
                  (isCurrent
                    ? "bg-orange-500 text-ink-0"
                    : isDone
                      ? "bg-ink-100 text-ink-800"
                      : "bg-ink-50 text-ink-500 hover:bg-ink-100")
                }
              >
                <span
                  className={
                    "grid h-4 w-4 place-items-center rounded-full text-[10px] font-semibold " +
                    (isCurrent
                      ? "bg-ink-0/20 text-ink-0"
                      : "bg-ink-0 text-ink-800 ring-1 ring-ink-200")
                  }
                >
                  {i + 1}
                </span>
                <span>{def.title}</span>
                {!stepMissing && !isCurrent ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                ) : null}
              </button>
              {i < stepDefs.length - 1 ? (
                <span aria-hidden className="h-px w-6 bg-ink-200" />
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* Step header */}
      <div className="mt-6 border-b border-ink-100 pb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tV("wizard.step_label", { current: step + 1, total: stepDefs.length })}
        </p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink-1000">
          {tV("wizard.set_targets_for", { section: currentStep.title })}
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          {tV("wizard.targets_help")}
        </p>
      </div>

      {/* Step content */}
      <div className="mt-5">
        {currentStep.key === "weight" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label={tV("weight.target")}
              value={props.weightTarget}
              onChange={props.onWeightTargetChange}
              placeholder="1270"
              suffix="mg"
            />
            <TextField
              label={tV("weight.tolerance")}
              value={props.weightTolerance}
              onChange={props.onWeightToleranceChange}
              placeholder="10"
              suffix="%"
            />
          </div>
        ) : null}

        {currentStep.key === "disintegration" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <TextField
              label={tV("disintegration.limit")}
              value={props.disintegrationLimit}
              onChange={props.onDisintegrationLimitChange}
              placeholder="60"
              suffix={tV("disintegration.minutes")}
            />
            <TextField
              label={tV("disintegration.temperature")}
              value={props.disintegrationTemp}
              onChange={props.onDisintegrationTempChange}
              placeholder="37"
              suffix="°C"
            />
          </div>
        ) : null}

        {currentStep.key === "organoleptic" ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <TextField
              label={tV("organoleptic.colour")}
              value={props.orgTargetColour}
              onChange={props.onOrgTargetColourChange}
              placeholder={tV("organoleptic.colour_placeholder")}
            />
            <TextField
              label={tV("organoleptic.taste")}
              value={props.orgTargetTaste}
              onChange={props.onOrgTargetTasteChange}
              placeholder={tV("organoleptic.taste_placeholder")}
            />
            <TextField
              label={tV("organoleptic.odour")}
              value={props.orgTargetOdour}
              onChange={props.onOrgTargetOdourChange}
              placeholder={tV("organoleptic.odour_placeholder")}
            />
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          isDisabled={step === 0 || props.isBusy}
          onClick={handleBack}
        >
          {tV("wizard.back")}
        </Button>

        {!isLastStep ? (
          <Button
            type="button"
            variant="primary"
            size="md"
            className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
            isDisabled={props.isBusy || stepIsIncomplete}
            onClick={handleNext}
          >
            {tV("wizard.next")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            size="md"
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:bg-ink-200 disabled:text-ink-500"
            isDisabled={props.isBusy || !allTargetsFilled}
            onClick={() => {
              void props.onStartValidation();
            }}
          >
            <PlayCircle className="h-4 w-4" />
            {tV("wizard.start_validation")}
          </Button>
        )}
      </div>

      {!allTargetsFilled ? (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{tV("wizard.missing_targets_hint")}</span>
        </p>
      ) : null}
    </section>
  );
}

/**
 * Compare the local draft state to the server snapshot. Returns true
 * when any field differs — used to toggle the Save button. Uses the
 * same normalisation as the save payload so a "1270" typed by the
 * scientist matches ``target_mg: 1270`` from the server (not "1270" vs
 * "1270.0" spurious).
 */
function draftDiffersFromServer(input: {
  server: ProductValidationDto;
  weightTarget: string;
  weightTolerance: string;
  weightSamples: readonly SampleEntry[];
  weightNotes: string;
  disintegrationLimit: string;
  disintegrationTemp: string;
  disintegrationSamples: readonly SampleEntry[];
  disintegrationNotes: string;
  orgTargetColour: string;
  orgTargetTaste: string;
  orgTargetOdour: string;
  orgActualColour: string;
  orgActualTaste: string;
  orgActualOdour: string;
  orgPassed: boolean | null;
  orgNotes: string;
  notes: string;
}): boolean {
  const numberOrNull = (raw: string): number | null => {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  };
  const numberOrZero = (raw: string): number => numberOrNull(raw) ?? 0;
  const sameSamples = (
    entries: readonly SampleEntry[],
    server: readonly number[],
  ): boolean => {
    const local = entries
      .map((e) => numberOrNull(e.raw))
      .filter((n): n is number => n != null);
    if (local.length !== server.length) return false;
    for (let i = 0; i < local.length; i++) {
      if (local[i] !== server[i]) return false;
    }
    return true;
  };

  const s = input.server;

  if (numberOrNull(input.weightTarget) !== s.weight_test.target_mg) return true;
  if (numberOrZero(input.weightTolerance) !== s.weight_test.tolerance_pct)
    return true;
  if (!sameSamples(input.weightSamples, s.weight_test.samples)) return true;
  if ((input.weightNotes ?? "") !== (s.weight_test.notes ?? "")) return true;

  if (numberOrNull(input.disintegrationLimit) !== s.disintegration_test.limit_minutes)
    return true;
  if (numberOrNull(input.disintegrationTemp) !== s.disintegration_test.temperature_c)
    return true;
  if (!sameSamples(input.disintegrationSamples, s.disintegration_test.samples))
    return true;
  if ((input.disintegrationNotes ?? "") !== (s.disintegration_test.notes ?? ""))
    return true;

  const org = s.organoleptic_test;
  if ((input.orgTargetColour ?? "") !== (org.target.colour ?? "")) return true;
  if ((input.orgTargetTaste ?? "") !== (org.target.taste ?? "")) return true;
  if ((input.orgTargetOdour ?? "") !== (org.target.odour ?? "")) return true;
  if ((input.orgActualColour ?? "") !== (org.actual.colour ?? "")) return true;
  if ((input.orgActualTaste ?? "") !== (org.actual.taste ?? "")) return true;
  if ((input.orgActualOdour ?? "") !== (org.actual.odour ?? "")) return true;
  if (input.orgPassed !== org.passed) return true;
  if ((input.orgNotes ?? "") !== (org.notes ?? "")) return true;

  if ((input.notes ?? "") !== (s.notes ?? "")) return true;

  return false;
}


/**
 * Live client-side recompute of the ValidationStats payload from the
 * current draft state — mean/std-dev/allowed-range/per-sample-passed
 * etc. update the moment the scientist types a sample instead of
 * only after Save. Mirrors the compute logic in
 * ``apps/product_validation/services.py`` so the two views agree.
 *
 * When a field is unparseable in the local draft (e.g. mid-typing),
 * we fall back to the last-known server value so the UI doesn't
 * flash to "—".
 */
function computeLiveStats(input: {
  server: ValidationStatsDto;
  weightTarget: string;
  weightTolerance: string;
  weightSamples: readonly SampleEntry[];
  disintegrationLimit: string;
  disintegrationSamples: readonly SampleEntry[];
  orgTargetColour: string;
  orgTargetTaste: string;
  orgTargetOdour: string;
  orgActualColour: string;
  orgActualTaste: string;
  orgActualOdour: string;
  orgPassed: boolean | null;
}): ValidationStatsDto {
  const parseNum = (raw: string): number | null => {
    if (raw == null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const samplesFromEntries = (entries: readonly SampleEntry[]): number[] =>
    entries
      .map((e) => parseNum(e.raw))
      .filter((n): n is number => n != null);

  const weightSamplesNum = samplesFromEntries(input.weightSamples);
  const target = parseNum(input.weightTarget);
  const tol = parseNum(input.weightTolerance);
  const min =
    target != null && tol != null ? target * (1 - tol / 100) : null;
  const max =
    target != null && tol != null ? target * (1 + tol / 100) : null;
  const perSamplePassed =
    min != null && max != null
      ? weightSamplesNum.map((s) => s >= min && s <= max)
      : weightSamplesNum.map(() => true);
  const mean =
    weightSamplesNum.length > 0
      ? weightSamplesNum.reduce((a, b) => a + b, 0) / weightSamplesNum.length
      : null;
  const stdev =
    weightSamplesNum.length >= 2 && mean != null
      ? Math.sqrt(
          weightSamplesNum.reduce((a, b) => a + (b - mean) ** 2, 0) /
            (weightSamplesNum.length - 1),
        )
      : weightSamplesNum.length === 1
        ? 0
        : null;
  const weightPassed: boolean | null =
    weightSamplesNum.length === 0 || min == null || max == null
      ? null
      : perSamplePassed.every((p) => p);

  // Disintegration passes when every sample is <= limit. Worst =
  // slowest sample (highest minutes).
  const disintegrationSamplesNum = samplesFromEntries(
    input.disintegrationSamples,
  );
  const limit = parseNum(input.disintegrationLimit);
  const disPerSamplePassed =
    limit != null
      ? disintegrationSamplesNum.map((s) => s <= limit)
      : disintegrationSamplesNum.map(() => true);
  const worst =
    disintegrationSamplesNum.length > 0
      ? Math.max(...disintegrationSamplesNum)
      : null;
  const disPassed: boolean | null =
    disintegrationSamplesNum.length === 0 || limit == null
      ? null
      : disPerSamplePassed.every((p) => p);

  // Organoleptic passes when scientist explicitly toggles pass AND
  // all three actual descriptors are filled.
  const orgActualFilled =
    input.orgActualColour.trim() !== "" &&
    input.orgActualTaste.trim() !== "" &&
    input.orgActualOdour.trim() !== "";
  const orgPassed: boolean | null =
    input.orgPassed == null
      ? null
      : input.orgPassed === true
        ? orgActualFilled
        : false;

  // Overall — matches BE fold: any section explicitly false ⇒ false;
  // all sections explicitly true ⇒ true; otherwise null (in progress).
  const outcomes = [weightPassed, disPassed, orgPassed];
  const resolved = outcomes.filter((o): o is boolean => o != null);
  const overallPassed: boolean | null =
    resolved.length === 0
      ? null
      : resolved.some((o) => o === false)
        ? false
        : resolved.every((o) => o === true)
          ? true
          : null;

  return {
    ...input.server,
    weight: {
      ...input.server.weight,
      target_mg: target,
      tolerance_pct: tol ?? input.server.weight.tolerance_pct,
      min_allowed_mg: min,
      max_allowed_mg: max,
      samples: weightSamplesNum,
      per_sample_passed: perSamplePassed,
      mean,
      stdev,
      passed: weightPassed,
    },
    disintegration: {
      ...input.server.disintegration,
      limit_minutes: limit,
      samples: disintegrationSamplesNum,
      per_sample_passed: disPerSamplePassed,
      worst_minutes: worst,
      passed: disPassed,
    },
    organoleptic: {
      ...input.server.organoleptic,
      target: {
        colour: input.orgTargetColour,
        taste: input.orgTargetTaste,
        odour: input.orgTargetOdour,
      },
      actual: {
        colour: input.orgActualColour,
        taste: input.orgActualTaste,
        odour: input.orgActualOdour,
      },
      passed: orgPassed,
    },
    overall_passed: overallPassed,
  };
}


/**
 * Client-side mirror of the BE `_missing_sample_fields` gate. Returns
 * dot-paths of sample/actual fields still blank so the "Advance to
 * passed" transition button can be disabled with a hint.
 *
 * The BE deliberately does NOT apply this to `failed` — bad early
 * data doesn't force you to record every downstream sample first.
 */
function collectMissingSamples(input: {
  weightSamples: readonly SampleEntry[];
  disintegrationSamples: readonly SampleEntry[];
  orgActualColour: string;
  orgActualTaste: string;
  orgActualOdour: string;
  orgPassed: boolean | null;
}): string[] {
  const missing: string[] = [];
  const stringBlank = (v: string) => v == null || v.trim() === "";
  const hasSample = (entries: readonly SampleEntry[]) =>
    entries.some((e) => e.raw.trim() !== "" && !Number.isNaN(Number(e.raw)));

  if (!hasSample(input.weightSamples)) missing.push("weight.samples");
  if (!hasSample(input.disintegrationSamples))
    missing.push("disintegration.samples");
  if (stringBlank(input.orgActualColour))
    missing.push("organoleptic.actual.colour");
  if (stringBlank(input.orgActualTaste))
    missing.push("organoleptic.actual.taste");
  if (stringBlank(input.orgActualOdour))
    missing.push("organoleptic.actual.odour");
  if (input.orgPassed === null) missing.push("organoleptic.passed");

  return missing;
}


/**
 * Client-side mirror of the BE `_missing_target_fields` gate. Returns
 * dot-paths of target fields still blank so the wizard can dim the
 * "Start validation" button + highlight the offending step.
 */
function collectMissingTargets(input: {
  weightTarget: string;
  weightTolerance: string;
  disintegrationLimit: string;
  disintegrationTemp: string;
  orgTargetColour: string;
  orgTargetTaste: string;
  orgTargetOdour: string;
}): string[] {
  const missing: string[] = [];
  const numericBlank = (v: string) =>
    v == null || v.trim() === "" || Number.isNaN(Number(v));
  const stringBlank = (v: string) => v == null || v.trim() === "";

  if (numericBlank(input.weightTarget)) missing.push("weight.target_mg");
  if (numericBlank(input.weightTolerance)) missing.push("weight.tolerance_pct");
  if (numericBlank(input.disintegrationLimit))
    missing.push("disintegration.limit_minutes");
  if (numericBlank(input.disintegrationTemp))
    missing.push("disintegration.temperature_c");
  if (stringBlank(input.orgTargetColour))
    missing.push("organoleptic.target.colour");
  if (stringBlank(input.orgTargetTaste))
    missing.push("organoleptic.target.taste");
  if (stringBlank(input.orgTargetOdour))
    missing.push("organoleptic.target.odour");

  return missing;
}


// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------


function TestSection({
  title,
  passed,
  children,
}: {
  title: string;
  passed: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center justify-between gap-3 border-b border-ink-100 pb-3">
        <h2 className="text-base font-semibold text-ink-1000">{title}</h2>
        <PassFailChip passed={passed} />
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}


function PassFailChip({ passed }: { passed: boolean | null }) {
  const chip = (
    classes: string,
    icon: ReactNode,
    label: string,
  ) => (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {icon}
      {label}
    </span>
  );
  if (passed === true) {
    return chip(
      "bg-success/10 text-success ring-success/20",
      <CheckCircle2 className="h-3 w-3" />,
      "Pass",
    );
  }
  if (passed === false) {
    return chip(
      "bg-danger/10 text-danger ring-danger/20",
      <AlertTriangle className="h-3 w-3" />,
      "Fail",
    );
  }
  return chip(
    "bg-ink-100 text-ink-700 ring-ink-200",
    null,
    "Pending",
  );
}


function StatusChip({
  status,
  overall,
  tV,
}: {
  status: string;
  overall: boolean | null;
  tV: ReturnType<typeof useTranslations<"product_validation">>;
}) {
  const isPass = status === "passed" || overall === true;
  const isFail = status === "failed" || overall === false;
  const classes = isPass
    ? "bg-success/10 text-success ring-success/20"
    : isFail
      ? "bg-danger/10 text-danger ring-danger/20"
      : status === "in_progress"
        ? "bg-orange-50 text-orange-700 ring-orange-200"
        : "bg-ink-100 text-ink-700 ring-ink-200";
  const icon = isPass ? (
    <CheckCircle2 className="h-3.5 w-3.5" />
  ) : isFail ? (
    <AlertTriangle className="h-3.5 w-3.5" />
  ) : status === "in_progress" ? (
    <PlayCircle className="h-3.5 w-3.5" />
  ) : null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {icon}
      {tV(`status.${status}` as "status.draft")}
    </span>
  );
}


function SignatureCard({
  role,
  actor,
  signedAt,
  imageDataUrl,
  emptyLabel,
}: {
  role: string;
  actor: { readonly name: string; readonly email: string } | null;
  signedAt: string | null;
  imageDataUrl: string;
  emptyLabel: string;
}) {
  const signed = actor && signedAt;
  return (
    <div className="rounded-xl bg-ink-0 p-4 shadow-sm ring-1 ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {role}
      </p>
      {signed ? (
        <>
          {imageDataUrl ? (
            <div className="mt-2 rounded-lg bg-ink-50 p-2">
              <img
                src={imageDataUrl}
                alt={`${role} signature`}
                className="max-h-20 w-full object-contain"
              />
            </div>
          ) : null}
          <p className="mt-2 text-sm font-medium text-ink-1000">
            {actor.name || actor.email}
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            {formatTimestamp(signedAt)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-500">{emptyLabel}</p>
      )}
    </div>
  );
}


function TextField({
  label,
  value,
  onChange,
  placeholder,
  readOnly,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  suffix?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-700">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 read-only:bg-ink-50 read-only:text-ink-500"
      />
    </label>
  );
}


function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      <span className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700 ring-1 ring-inset ring-ink-200">
        {value}
      </span>
    </div>
  );
}


function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  readOnly,
  hint,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        rows={3}
        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 read-only:bg-ink-50 read-only:text-ink-500"
      />
      {hint ? (
        <span className="text-xs text-ink-500">{hint}</span>
      ) : null}
    </label>
  );
}


function SampleList({
  label,
  entries,
  onChange,
  readOnly,
  unit,
  hint,
  addLabel,
  emptyLabel,
  sampleLabel,
  removeLabel,
}: {
  label: string;
  entries: readonly SampleEntry[];
  onChange: (next: SampleEntry[]) => void;
  readOnly?: boolean;
  unit?: string;
  hint?: string;
  addLabel: string;
  emptyLabel: string;
  sampleLabel: (n: number) => string;
  removeLabel: string;
}) {
  // Autofocus the input of a newly-added row so the scientist can
  // start typing immediately. Pattern: stash the id we want to
  // focus and each input checks it against its own id on mount.
  const focusTargetRef = useRef<string | null>(null);

  const addEntry = useCallback(() => {
    const id = clientUuid();
    focusTargetRef.current = id;
    onChange([...entries, { id, raw: "" }]);
  }, [entries, onChange]);

  const updateEntry = useCallback(
    (id: string, raw: string) => {
      onChange(
        entries.map((entry) =>
          entry.id === id ? { ...entry, raw } : entry,
        ),
      );
    },
    [entries, onChange],
  );

  const removeEntry = useCallback(
    (id: string) => {
      onChange(entries.filter((entry) => entry.id !== id));
    },
    [entries, onChange],
  );

  const onEntryKeyDown = (
    e: KeyboardEvent<HTMLInputElement>,
    entry: SampleEntry,
    index: number,
  ) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (index === entries.length - 1) {
        addEntry();
      }
    } else if (
      e.key === "Backspace" &&
      entry.raw === "" &&
      entries.length > 1
    ) {
      e.preventDefault();
      removeEntry(entry.id);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-xs font-medium text-ink-700">
          {label}
          {unit ? (
            <span className="rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-700">
              {unit}
            </span>
          ) : null}
          <span className="text-ink-500">· {entries.length}</span>
        </span>
        {!readOnly ? (
          <button
            type="button"
            onClick={addEntry}
            className="inline-flex items-center gap-1 rounded-lg bg-orange-50 px-2.5 py-1 text-xs font-medium text-orange-800 ring-1 ring-inset ring-orange-200 hover:bg-orange-100"
          >
            <Plus className="h-3.5 w-3.5" />
            {addLabel}
          </button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="rounded-lg bg-ink-50 px-3 py-6 text-center text-xs text-ink-500 ring-1 ring-inset ring-ink-200">
          {emptyLabel}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
          {entries.map((entry, index) => (
            <SampleInput
              key={entry.id}
              entry={entry}
              index={index}
              unit={unit}
              readOnly={readOnly}
              sampleLabel={sampleLabel}
              removeLabel={removeLabel}
              shouldFocus={focusTargetRef.current === entry.id}
              onChange={(raw) => updateEntry(entry.id, raw)}
              onRemove={() => removeEntry(entry.id)}
              onKeyDown={(e) => onEntryKeyDown(e, entry, index)}
              onFocused={() => {
                if (focusTargetRef.current === entry.id) {
                  focusTargetRef.current = null;
                }
              }}
            />
          ))}
        </div>
      )}
      {hint ? <span className="text-xs text-ink-500">{hint}</span> : null}
    </div>
  );
}


function SampleInput({
  entry,
  index,
  unit,
  readOnly,
  sampleLabel,
  removeLabel,
  shouldFocus,
  onChange,
  onRemove,
  onKeyDown,
  onFocused,
}: {
  entry: SampleEntry;
  index: number;
  unit?: string;
  readOnly?: boolean;
  sampleLabel: (n: number) => string;
  removeLabel: string;
  shouldFocus: boolean;
  onChange: (raw: string) => void;
  onRemove: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onFocused: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);

  // ``shouldFocus`` is set by the parent immediately before adding
  // a row. Focusing here (after the new element is mounted) gives
  // the user a live cursor without an awkward extra click.
  const setRef = (el: HTMLInputElement | null) => {
    ref.current = el;
    if (el && shouldFocus) {
      el.focus();
      onFocused();
    }
  };

  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-ink-0 p-2 ring-1 ring-inset ring-ink-200">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
          {sampleLabel(index + 1)}
        </span>
        {!readOnly ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={removeLabel}
            title={removeLabel}
            className="rounded p-0.5 text-ink-400 hover:bg-danger/10 hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex items-baseline gap-1.5">
        <input
          ref={setRef}
          type="text"
          inputMode="decimal"
          value={entry.raw}
          readOnly={readOnly}
          placeholder="0"
          onChange={(e) => onChange(sanitizeSampleInput(e.target.value))}
          onKeyDown={onKeyDown}
          className="w-full rounded bg-transparent px-1 py-0.5 text-right text-base tabular-nums text-ink-1000 outline-none placeholder:text-ink-300 focus:ring-1 focus:ring-orange-400 read-only:text-ink-500"
        />
        {unit ? (
          <span className="shrink-0 text-xs font-semibold text-ink-500">
            {unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}


function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </p>
      <p className="mt-0.5 text-base font-semibold text-ink-1000 tabular-nums">
        {value}
      </p>
    </div>
  );
}


function TriStateToggle({
  value,
  onChange,
  trueLabel,
  falseLabel,
  nullLabel,
  disabled,
}: {
  value: boolean | null;
  onChange: (next: boolean | null) => void;
  trueLabel: string;
  falseLabel: string;
  nullLabel: string;
  disabled?: boolean;
}) {
  const Btn = ({
    active,
    activeClasses,
    label,
    onClick,
  }: {
    active: boolean;
    activeClasses: string;
    label: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
        active
          ? activeClasses
          : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
      } disabled:opacity-50`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1.5">
      <Btn
        active={value === true}
        activeClasses="bg-success/10 text-success ring-success/20"
        label={trueLabel}
        onClick={() => onChange(true)}
      />
      <Btn
        active={value === false}
        activeClasses="bg-danger/10 text-danger ring-danger/20"
        label={falseLabel}
        onClick={() => onChange(false)}
      />
      <Btn
        active={value == null}
        activeClasses="bg-ink-100 text-ink-700 ring-ink-200"
        label={nullLabel}
        onClick={() => onChange(null)}
      />
    </div>
  );
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * One editable sample measurement.
 *
 * Stored as a stable ``id`` plus the raw string the scientist
 * typed so React never re-renders the input out from under a
 * half-finished number (e.g. ``12.`` while they're about to add
 * more decimals). The id is generated client-side; it never
 * leaves the browser.
 */
interface SampleEntry {
  readonly id: string;
  readonly raw: string;
}


function samplesToEntries(samples: readonly number[] | null): SampleEntry[] {
  if (!samples || samples.length === 0) return [];
  return samples.map((value) => ({
    id: clientUuid(),
    raw: String(value),
  }));
}


function entriesToSamples(entries: readonly SampleEntry[]): number[] {
  return entries
    .map((entry) => Number.parseFloat(entry.raw))
    .filter((num) => Number.isFinite(num));
}


/**
 * Normalise a user-typed decimal so European commas degrade to
 * dots, stray characters are stripped, and at most one decimal
 * point survives with up to four fractional digits. The extra
 * precision headroom beyond the label-claim input's two-decimal
 * cap matches how lab scales report individual weighings.
 */
function sanitizeSampleInput(raw: string): string {
  let value = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value =
      value.slice(0, firstDot + 1) +
      value.slice(firstDot + 1).replace(/\./g, "");
  }
  const dot = value.indexOf(".");
  if (dot !== -1 && value.length - dot - 1 > 4) {
    value = value.slice(0, dot + 5);
  }
  return value;
}


function parseNumberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}


function parseNumberOrZero(raw: string): number {
  return parseNumberOrNull(raw) ?? 0;
}


function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return String(value);
  const fixed = value.toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  // No thousands separator — "." is the decimal mark; adding "," as
  // grouping made "1,143" look like a decimal in a "," decimal locale.
  if (!fraction) return whole!;
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole!;
}


// Deterministic UTC timestamp — mirrors the formatter used on the
// spec sheet so SSR/client hydration cannot drift on locale defaults.
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hour}:${minute} UTC`;
}
