"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  FileText,
  FlaskConical,
  Leaf,
  Package,
  PlayCircle,
  Plus,
  Save,
  Scale,
  Target,
} from "lucide-react";

import type { MockProjectOverview, ProjectStatus } from "./mock-project";


/**
 * Modern treatment — rounded cards, soft shadows, ink palette for
 * neutrals, semantic tones for status/compliance, orange for warm
 * "in motion" signals (Pilot status, primary CTAs). Every colour
 * comes from ``@/config/design``; no hard-coded Tailwind defaults.
 */
export function ProjectOverviewModern({
  project,
}: {
  project: MockProjectOverview;
}) {
  return (
    <article className="flex flex-col gap-6">
      {/* Header card */}
      <section className="rounded-2xl bg-ink-0 p-8 shadow-sm ring-1 ring-ink-200">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {project.code}
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink-1000">
              {project.name}
            </h1>
            <p className="mt-2 text-sm text-ink-600">{project.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
                <Package className="h-3 w-3" /> {project.dosage_form}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
                {project.size_label}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
                v{project.latest_version}
                {project.latest_version_label
                  ? ` · ${project.latest_version_label}`
                  : ""}
              </span>
            </div>
          </div>
          <ModernStatusPill status={project.project_status} />
        </div>

        <div className="mt-8 flex flex-wrap gap-2 border-t border-ink-100 pt-6">
          {/* Primary CTA uses the warm orange accent for clear
              "start here" emphasis. Secondary buttons stay neutral. */}
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-ink-0 shadow-sm transition-colors hover:bg-orange-600">
            <Save className="h-4 w-4" /> Save new version
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm ring-1 ring-ink-200 transition-colors hover:bg-ink-50">
            <FileText className="h-4 w-4" /> New spec sheet
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm ring-1 ring-ink-200 transition-colors hover:bg-ink-50">
            <FlaskConical className="h-4 w-4" /> Plan batch
          </button>
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-4 py-2 text-sm font-medium text-ink-700 shadow-sm ring-1 ring-ink-200 transition-colors hover:bg-ink-50">
            <PlayCircle className="h-4 w-4" /> Start validation
          </button>
        </div>
      </section>

      {/* KPI cards */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <ModernKpi
          icon={<FileText className="h-4 w-4 text-ink-400" />}
          label="Spec sheets"
          value={String(project.spec_sheets.total)}
          sub={`${project.spec_sheets.draft} draft · ${project.spec_sheets.approved} approved · ${project.spec_sheets.sent} sent`}
        />
        <ModernKpi
          icon={<FlaskConical className="h-4 w-4 text-ink-400" />}
          label="Trial batches"
          value={String(project.trial_batches.total)}
          sub={`${project.trial_batches.in_flight} in flight`}
          accent={project.trial_batches.in_flight > 0 ? "orange" : undefined}
        />
        <ModernKpi
          icon={<CheckCircle2 className="h-4 w-4 text-ink-400" />}
          label="QC validations"
          value={`${project.qc.passed}/${project.qc.total}`}
          sub={`${project.qc.passed} passed · ${project.qc.in_progress} in progress`}
        />
        <ModernKpi
          icon={
            project.allergens.count === 0 ? (
              <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-warning" />
            )
          }
          label="Allergens"
          value={
            project.allergens.count === 0
              ? "None"
              : String(project.allergens.count)
          }
          sub={
            project.allergens.count === 0
              ? "Clean"
              : project.allergens.sources.join(", ")
          }
          accent={project.allergens.count === 0 ? "success" : "warning"}
        />
      </section>

      {/* Formulation snapshot + Compliance */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          <div className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-1000">
              Formulation snapshot
            </h2>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <ModernRow
              label="Total active"
              value={`${project.totals.total_active_mg} mg`}
            />
            <ModernRow
              label="Fill weight"
              value={`${project.totals.total_weight_mg} mg`}
            />
            <ModernRow
              label="Filled capsule"
              value={`${project.totals.filled_total_mg} mg`}
            />
            <div className="flex items-center justify-between">
              <dt className="text-ink-500">Viability</dt>
              <dd>
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success ring-1 ring-inset ring-success/20">
                  <CheckCircle2 className="h-3 w-3" />
                  {project.totals.viability === "can_make"
                    ? "Can make"
                    : "Review"}
                </span>
              </dd>
            </div>
          </dl>
        </div>
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-ink-400" />
            <h2 className="text-sm font-semibold text-ink-1000">Compliance</h2>
          </div>
          <ul className="mt-4 flex flex-wrap gap-2">
            <ModernComplianceChip ok={project.compliance.vegan} label="Vegan" />
            <ModernComplianceChip
              ok={project.compliance.organic}
              label="Organic"
            />
            <ModernComplianceChip ok={project.compliance.halal} label="Halal" />
            <ModernComplianceChip
              ok={project.compliance.kosher}
              label="Kosher"
            />
          </ul>
          {project.allergens.count === 0 ? (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-success/10 p-3 text-xs text-success">
              <Leaf className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>No allergens detected.</span>
            </div>
          ) : (
            <div className="mt-4 flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                Contains {project.allergens.sources.join(", ")}. Renders bold
                on the spec sheet ingredient list.
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Activity */}
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-ink-400" />
          <h2 className="text-sm font-semibold text-ink-1000">
            Recent activity
          </h2>
        </div>
        <ul className="mt-4 space-y-3">
          {project.activity.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start justify-between gap-4 text-sm"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-ink-300" />
                <span className="text-ink-1000">{entry.text}</span>
              </div>
              <span className="flex-shrink-0 text-xs text-ink-500">
                {entry.actor} · {entry.ago}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}


/**
 * Status → palette mapping. Orange sits on "Pilot" deliberately —
 * it signals "in motion, about to launch" warmer than a blue info
 * pill and without the premature green of approved.
 */
function ModernStatusPill({ status }: { status: ProjectStatus }) {
  const styles: Record<
    ProjectStatus,
    { label: string; classes: string; icon: React.ReactNode }
  > = {
    concept: {
      label: "Concept",
      classes: "bg-ink-100 text-ink-700 ring-ink-200",
      icon: <Plus className="h-3.5 w-3.5" />,
    },
    in_development: {
      label: "In development",
      classes: "bg-info/10 text-info ring-info/20",
      icon: <FlaskConical className="h-3.5 w-3.5" />,
    },
    pilot: {
      label: "Pilot",
      classes: "bg-orange-50 text-orange-700 ring-orange-200",
      icon: <PlayCircle className="h-3.5 w-3.5" />,
    },
    approved: {
      label: "Approved",
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    discontinued: {
      label: "Discontinued",
      classes: "bg-danger/10 text-danger ring-danger/20",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
  };
  const s = styles[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${s.classes}`}
    >
      {s.icon}
      {s.label}
    </span>
  );
}


function ModernKpi({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  accent?: "success" | "warning" | "orange";
}) {
  const valueColor =
    accent === "success"
      ? "text-success"
      : accent === "warning"
        ? "text-warning"
        : accent === "orange"
          ? "text-orange-700"
          : "text-ink-1000";
  return (
    <div className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {label}
        </p>
        {icon}
      </div>
      <p className={`mt-3 text-3xl font-semibold tracking-tight ${valueColor}`}>
        {value}
      </p>
      <p className="mt-1 text-xs text-ink-500">{sub}</p>
    </div>
  );
}


function ModernRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-medium text-ink-1000">{value}</dd>
    </div>
  );
}


function ModernComplianceChip({ ok, label }: { ok: boolean; label: string }) {
  const classes = ok
    ? "bg-success/10 text-success ring-success/20"
    : "bg-danger/10 text-danger ring-danger/20";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {ok ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <AlertTriangle className="h-3 w-3" />
      )}
      {ok ? label : `Non-${label}`}
    </span>
  );
}
