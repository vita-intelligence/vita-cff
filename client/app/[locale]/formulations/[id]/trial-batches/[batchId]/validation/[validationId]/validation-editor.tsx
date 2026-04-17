"use client";

import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useState } from "react";

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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight uppercase md:text-3xl">
            {tV("title")}
          </h1>
          <p className="mt-1 font-mono text-xs text-ink-600">
            {validation.formulation_name} · v
            {validation.formulation_version_number} ·{" "}
            {validation.batch_label || tV("untitled_batch")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={validation.status} overall={stats.overall_passed} />
          <Link
            href={`/formulations/${formulationId}/trial-batches/${batchId}`}
            className="inline-flex items-center justify-center rounded-none border-2 border-ink-1000 bg-ink-0 px-3 py-1 text-xs font-bold tracking-wider uppercase text-ink-1000 transition-colors hover:bg-ink-100"
          >
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
              className="rounded-none border-2 font-bold tracking-wider uppercase"
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
          className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
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
            <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
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
            <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
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
          <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
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
        <div className="flex flex-col gap-2 font-mono text-xs text-ink-1000">
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
      <section className="border-2 border-ink-1000 bg-ink-0 p-6">
        <p className="border-b-2 border-ink-1000 pb-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {tV("overall_notes")}
        </p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          readOnly={isReadOnly}
          className="mt-3 w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
        />
      </section>

      {canWrite ? (
        <div className="sticky bottom-4 flex flex-wrap items-center justify-end gap-3 border-2 border-ink-1000 bg-ink-0 px-4 py-3 shadow-hard">
          <Button
            type="button"
            variant="primary"
            size="md"
            className="rounded-none font-bold tracking-wider uppercase"
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
    <section className="border-2 border-ink-1000 bg-ink-0 p-6">
      <div className="flex items-center justify-between border-b-2 border-ink-1000 pb-2">
        <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {title}
        </p>
        <PassFailChip passed={passed} />
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}


function PassFailChip({ passed }: { passed: boolean | null }) {
  if (passed === true) {
    return (
      <span className="border-2 border-ink-1000 bg-ink-1000 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-0">
        PASS
      </span>
    );
  }
  if (passed === false) {
    return (
      <span className="border-2 border-danger bg-danger px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-0">
        FAIL
      </span>
    );
  }
  return (
    <span className="border-2 border-ink-500 bg-ink-100 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase text-ink-500">
      PENDING
    </span>
  );
}


function StatusChip({
  status,
  overall,
}: {
  status: string;
  overall: boolean | null;
}) {
  const tone =
    status === "passed" || overall === true
      ? "border-ink-1000 bg-ink-1000 text-ink-0"
      : status === "failed" || overall === false
        ? "border-danger bg-danger text-ink-0"
        : "border-ink-500 bg-ink-100 text-ink-700";
  return (
    <span
      className={`inline-flex items-center border-2 px-3 py-1 font-mono text-[10px] tracking-widest uppercase ${tone}`}
    >
      {status}
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
    <div className="border-2 border-ink-500 bg-ink-100 p-4 font-mono text-xs text-ink-700">
      <p className="tracking-widest uppercase text-ink-500">{role}</p>
      {actor && signedAt ? (
        <>
          <p className="mt-2 text-sm font-bold text-ink-1000 normal-case">
            {actor.name || actor.email}
          </p>
          <p className="mt-1 text-[10px] tracking-widest uppercase text-ink-500">
            {formatTimestamp(signedAt)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[10px] tracking-widest uppercase text-ink-500">
          {emptyLabel}
        </p>
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
      <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard disabled:opacity-60"
      />
    </label>
  );
}


function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {label}
      </span>
      <span className="border-2 border-dashed border-ink-500 bg-ink-100 px-3 py-2 font-mono text-sm text-ink-1000">
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
      <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        rows={3}
        className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
      />
      {hint ? (
        <span className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
          {hint}
        </span>
      ) : null}
    </label>
  );
}


function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-ink-500 bg-ink-100 p-2 font-mono">
      <p className="text-[10px] tracking-widest uppercase text-ink-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-bold text-ink-1000">{value}</p>
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
        className="h-4 w-4 cursor-pointer accent-ink-1000 disabled:opacity-60"
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
    label,
    onClick,
  }: {
    active: boolean;
    label: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border-2 px-3 py-1 font-mono text-[10px] tracking-widest uppercase transition-colors ${
        active
          ? "border-ink-1000 bg-ink-1000 text-ink-0"
          : "border-ink-1000 bg-ink-0 text-ink-1000 hover:bg-ink-100"
      } disabled:opacity-50`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1">
      <Btn active={value === true} label={trueLabel} onClick={() => onChange(true)} />
      <Btn active={value === false} label={falseLabel} onClick={() => onChange(false)} />
      <Btn active={value == null} label={nullLabel} onClick={() => onChange(null)} />
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
