"use client";

/**
 * Version history tab. Read-only timeline of every ``FormulationVersion``
 * the project has cut, with rollback + approve affordances the builder
 * already surfaces from the drawer — surfacing them here so ops /
 * regulatory can audit the trail without opening Builder.
 *
 * Each row shows:
 *   * Version number + optional label (e.g. ``pre-pull-from-psp``).
 *   * Timestamp (company-format aware).
 *   * "Approved" chip on the row currently marked approved.
 *   * Snapshot summary — line count, stage count, active-status hits
 *     from ``snapshot_metadata``.
 *   * Actions: Rollback / Approve / Unapprove (permission-gated).
 *
 * The snapshot bodies (metadata / lines / stage BOMs) live on the DTO
 * so we can pull-to-expand rows without a follow-up fetch — but for
 * v1 we keep the summary read-only. A "View details" drill-down can
 * come later without touching the tab plumbing.
 */

import { useMemo, useState } from "react";
import { Activity, History as HistoryIcon, Loader2, RotateCcw, ShieldCheck, User } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  useFormulation,
  useFormulationVersions,
  useProjectOverview,
  useRollbackFormulation,
  useSetApprovedVersion,
  type FormulationVersionDto,
  type ProjectActivityEntryDto,
} from "@/services/formulations";


export function VersionHistoryPanel({
  orgId,
  formulationId,
  canEdit,
}: {
  orgId: string;
  formulationId: string;
  canEdit: boolean;
}) {
  const t = useTranslations("formulations");
  const locale = useLocale();
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const overviewQuery = useProjectOverview(orgId, formulationId);
  const formulationQuery = useFormulation(orgId, formulationId);
  const rollback = useRollbackFormulation(orgId, formulationId);
  const setApproved = useSetApprovedVersion(orgId, formulationId);
  const [subTab, setSubTab] = useState<"versions" | "activity">(
    "versions",
  );
  const [showAutosaves, setShowAutosaves] = useState(false);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [locale],
  );

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const versions = versionsQuery.data ?? [];
  const approvedNumber = formulationQuery.data?.approved_version_number ?? null;

  const handleRollback = async (versionNumber: number) => {
    if (
      !confirm(
        t("versions.rollback_confirm_body", { version: versionNumber }),
      )
    ) {
      return;
    }
    setErrorMessage(null);
    try {
      await rollback.mutateAsync({ version_number: versionNumber });
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Rollback failed",
      );
    }
  };

  const handleToggleApproved = async (versionNumber: number) => {
    const isApproved = approvedNumber === versionNumber;
    setErrorMessage(null);
    try {
      await setApproved.mutateAsync(isApproved ? null : versionNumber);
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Update failed",
      );
    }
  };

  const isBusy = rollback.isPending || setApproved.isPending;
  // Which version number a mutation is currently targeting (or null).
  // TanStack Query exposes the last-passed variables while a mutation
  // is in-flight, so we can point a per-row spinner at exactly the
  // button the operator clicked instead of greying every action out
  // with no other feedback.
  const rollingBackVersion = rollback.isPending
    ? rollback.variables?.version_number ?? null
    : null;
  const togglingApprovedVersion = setApproved.isPending
    ? setApproved.variables ?? null
    : null;

  const activity = overviewQuery.data?.activity ?? [];

  // Versions sub-tab shows only named milestones by default. Auto-
  // snapshots (fired silently on every Save draft) are what Activity
  // revert uses under the hood; showing them here would clutter the
  // milestone view. Toggle re-enables them for advanced use.
  const visibleVersions = showAutosaves
    ? versions
    : versions.filter((v) => !v.is_auto);
  const autoCount = versions.filter((v) => v.is_auto).length;

  // For each activity row, find the newest version at-or-before its
  // timestamp so Activity revert always has a target. Named + auto
  // versions both count — that's the whole point of Path B.
  const activityRevertTargets = useMemo(() => {
    if (versions.length === 0 || activity.length === 0)
      return new Map<string, FormulationVersionDto>();
    // Versions come from the API sorted by ``-version_number`` which
    // usually matches created_at descending. Sort defensively so the
    // "closest at or before" lookup below is order-safe.
    const sorted = [...versions].sort(
      (a, b) =>
        new Date(b.created_at).getTime() -
        new Date(a.created_at).getTime(),
    );
    const map = new Map<string, FormulationVersionDto>();
    for (const entry of activity) {
      const entryTime = new Date(entry.created_at).getTime();
      const match = sorted.find(
        (v) => new Date(v.created_at).getTime() <= entryTime,
      );
      if (match) map.set(entry.id, match);
    }
    return map;
  }, [versions, activity]);

  return (
    <section className="flex flex-col gap-4">
      <header className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
        <div className="flex items-center gap-2">
          <HistoryIcon className="h-5 w-5 text-ink-500" />
          <h2 className="text-lg font-semibold text-ink-1000">History</h2>
        </div>
        <p className="mt-1 text-sm text-ink-600">
          Two lenses on the same project. <strong>Versions</strong> are
          milestone snapshots you cut with <em>Save version</em> — each
          one freezes the full state (metadata + lines + stage BOMs) and
          can be rolled back or marked approved. <strong>Activity</strong>{" "}
          is the running audit trail — every draft save, stage edit,
          spec sheet, trial batch, and QC event, chronological.
        </p>
        {/* Sub-tab pill strip — matches the Builder's inner tab style */}
        <nav
          aria-label="History sub-tabs"
          className="mt-4 inline-flex items-center gap-1 rounded-full bg-ink-100 p-1"
        >
          <SubTabButton
            active={subTab === "versions"}
            onClick={() => setSubTab("versions")}
            icon={<HistoryIcon className="h-3.5 w-3.5" />}
            label={`Versions${visibleVersions.length > 0 ? ` · ${visibleVersions.length}` : ""}`}
          />
          <SubTabButton
            active={subTab === "activity"}
            onClick={() => setSubTab("activity")}
            icon={<Activity className="h-3.5 w-3.5" />}
            label={`Activity${activity.length > 0 ? ` · ${activity.length}` : ""}`}
          />
        </nav>
        {subTab === "versions" && autoCount > 0 ? (
          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-ink-600 hover:text-ink-1000">
            <input
              type="checkbox"
              checked={showAutosaves}
              onChange={(e) => setShowAutosaves(e.target.checked)}
              className="h-3.5 w-3.5 accent-orange-500"
            />
            Show autosaves ({autoCount})
          </label>
        ) : null}
      </header>

      {errorMessage ? (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20">
          {errorMessage}
        </p>
      ) : null}

      {subTab === "versions" ? (
        versionsQuery.isLoading || formulationQuery.isLoading ? (
          <p className="rounded-2xl bg-ink-0 p-6 text-center text-sm text-ink-500 shadow-sm ring-1 ring-ink-200">
            Loading versions…
          </p>
        ) : visibleVersions.length === 0 ? (
          <div className="rounded-2xl bg-ink-0 p-8 text-center shadow-sm ring-1 ring-ink-200">
            <HistoryIcon className="mx-auto h-10 w-10 text-ink-300" />
            <p className="mt-3 text-sm font-medium text-ink-1000">
              {autoCount > 0
                ? "No milestone versions yet."
                : "No saved versions yet."}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              {autoCount > 0 ? (
                <>
                  Every draft save auto-snapshots for the Activity revert
                  flow ({autoCount} so far). Click{" "}
                  <strong>Save version</strong> on the Builder tab to
                  cut a named milestone, or tick <em>Show autosaves</em>{" "}
                  above to see the auto rows.
                </>
              ) : (
                <>
                  Click <strong>Save version</strong> on the Builder tab
                  to freeze a milestone snapshot. Draft saves auto-snap
                  too — visit the Activity sub-tab to revert to any
                  point.
                </>
              )}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {visibleVersions.map((v) => (
              <VersionRow
                key={v.id}
                version={v}
                isApproved={approvedNumber === v.version_number}
                canEdit={canEdit}
                isBusy={isBusy}
                isRollingBack={rollingBackVersion === v.version_number}
                isTogglingApproved={
                  togglingApprovedVersion === v.version_number
                }
                dateFormatter={dateFormatter}
                onRollback={() => handleRollback(v.version_number)}
                onToggleApproved={() =>
                  handleToggleApproved(v.version_number)
                }
              />
            ))}
          </ul>
        )
      ) : (
        <ActivityFeed
          entries={activity}
          isLoading={overviewQuery.isLoading}
          dateFormatter={dateFormatter}
          revertTargets={activityRevertTargets}
          canEdit={canEdit}
          isBusy={isBusy}
          rollingBackVersion={rollingBackVersion}
          onRollback={handleRollback}
        />
      )}
    </section>
  );
}


function SubTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "inline-flex items-center gap-1.5 rounded-full bg-ink-0 px-3 py-1 text-xs font-medium text-ink-1000 shadow-sm"
          : "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-ink-600 hover:text-ink-1000"
      }
    >
      {icon}
      {label}
    </button>
  );
}


function ActivityFeed({
  entries,
  isLoading,
  dateFormatter,
  revertTargets,
  canEdit,
  isBusy,
  rollingBackVersion,
  onRollback,
}: {
  entries: readonly ProjectActivityEntryDto[];
  isLoading: boolean;
  dateFormatter: Intl.DateTimeFormat;
  revertTargets: Map<string, FormulationVersionDto>;
  canEdit: boolean;
  isBusy: boolean;
  rollingBackVersion: number | null;
  onRollback: (versionNumber: number) => void;
}) {
  if (isLoading) {
    return (
      <p className="rounded-2xl bg-ink-0 p-6 text-center text-sm text-ink-500 shadow-sm ring-1 ring-ink-200">
        Loading activity…
      </p>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="rounded-2xl bg-ink-0 p-8 text-center shadow-sm ring-1 ring-ink-200">
        <Activity className="mx-auto h-10 w-10 text-ink-300" />
        <p className="mt-3 text-sm font-medium text-ink-1000">
          No activity yet.
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Draft saves, stage edits, spec sheets, and trial batches will
          show up here as they happen.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => {
        const revertTarget = revertTargets.get(entry.id);
        return (
          <li
            key={entry.id}
            className="flex items-start justify-between gap-4 rounded-xl bg-ink-0 px-4 py-3 text-sm shadow-sm ring-1 ring-ink-200"
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${activityDotColor(entry.kind)}`}
              />
              <div className="min-w-0">
                <p className="text-ink-1000">{entry.text}</p>
                <p className="mt-0.5 text-[11px] text-ink-500">
                  <span className="rounded-full bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] tracking-tight">
                    {entry.kind}
                  </span>
                </p>
              </div>
            </div>
            <div className="flex flex-shrink-0 flex-col items-end gap-1.5 text-xs text-ink-500">
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                {entry.actor_name || "system"}
              </span>
              <span className="text-[11px]">
                {dateFormatter.format(new Date(entry.created_at))}
              </span>
              {canEdit && revertTarget ? (
                (() => {
                  const isThisReverting =
                    rollingBackVersion === revertTarget.version_number;
                  return (
                    <button
                      type="button"
                      onClick={() => onRollback(revertTarget.version_number)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 rounded-lg bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50"
                      title={`Revert project state to v${revertTarget.version_number}${revertTarget.is_auto ? " (autosave)" : ""} — the snapshot closest to this event`}
                      aria-busy={isThisReverting}
                    >
                      {isThisReverting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="h-3 w-3" />
                      )}
                      {isThisReverting
                        ? `Reverting to v${revertTarget.version_number}…`
                        : `Revert to v${revertTarget.version_number}${revertTarget.is_auto ? " (auto)" : ""}`}
                    </button>
                  );
                })()
              ) : canEdit ? (
                <span
                  className="text-[10px] italic text-ink-400"
                  title="No snapshot exists at or before this event — earlier activity happened before autosnapshots landed."
                >
                  No snapshot
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}


// Colour-code the leading dot by event family so operators can scan
// for the kind of change they care about — orange for formulation
// edits, green for versions, blue for artefacts (spec sheets, trial
// batches, QC).
function activityDotColor(kind: string): string {
  if (kind.startsWith("formulation")) return "bg-orange-400";
  if (kind.startsWith("formulation_version")) return "bg-emerald-500";
  if (kind.startsWith("spec_sheet") || kind.startsWith("specification"))
    return "bg-sky-400";
  if (kind.startsWith("trial_batch")) return "bg-purple-400";
  if (
    kind.startsWith("product_validation") ||
    kind.startsWith("qc")
  )
    return "bg-red-400";
  return "bg-ink-300";
}


function VersionRow({
  version,
  isApproved,
  canEdit,
  isBusy,
  isRollingBack,
  isTogglingApproved,
  dateFormatter,
  onRollback,
  onToggleApproved,
}: {
  version: FormulationVersionDto;
  isApproved: boolean;
  canEdit: boolean;
  isBusy: boolean;
  isRollingBack: boolean;
  isTogglingApproved: boolean;
  dateFormatter: Intl.DateTimeFormat;
  onRollback: () => void;
  onToggleApproved: () => void;
}) {
  const lineCount = version.snapshot_lines.length;
  const stageBomCount = Object.keys(version.snapshot_stage_boms).length;
  const metadata = version.snapshot_metadata as {
    readonly name?: string;
    readonly code?: string;
    readonly dosage_form?: string;
    readonly servings_per_pack?: number;
    readonly target_fill_weight_mg?: string;
    readonly created_by_email?: string;
  };
  const dateLabel = dateFormatter.format(new Date(version.created_at));

  return (
    <li
      className={`rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ${
        isApproved
          ? "ring-2 ring-orange-400"
          : "ring-ink-200"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-ink-900 px-3 py-1 text-sm font-semibold text-ink-0">
              v{version.version_number}
            </span>
            {version.label ? (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-700">
                {version.label}
              </span>
            ) : null}
            {version.is_auto ? (
              <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Auto
              </span>
            ) : null}
            {isApproved ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-orange-800">
                <ShieldCheck className="h-3 w-3" />
                Approved
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-500">
            Saved {dateLabel}
            {metadata.created_by_email ? (
              <>
                {" · "}
                <span className="inline-flex items-center gap-1">
                  <User className="h-3 w-3" />
                  {metadata.created_by_email}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleApproved}
              disabled={isBusy}
              className={
                isApproved
                  ? "inline-flex items-center gap-1 rounded-lg bg-orange-100 px-3 py-1.5 text-xs font-medium text-orange-900 hover:bg-orange-200 disabled:opacity-50"
                  : "inline-flex items-center gap-1 rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50"
              }
              title={
                isApproved
                  ? "Remove approval mark"
                  : "Mark this version as approved for regulatory sign-off"
              }
              aria-busy={isTogglingApproved}
            >
              {isTogglingApproved ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              {isTogglingApproved
                ? isApproved
                  ? "Unapproving…"
                  : "Marking…"
                : isApproved
                  ? "Unapprove"
                  : "Mark approved"}
            </button>
            <button
              type="button"
              onClick={onRollback}
              disabled={isBusy}
              className="inline-flex items-center gap-1 rounded-lg bg-ink-100 px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50"
              title="Restore this version as the current draft"
              aria-busy={isRollingBack}
            >
              {isRollingBack ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {isRollingBack ? "Rolling back…" : "Rollback"}
            </button>
          </div>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-ink-100 pt-3 text-xs md:grid-cols-4">
        <SnapshotStat
          label="Ingredient lines"
          value={String(lineCount)}
        />
        <SnapshotStat
          label="Stage BOMs"
          value={String(stageBomCount)}
        />
        {metadata.dosage_form ? (
          <SnapshotStat
            label="Dosage form"
            value={metadata.dosage_form}
          />
        ) : null}
        {metadata.servings_per_pack !== undefined &&
        metadata.servings_per_pack !== null ? (
          <SnapshotStat
            label="Servings / pack"
            value={String(metadata.servings_per_pack)}
          />
        ) : null}
        {metadata.target_fill_weight_mg ? (
          <SnapshotStat
            label="Fill weight"
            value={`${metadata.target_fill_weight_mg} mg`}
          />
        ) : null}
        {metadata.code ? (
          <SnapshotStat label="Code" value={metadata.code} />
        ) : null}
      </dl>
    </li>
  );
}


function SnapshotStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm text-ink-1000" title={value}>
        {value}
      </dd>
    </div>
  );
}
