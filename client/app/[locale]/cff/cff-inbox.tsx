"use client";

import {
  AlertTriangle,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { CFFAssignModal } from "@/components/cff/cff-assign-modal";
import { CFFDetailModal } from "@/components/cff/cff-detail-modal";
import { NewFormulationButton } from "../formulations/new-formulation-button";
import {
  useCFFFieldLabels,
  useCFFSyncStatus,
  useInfiniteCFFSubmissions,
  type CFFSubmissionDto,
} from "@/services/cff-submissions";


type Filter = "all" | "unassigned" | "assigned";


/**
 * Client-side body of the CFF page.
 *
 * Three states overlaid on one list:
 *
 * 1. ``all`` — every CFF in the org, newest first.
 * 2. ``unassigned`` — the triage queue (default view).
 * 3. ``assigned`` — historical record of routed CFFs.
 *
 * Search runs a substring match against the raw Wix payload on
 * the server side (``raw_payload__icontains``). Field labels are
 * fetched once on mount and reused across rows so the detail
 * modal can render "Email" instead of ``email_fc7d`` without
 * fanning out one round-trip per submission.
 */
export function CFFInbox({
  orgId,
  canAssign,
}: {
  orgId: string;
  canAssign: boolean;
}) {
  const t = useTranslations("cff");

  const [filter, setFilter] = useState<Filter>("unassigned");
  const [search, setSearch] = useState("");
  const [openDetail, setOpenDetail] = useState<CFFSubmissionDto | null>(null);
  const [openAssign, setOpenAssign] = useState<CFFSubmissionDto | null>(null);
  const [openCreate, setOpenCreate] = useState<CFFSubmissionDto | null>(null);

  const labelsQuery = useCFFFieldLabels(orgId);
  const listQuery = useInfiniteCFFSubmissions({
    orgId,
    assigned:
      filter === "all" ? undefined : filter === "assigned",
    search: search.trim() || undefined,
  });

  const rows = useMemo(() => {
    const pages = listQuery.data?.pages ?? [];
    return pages.flatMap((page) => page.results);
  }, [listQuery.data]);

  return (
    <>
      <section className="mt-6 flex flex-col gap-4">
        <SyncStatusBanner orgId={orgId} t={t} />
        <FilterBar
          filter={filter}
          search={search}
          onFilter={setFilter}
          onSearch={setSearch}
          t={t}
        />

        {listQuery.isPending ? (
          <Skeleton label={t("list.loading")} />
        ) : listQuery.isError ? (
          <ErrorState message={t("errors.wix_cff_unknown_error")} />
        ) : rows.length === 0 ? (
          <EmptyState searching={Boolean(search.trim())} t={t} />
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <CFFRow
                key={row.id}
                row={row}
                onOpen={() => setOpenDetail(row)}
                onAssign={
                  canAssign ? () => setOpenAssign(row) : undefined
                }
                onCreateProject={
                  canAssign ? () => setOpenCreate(row) : undefined
                }
                t={t}
              />
            ))}
          </ul>
        )}

        {listQuery.hasNextPage ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => void listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-50 px-4 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 disabled:opacity-60"
            >
              {listQuery.isFetchingNextPage ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("list.load_more")}
            </button>
          </div>
        ) : null}
      </section>

      {openDetail ? (
        <CFFDetailModal
          orgId={orgId}
          submission={openDetail}
          fieldLabels={labelsQuery.data?.field_labels_by_form ?? {}}
          canAssign={canAssign}
          onClose={() => setOpenDetail(null)}
          onAssign={() => {
            setOpenAssign(openDetail);
            setOpenDetail(null);
          }}
          onCreateProject={() => {
            setOpenCreate(openDetail);
            setOpenDetail(null);
          }}
        />
      ) : null}
      {openAssign ? (
        <CFFAssignModal
          orgId={orgId}
          submission={openAssign}
          onClose={() => setOpenAssign(null)}
        />
      ) : null}
      {openCreate ? (
        <NewFormulationButton
          orgId={orgId}
          cffSubmissionId={openCreate.id}
          initialDescription={deriveDescriptionHint(openCreate)}
          externallyOpen={true}
          onClose={() => setOpenCreate(null)}
        />
      ) : null}
    </>
  );
}


/** Pre-fill text for the description field on the new-project
 *  modal when launched from a CFF row. Uses the market-segment
 *  answer if present so the project list reads with context. */
function deriveDescriptionHint(submission: CFFSubmissionDto): string {
  const subs = (submission.raw_payload?.submissions ?? {}) as Record<
    string,
    unknown
  >;
  for (const slug of Object.keys(subs)) {
    if (slug.startsWith("market_segment")) {
      const value = subs[slug];
      if (typeof value === "string" && value.trim()) {
        return `From CFF intake — ${value.trim()}`;
      }
    }
  }
  return "From CFF intake";
}


// ---------------------------------------------------------------------------
// Sync-status banner — answers "how often do we pull from Wix?" and
// "when did we last sync?". Hidden when the integration is off so
// the inbox doesn't look broken on a never-configured workspace.
// ---------------------------------------------------------------------------


function SyncStatusBanner({
  orgId,
  t,
}: {
  orgId: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const format = useFormatter();
  const now = useNow();
  const statusQuery = useCFFSyncStatus(orgId);
  const status = statusQuery.data;
  if (!status) return null;
  if (!status.enabled) return null;

  const cadence = formatCadence(status.poll_interval_seconds);
  const lastPoll = status.last_poll_at
    ? format.relativeTime(new Date(status.last_poll_at), now)
    : t("sync.never");

  return (
    <aside
      role="note"
      className="flex items-start gap-2 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-900 ring-1 ring-inset ring-blue-200"
    >
      <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {t("sync.cadence", { cadence })}{" "}
        <strong className="font-semibold">
          {t("sync.last_sync", { when: lastPoll })}
        </strong>
      </span>
    </aside>
  );
}


/** Turn the Celery beat interval into a human phrase. The backend
 *  ships seconds; the UI rounds to the nearest minute / hour so a
 *  cadence change in ``CELERY_BEAT_SCHEDULE`` propagates without an
 *  i18n edit. */
function formatCadence(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(seconds / 3600);
  return `${hours}h`;
}


// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------


function FilterBar({
  filter,
  search,
  onFilter,
  onSearch,
  t,
}: {
  filter: Filter;
  search: string;
  onFilter: (v: Filter) => void;
  onSearch: (v: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="tablist"
        className="inline-flex rounded-full bg-ink-50 p-1 ring-1 ring-inset ring-ink-200"
      >
        {(["unassigned", "all", "assigned"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => onFilter(value)}
            className={
              "rounded-full px-3 py-1 text-xs font-medium transition-colors " +
              (filter === value
                ? "bg-white text-ink-1000 shadow-sm"
                : "text-ink-600 hover:text-ink-800")
            }
          >
            {t(`filter.${value}`)}
          </button>
        ))}
      </div>

      <label className="relative flex-1 min-w-[200px]">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("filter.search_placeholder")}
          className="w-full rounded-lg bg-white py-2 pl-9 pr-9 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-50"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </label>
    </div>
  );
}


// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------


function CFFRow({
  row,
  onOpen,
  onAssign,
  onCreateProject,
  t,
}: {
  row: CFFSubmissionDto;
  onOpen: () => void;
  onAssign?: () => void;
  onCreateProject?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const format = useFormatter();
  // ``useNow`` returns a stable reference time that lines up
  // between the server render and the client hydration — without
  // it ``relativeTime`` defaults to ``Date.now()`` and the two
  // renders disagree, surfacing as a hydration warning.
  const now = useNow();

  const previewFields = extractPreview(row.raw_payload);
  const customerName = previewFields.name || previewFields.email || "—";

  return (
    <li>
      <article className="group flex flex-col gap-3 rounded-2xl bg-white p-4 ring-1 ring-ink-200 transition-shadow hover:shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-semibold text-ink-1000">
              {customerName}
            </p>
            <StatusChip status={row.wix_status} t={t} />
            <AssignmentBadge row={row} t={t} />
          </div>
          {previewFields.company ? (
            <p className="text-xs text-ink-600">{previewFields.company}</p>
          ) : null}
          {previewFields.email && previewFields.email !== customerName ? (
            <p className="text-xs text-ink-500">{previewFields.email}</p>
          ) : null}
          <p className="text-[11px] text-ink-500">
            {t("list.received", {
              when: format.relativeTime(new Date(row.wix_created_date), now),
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Primary triage action for an unassigned row: create the
              project and route everything from this CFF straight
              there. The "attach to existing" path lives in the
              detail modal for the rare case the project already
              exists. */}
          {onCreateProject && !row.project ? (
            <button
              type="button"
              onClick={onCreateProject}
              className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600"
            >
              {t("create_project.open")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-lg bg-ink-50 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
          >
            {t("list.open")}
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      </article>
    </li>
  );
}


function StatusChip({
  status,
  t,
}: {
  status: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const tone =
    status === "CONFIRMED"
      ? "bg-success/10 text-success ring-success/20"
      : status === "UNKNOWN"
        ? "bg-ink-100 text-ink-600 ring-ink-200"
        : "bg-warning/10 text-warning ring-warning/20";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone}`}
    >
      {t(`status.${status as "CONFIRMED"}`)}
    </span>
  );
}


function AssignmentBadge({
  row,
  t,
}: {
  row: CFFSubmissionDto;
  t: ReturnType<typeof useTranslations>;
}) {
  if (row.project) {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 ring-1 ring-inset ring-blue-200">
        {t("badge.assigned_to", {
          project: row.project.code || row.project.name,
        })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
      <AlertTriangle className="mr-1 h-2.5 w-2.5" />
      {t("badge.unassigned")}
    </span>
  );
}


// ---------------------------------------------------------------------------
// Empty / loading / error states
// ---------------------------------------------------------------------------


function Skeleton({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center rounded-2xl bg-ink-50 p-12 text-sm text-ink-600">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}


function EmptyState({
  searching,
  t,
}: {
  searching: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-ink-50 p-12 text-center text-sm text-ink-600">
      <Inbox className="h-6 w-6 text-ink-400" />
      <p>{searching ? t("list.empty_search") : t("list.empty")}</p>
    </div>
  );
}


function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl bg-danger/10 p-4 text-sm text-danger ring-1 ring-inset ring-danger/20">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>{message}</p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Payload preview helpers
// ---------------------------------------------------------------------------


interface Preview {
  name: string;
  email: string;
  company: string;
}


function extractPreview(payload: Record<string, unknown>): Preview {
  const submissions =
    (payload?.submissions as Record<string, unknown> | undefined) ?? {};

  const findByPrefix = (prefix: string): string => {
    for (const [key, value] of Object.entries(submissions)) {
      if (key.startsWith(prefix) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  };

  return {
    name: findByPrefix("first_name") || findByPrefix("full_name") || findByPrefix("name"),
    email: findByPrefix("email"),
    company:
      findByPrefix("company") ||
      findByPrefix("organization") ||
      findByPrefix("brand"),
  };
}
