"use client";

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  PlayCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
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
  // flow doesn't clobber the freshly-loaded values.
  const [weightSamples, setWeightSamples] = useState<string>(
    () => (validation.weight_test.samples ?? []).join(", "),
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
  const [disintegrationSamples, setDisintegrationSamples] = useState<string>(
    (validation.disintegration_test.samples ?? []).join(", "),
  );
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

  const [checklistRaw, setChecklistRaw] = useState(
    validation.mrpeasy_checklist.raw_materials_created,
  );
  const [checklistFinished, setChecklistFinished] = useState(
    validation.mrpeasy_checklist.finished_product_created,
  );
  const [checklistBoms, setChecklistBoms] = useState(
    validation.mrpeasy_checklist.boms_verified,
  );

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
          samples: parseSampleList(weightSamples),
          notes: weightNotes,
        },
        disintegration_test: {
          limit_minutes: parseNumberOrNull(disintegrationLimit),
          temperature_c: parseNumberOrNull(disintegrationTemp),
          samples: parseSampleList(disintegrationSamples),
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
        mrpeasy_checklist: {
          raw_materials_created: checklistRaw,
          finished_product_created: checklistFinished,
          boms_verified: checklistBoms,
        },
        notes,
      });
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const handleTransition = async (next: ValidationStatus) => {
    setError(null);
    try {
      await transitionMutation.mutateAsync({ status: next });
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const allowedNext = ALLOWED_VALIDATION_TRANSITIONS[validation.status] ?? [];

  return (
    <div className="mt-8 flex flex-col gap-6">
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
            overall={stats.overall_passed}
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

      {canWrite && allowedNext.length > 0 ? (
        <section className="flex flex-wrap items-center gap-2">
          {allowedNext.map((next) => (
            <Button
              key={next}
              type="button"
              variant="outline"
              size="sm"
              className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
              isDisabled={isBusy}
              onClick={() => handleTransition(next)}
            >
              {tV("advance_to")} {tV(`status.${next}` as "status.draft")}
            </Button>
          ))}
        </section>
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
          emptyLabel={tV("signature.pending")}
        />
        <SignatureCard
          role={tV("signature.rd_manager")}
          actor={validation.rd_manager}
          signedAt={validation.rd_manager_signed_at}
          emptyLabel={tV("signature.pending")}
        />
      </section>

      {/* Weight test */}
      <TestSection title={tV("weight.title")} passed={stats.weight.passed}>
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
              stats.weight.min_allowed_mg != null &&
              stats.weight.max_allowed_mg != null
                ? `${formatNumber(stats.weight.min_allowed_mg, 2)} – ${formatNumber(stats.weight.max_allowed_mg, 2)} mg`
                : "—"
            }
          />
        </div>
        <TextAreaField
          label={tV("weight.samples")}
          value={weightSamples}
          onChange={setWeightSamples}
          placeholder="1255, 1268, 1272, 1280, …"
          readOnly={isReadOnly}
          hint={tV("weight.samples_hint")}
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label={tV("weight.n")} value={String(stats.weight.samples.length)} />
          <StatCard
            label={tV("weight.mean")}
            value={stats.weight.mean != null ? `${formatNumber(stats.weight.mean, 2)} mg` : "—"}
          />
          <StatCard
            label={tV("weight.stdev")}
            value={stats.weight.stdev != null ? `${formatNumber(stats.weight.stdev, 2)} mg` : "—"}
          />
          <StatCard
            label={tV("weight.out_of_range")}
            value={String(
              stats.weight.per_sample_passed.filter((p) => !p).length,
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
        passed={stats.disintegration.passed}
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
              stats.disintegration.worst_minutes != null
                ? `${formatNumber(stats.disintegration.worst_minutes, 1)} ${tV("disintegration.minutes")}`
                : "—"
            }
          />
        </div>
        <TextAreaField
          label={tV("disintegration.samples")}
          value={disintegrationSamples}
          onChange={setDisintegrationSamples}
          placeholder="45, 52, 48, 55, 49, 51"
          readOnly={isReadOnly}
          hint={tV("disintegration.samples_hint")}
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
        passed={stats.organoleptic.passed}
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

      {/* MRPeasy checklist */}
      <TestSection
        title={tV("checklist.title")}
        passed={stats.checklist.passed}
      >
        <div className="flex flex-col gap-2 text-sm text-ink-1000">
          <CheckboxRow
            label={tV("checklist.raw_materials")}
            checked={checklistRaw}
            onChange={setChecklistRaw}
            disabled={isReadOnly}
          />
          <CheckboxRow
            label={tV("checklist.finished_product")}
            checked={checklistFinished}
            onChange={setChecklistFinished}
            disabled={isReadOnly}
          />
          <CheckboxRow
            label={tV("checklist.boms_verified")}
            checked={checklistBoms}
            onChange={setChecklistBoms}
            disabled={isReadOnly}
          />
        </div>
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
          <Button
            type="button"
            variant="primary"
            size="md"
            className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
            isDisabled={isBusy}
            onClick={handleSave}
          >
            {tV("save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
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
  emptyLabel,
}: {
  role: string;
  actor: { readonly name: string; readonly email: string } | null;
  signedAt: string | null;
  emptyLabel: string;
}) {
  return (
    <div className="rounded-xl bg-ink-0 p-4 shadow-sm ring-1 ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {role}
      </p>
      {actor && signedAt ? (
        <>
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


function CheckboxRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer rounded accent-orange-500 disabled:opacity-60"
      />
      <span>{label}</span>
    </label>
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


function parseSampleList(raw: string): number[] {
  return raw
    .split(/[,\n\s]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => Number.parseFloat(chunk))
    .filter((num) => Number.isFinite(num));
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
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
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


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
