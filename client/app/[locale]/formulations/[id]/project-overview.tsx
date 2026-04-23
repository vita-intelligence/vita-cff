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
  Scale,
  Target,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { CommentsPanel } from "@/components/comments";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import type { OrganizationDto } from "@/services/organizations/types";
import {
  useProjectOverview,
  type ProjectOverviewDto,
  type ProjectStatus,
} from "@/services/formulations";


/**
 * Project Overview block rendered at the top of the formulation
 * detail page. Hydrates from the SSR payload and refetches on mount
 * so freshly-saved versions / batches surface without a reload.
 */
export function ProjectOverview({
  orgId,
  formulationId,
  initialData,
  organization,
  currentUserId,
}: {
  orgId: string;
  formulationId: string;
  initialData: ProjectOverviewDto;
  organization: OrganizationDto;
  currentUserId: string;
}) {
  const tProject = useTranslations("project_overview");
  const query = useProjectOverview(orgId, formulationId, { initialData });
  const overview = query.data ?? initialData;

  const canViewComments = hasFlatCapability(
    organization,
    "formulations",
    "comments_view",
  );
  const canWriteComments = hasFlatCapability(
    organization,
    "formulations",
    "comments_write",
  );
  const canModerateComments = hasFlatCapability(
    organization,
    "formulations",
    "comments_moderate",
  );

  return (
    <article className="flex flex-col gap-6">
      <HeaderCard overview={overview} tProject={tProject} />
      <KpiRow overview={overview} tProject={tProject} />
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <SnapshotCard overview={overview} tProject={tProject} />
        <ComplianceCard overview={overview} tProject={tProject} />
      </section>
      <ActivityCard overview={overview} tProject={tProject} />
      <CommentsPanel
        orgId={orgId}
        entityKind="formulation"
        entityId={formulationId}
        canRead={canViewComments}
        canWrite={canWriteComments}
        canModerate={canModerateComments}
        currentUserId={currentUserId}
      />
    </article>
  );
}


// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------


function HeaderCard({
  overview,
  tProject,
}: {
  overview: ProjectOverviewDto;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const tForms = useTranslations("formulations");
  return (
    <section className="rounded-2xl bg-ink-0 p-8 shadow-sm ring-1 ring-ink-200">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {overview.code || tProject("header.no_code")}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-ink-1000">
            {overview.name}
          </h1>
          {overview.description ? (
            <p className="mt-2 text-sm text-ink-600">{overview.description}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-500">
            <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
              <Package className="h-3 w-3" />{" "}
              {tForms(
                `dosage_forms.${overview.dosage_form}` as "dosage_forms.capsule",
              ) || overview.dosage_form}
            </span>
            {overview.size_label ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
                {overview.size_label}
              </span>
            ) : null}
            {overview.latest_version !== null ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1">
                v{overview.latest_version}
                {overview.latest_version_label
                  ? ` · ${overview.latest_version_label}`
                  : ""}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-1 text-warning">
                <AlertTriangle className="h-3 w-3" />
                {tProject("header.no_versions_yet")}
              </span>
            )}
          </div>
          {overview.owner_name ? (
            <p className="mt-2 text-xs text-ink-500">
              {tProject("header.owner", { name: overview.owner_name })}
            </p>
          ) : null}
        </div>
        <StatusPill status={overview.project_status} tProject={tProject} />
      </div>
    </section>
  );
}


function StatusPill({
  status,
  tProject,
}: {
  status: ProjectStatus;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const styles: Record<
    ProjectStatus,
    { classes: string; icon: React.ReactNode }
  > = {
    concept: {
      classes: "bg-ink-100 text-ink-700 ring-ink-200",
      icon: <Plus className="h-3.5 w-3.5" />,
    },
    in_development: {
      classes: "bg-info/10 text-info ring-info/20",
      icon: <FlaskConical className="h-3.5 w-3.5" />,
    },
    pilot: {
      classes: "bg-orange-50 text-orange-700 ring-orange-200",
      icon: <PlayCircle className="h-3.5 w-3.5" />,
    },
    approved: {
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    discontinued: {
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
      {tProject(`status.${status}` as "status.concept")}
    </span>
  );
}


// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------


function KpiRow({
  overview,
  tProject,
}: {
  overview: ProjectOverviewDto;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  return (
    <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <KpiCard
        icon={<FileText className="h-4 w-4 text-ink-400" />}
        label={tProject("kpi.spec_sheets")}
        value={String(overview.spec_sheets.total)}
        sub={tProject("kpi.spec_sheets_sub", {
          draft: overview.spec_sheets.draft,
          approved: overview.spec_sheets.approved,
          sent: overview.spec_sheets.sent,
        })}
      />
      <KpiCard
        icon={<FlaskConical className="h-4 w-4 text-ink-400" />}
        label={tProject("kpi.trial_batches")}
        value={String(overview.trial_batches.total)}
        sub={tProject("kpi.trial_batches_sub", {
          count: overview.trial_batches.in_flight,
        })}
        accent={overview.trial_batches.in_flight > 0 ? "orange" : undefined}
      />
      <KpiCard
        icon={<CheckCircle2 className="h-4 w-4 text-ink-400" />}
        label={tProject("kpi.qc")}
        value={`${overview.qc.passed}/${overview.qc.total}`}
        sub={tProject("kpi.qc_sub", {
          passed: overview.qc.passed,
          in_progress: overview.qc.in_progress,
        })}
      />
      <KpiCard
        icon={
          overview.allergens.count === 0 ? (
            <CheckCircle2 className="h-4 w-4 text-success" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-warning" />
          )
        }
        label={tProject("kpi.allergens")}
        value={
          overview.allergens.count === 0
            ? tProject("kpi.allergens_none")
            : String(overview.allergens.count)
        }
        sub={
          overview.allergens.count === 0
            ? tProject("kpi.allergens_clean")
            : overview.allergens.sources.join(", ")
        }
        accent={overview.allergens.count === 0 ? "success" : "warning"}
      />
    </section>
  );
}


function KpiCard({
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


// ---------------------------------------------------------------------------
// Snapshot + Compliance
// ---------------------------------------------------------------------------


function SnapshotCard({
  overview,
  tProject,
}: {
  overview: ProjectOverviewDto;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const hasData = overview.latest_version !== null;
  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <Scale className="h-4 w-4 text-ink-400" />
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProject("snapshot.title")}
        </h2>
      </div>
      {!hasData ? (
        <p className="mt-4 text-sm text-ink-500">
          {tProject("snapshot.empty")}
        </p>
      ) : (
        <dl className="mt-4 space-y-3 text-sm">
          <Row
            label={tProject("snapshot.total_active")}
            value={formatMg(overview.totals.total_active_mg)}
          />
          <Row
            label={tProject("snapshot.fill_weight")}
            value={formatMg(overview.totals.total_weight_mg)}
          />
          <Row
            label={tProject("snapshot.filled_capsule")}
            value={formatMg(overview.totals.filled_total_mg)}
          />
          <div className="flex items-center justify-between">
            <dt className="text-ink-500">
              {tProject("snapshot.viability")}
            </dt>
            <dd>
              <ViabilityChip viability={overview.totals.viability} />
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}


function ViabilityChip({ viability }: { viability: string | null }) {
  if (viability === "can_make") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success ring-1 ring-inset ring-success/20">
        <CheckCircle2 className="h-3 w-3" />
        Can make
      </span>
    );
  }
  if (viability === "cannot_make") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20">
        <AlertTriangle className="h-3 w-3" />
        Cannot make
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-0.5 text-xs font-medium text-ink-500 ring-1 ring-inset ring-ink-200">
      —
    </span>
  );
}


function ComplianceCard({
  overview,
  tProject,
}: {
  overview: ProjectOverviewDto;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 text-ink-400" />
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProject("compliance.title")}
        </h2>
      </div>
      <ul className="mt-4 flex flex-wrap gap-2">
        <ComplianceChip
          ok={overview.compliance.vegan}
          label={tProject("compliance.vegan")}
        />
        <ComplianceChip
          ok={overview.compliance.organic}
          label={tProject("compliance.organic")}
        />
        <ComplianceChip
          ok={overview.compliance.halal}
          label={tProject("compliance.halal")}
        />
        <ComplianceChip
          ok={overview.compliance.kosher}
          label={tProject("compliance.kosher")}
        />
      </ul>
      {overview.allergens.count === 0 ? (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-success/10 p-3 text-xs text-success">
          <Leaf className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{tProject("compliance.no_allergens")}</span>
        </div>
      ) : (
        <div className="mt-4 flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>
            {tProject("compliance.allergens_present", {
              sources: overview.allergens.sources.join(", "),
            })}
          </span>
        </div>
      )}
    </div>
  );
}


function ComplianceChip({
  ok,
  label,
}: {
  ok: boolean | null;
  label: string;
}) {
  // Tri-state: true = pass (success), false = fail (danger),
  // null = no data (neutral).
  if (ok === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-500 ring-1 ring-inset ring-ink-200">
        {label}
      </span>
    );
  }
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


function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-medium text-ink-1000">{value}</dd>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------


function ActivityCard({
  overview,
  tProject,
}: {
  overview: ProjectOverviewDto;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-ink-400" />
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProject("activity.title")}
        </h2>
      </div>
      {overview.activity.length === 0 ? (
        <p className="mt-4 text-sm text-ink-500">{tProject("activity.empty")}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {overview.activity.map((entry) => (
            <li
              key={entry.id}
              className="flex items-start justify-between gap-4 text-sm"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-ink-300" />
                <span className="text-ink-1000">{entry.text}</span>
              </div>
              <span className="flex-shrink-0 text-xs text-ink-500">
                {entry.actor_name} · {formatAgo(entry.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function formatMg(raw: string | null): string {
  if (!raw) return "—";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed.toFixed(2)} mg`;
}


/**
 * Deterministic relative-time formatter. Hand-rolled to avoid
 * ``Intl.RelativeTimeFormat`` locale drift between SSR and client
 * — same reason the spec sheet timestamps use a UTC-only formatter.
 */
function formatAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(months / 12);
  return `${years}y`;
}


