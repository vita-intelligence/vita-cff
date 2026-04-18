"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FlaskConical,
  PlayCircle,
  ShieldCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type {
  ProductValidationDto,
  ValidationStatus,
} from "@/services/product_validation";

import { NewValidationButton } from "./new-validation-button";


/**
 * Project-scoped QC validations list. One card per validation —
 * shows the batch it was run against, the current status + stamp
 * of any signers, and links to the full editor. The header hosts
 * the canonical "New validation" trigger so the creation flow
 * lives on the tab that owns the resource, not buried elsewhere.
 */
export function QCList({
  orgId,
  formulationId,
  validations,
}: {
  orgId: string;
  formulationId: string;
  validations: readonly ProductValidationDto[];
}) {
  const tV = useTranslations("product_validation");
  const tTabs = useTranslations("project_tabs");
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-1000">{tTabs("qc")}</h2>
          <p className="mt-1 text-sm text-ink-500">
            {tV("tab.subtitle", { count: validations.length })}
          </p>
        </div>
        <NewValidationButton
          orgId={orgId}
          formulationId={formulationId}
          validations={validations}
        />
      </div>

      {validations.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {validations.map((v) => (
            <QCCard key={v.id} validation={v} formulationId={formulationId} />
          ))}
        </ul>
      )}
    </section>
  );
}


function QCCard({
  validation,
  formulationId,
}: {
  validation: ProductValidationDto;
  formulationId: string;
}) {
  const tV = useTranslations("product_validation");
  return (
    <li>
      <Link
        href={`/formulations/${formulationId}/trial-batches/${validation.trial_batch_id}/validation/${validation.id}`}
        className="flex flex-col gap-3 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-400" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                v{validation.formulation_version_number}
              </p>
              <p className="text-sm font-medium text-ink-1000">
                {validation.batch_label || tV("untitled_batch")}
              </p>
            </div>
          </div>
          <StatusChip status={validation.status} tV={tV} />
        </div>
        <div className="flex items-center justify-between text-xs text-ink-500">
          <SignatureSummary validation={validation} tV={tV} />
          <ExternalLink className="h-3 w-3" />
        </div>
      </Link>
    </li>
  );
}


function SignatureSummary({
  validation,
  tV,
}: {
  validation: ProductValidationDto;
  tV: ReturnType<typeof useTranslations<"product_validation">>;
}) {
  if (!validation.scientist && !validation.rd_manager) {
    return <span>{tV("signature.pending")}</span>;
  }
  const bits: string[] = [];
  if (validation.scientist) bits.push(validation.scientist.name);
  if (validation.rd_manager)
    bits.push(`${tV("signature.rd_manager_prefix")}: ${validation.rd_manager.name}`);
  return <span>{bits.join(" · ")}</span>;
}


function StatusChip({
  status,
  tV,
}: {
  status: ValidationStatus;
  tV: ReturnType<typeof useTranslations<"product_validation">>;
}) {
  const label = tV(`status.${status}` as "status.draft");
  const map: Record<
    ValidationStatus,
    { classes: string; icon: React.ReactNode }
  > = {
    draft: {
      classes: "bg-ink-100 text-ink-700 ring-ink-200",
      icon: null,
    },
    in_progress: {
      classes: "bg-orange-50 text-orange-700 ring-orange-200",
      icon: <PlayCircle className="h-3 w-3" />,
    },
    passed: {
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3 w-3" />,
    },
    failed: {
      classes: "bg-danger/10 text-danger ring-danger/20",
      icon: <AlertTriangle className="h-3 w-3" />,
    },
  };
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.classes}`}
    >
      {s.icon}
      {label}
    </span>
  );
}


function EmptyState() {
  const tV = useTranslations("product_validation");
  return (
    <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
      <FlaskConical className="mx-auto h-8 w-8 text-ink-300" />
      <p className="mt-3 text-sm font-medium text-ink-1000">
        {tV("tab.empty")}
      </p>
      <p className="mt-1 text-xs text-ink-500">{tV("tab.empty_hint")}</p>
    </div>
  );
}
