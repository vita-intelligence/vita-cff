"use client";

import {
  AlertTriangle,
  Ban,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { CFFAssignModal } from "@/components/cff/cff-assign-modal";
import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { Link } from "@/i18n/navigation";
import { NewFormulationButton } from "../formulations/new-formulation-button";
import {
  useCFFSyncStatus,
  useInfiniteCFFSubmissions,
  useRejectCFF,
  useUnrejectCFF,
  type CFFSubmissionDto,
} from "@/services/cff-submissions";


type Filter = "all" | "unassigned" | "assigned" | "rejected";


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
  // Detail view now lives on a dedicated route — the inbox no
  // longer mounts the floating-window modal. Assign / Create-
  // project actions stay inline as modals because they're
  // one-tap actions that shouldn't pull the operator off the
  // inbox queue.
  const [openAssign, setOpenAssign] = useState<CFFSubmissionDto | null>(null);
  const [openCreate, setOpenCreate] = useState<CFFSubmissionDto | null>(null);
  const [openReject, setOpenReject] = useState<CFFSubmissionDto | null>(null);

  const listQuery = useInfiniteCFFSubmissions({
    orgId,
    state: filter,
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
          isFetching={
            listQuery.isFetching && !listQuery.isFetchingNextPage
          }
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
                orgId={orgId}
                onAssign={
                  canAssign ? () => setOpenAssign(row) : undefined
                }
                onCreateProject={
                  canAssign ? () => setOpenCreate(row) : undefined
                }
                onReject={
                  canAssign ? () => setOpenReject(row) : undefined
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
      {openReject ? (
        <RejectCFFDialog
          orgId={orgId}
          submission={openReject}
          onClose={() => setOpenReject(null)}
          t={t}
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
  isFetching,
  t,
}: {
  filter: Filter;
  search: string;
  onFilter: (v: Filter) => void;
  onSearch: (v: string) => void;
  /** ``true`` while the list query is in flight (and not just
   *  loading the next infinite page). Drives the in-input
   *  spinner so the user gets a cue while the typed query is
   *  resolving against the server. */
  isFetching: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="tablist"
        className="inline-flex rounded-full bg-ink-50 p-1 ring-1 ring-inset ring-ink-200"
      >
        {(["unassigned", "all", "assigned", "rejected"] as const).map((value) => (
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
        {/* Right-edge slot — spinner takes priority over the
            clear ``X`` so a slow connection gets a clear "still
            working" signal. */}
        {isFetching ? (
          <Loader2
            aria-hidden
            className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-orange-500"
          />
        ) : search ? (
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
  orgId,
  onAssign,
  onCreateProject,
  onReject,
  t,
}: {
  row: CFFSubmissionDto;
  orgId: string;
  onAssign?: () => void;
  onCreateProject?: () => void;
  onReject?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const format = useFormatter();
  // ``useNow`` returns a stable reference time that lines up
  // between the server render and the client hydration — without
  // it ``relativeTime`` defaults to ``Date.now()`` and the two
  // renders disagree, surfacing as a hydration warning.
  const now = useNow();
  const unrejectMutation = useUnrejectCFF(orgId);

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
          {/* Received-when line pairs a relative timestamp with the
              exact wall clock + short submission id. When the same
              customer spams the form (or legitimately re-submits
              with tweaks), every row looks identical without these
              — the operator has no anchor to tell which reject they
              already fired, and rejections read as no-ops. The full
              ISO in `title` covers audit / timezone edge cases. */}
          <p
            className="text-[11px] text-ink-500"
            title={new Date(row.wix_created_date).toISOString()}
          >
            {t("list.received", {
              when: format.relativeTime(new Date(row.wix_created_date), now),
            })}{" "}
            <span className="text-ink-400">
              ·{" "}
              {format.dateTime(new Date(row.wix_created_date), {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </span>
            <span className="ml-1.5 font-mono text-[10px] text-ink-400">
              #{row.id.slice(0, 8)}
            </span>
          </p>
          {/* Rejected rows carry their reason inline so the operator
              browsing the Rejected tab can see at a glance why we
              said no without opening the detail page. */}
          {row.is_rejected && row.rejection_reason ? (
            <p className="mt-1 rounded-lg bg-rose-50 px-3 py-1.5 text-[11px] text-rose-900 ring-1 ring-inset ring-rose-200">
              <span className="font-semibold">
                {t("reject.reason_label")}:
              </span>{" "}
              <span className="whitespace-pre-wrap">
                {row.rejection_reason}
              </span>
              {row.rejected_by ? (
                <span className="ml-1 text-rose-700">
                  — {row.rejected_by.full_name}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Triage actions stay visible regardless of how many
              projects the CFF is already linked to. ``Create project``
              spins up a fresh workspace and appends the link;
              ``Attach to existing`` opens the picker so the operator
              can wire the CFF into another in-flight project. The
              "send back to triage" path lives inside the assign
              modal so a stray click on the row doesn't drop links.

              Rejected rows swap the triage buttons for a single
              "Send back to triage" button so mistakes can be undone.
              Reject is hidden once the CFF is assigned — you'd have
              to unassign first, matching the backend guard. */}
          {row.is_rejected ? (
            <button
              type="button"
              disabled={unrejectMutation.isPending}
              onClick={() =>
                unrejectMutation.mutate({ submissionId: row.id })
              }
              className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
            >
              {unrejectMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3" />
              )}
              {t("reject.undo")}
            </button>
          ) : (
            <>
              {onAssign ? (
                <button
                  type="button"
                  onClick={onAssign}
                  className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  {t("assign.open")}
                </button>
              ) : null}
              {onCreateProject ? (
                <button
                  type="button"
                  onClick={onCreateProject}
                  className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600"
                >
                  {t("create_project.open")}
                </button>
              ) : null}
              {onReject && !row.is_assigned ? (
                <button
                  type="button"
                  onClick={onReject}
                  className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50"
                >
                  <Ban className="h-3 w-3" />
                  {t("reject.open")}
                </button>
              ) : null}
            </>
          )}
          {/* Detail view lives on its own route. Spec / project
              detail still use the floating modal for quick-view,
              but the CFF surface always navigates to the dedicated
              page so the chat dock + comment history have a stable
              URL to deep-link to from the inbox bell. */}
          <Link
            href={`/cff/${row.id}`}
            prefetch={false}
            className="inline-flex items-center gap-1 rounded-lg bg-ink-50 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
          >
            {t("list.open")}
            <LinkIconSlot
              idleIcon={<ChevronRight className="h-3 w-3" />}
              spinnerSizeClassName="h-3 w-3"
            />
          </Link>
        </div>
      </article>
    </li>
  );
}


/**
 * Modal dialog for capturing a rejection reason before firing the
 * mutation. Kept lightweight (no headlessui / Radix — the rest of
 * the CFF surface has been rolling its own inline dialogs so
 * pulling a new dep in for one screen isn't worth it).
 *
 * Escape / backdrop-click cancel; Submit runs the mutation and
 * closes on success. Errors surface inline so the operator doesn't
 * lose their typed reason on a validation bounce.
 */
function RejectCFFDialog({
  orgId,
  submission,
  onClose,
  t,
}: {
  orgId: string;
  submission: CFFSubmissionDto;
  onClose: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [reason, setReason] = useState(submission.rejection_reason ?? "");
  const [error, setError] = useState<string | null>(null);
  const mutation = useRejectCFF(orgId);
  const preview = extractPreview(submission.raw_payload);
  const who = preview.name || preview.email || preview.company || "—";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) {
      setError(t("reject.reason_required"));
      return;
    }
    setError(null);
    mutation.mutate(
      { submissionId: submission.id, reason: trimmed },
      {
        onSuccess: () => onClose(),
        onError: (err) => {
          setError(err.message || t("reject.error_generic"));
        },
      },
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-cff-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl ring-1 ring-ink-200"
      >
        <div className="mb-3 flex items-start gap-2">
          <div className="mt-0.5 rounded-full bg-rose-100 p-1.5 text-rose-700">
            <Ban className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <h2
              id="reject-cff-title"
              className="text-sm font-semibold text-ink-1000"
            >
              {t("reject.dialog_title", { who })}
            </h2>
            <p className="mt-0.5 text-xs text-ink-600">
              {t("reject.dialog_body")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("reject.close_aria")}
            className="rounded-md p-1 text-ink-500 hover:bg-ink-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="block text-xs font-medium text-ink-700">
          {t("reject.reason_label")}
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={4}
          maxLength={2000}
          autoFocus
          placeholder={t("reject.reason_placeholder")}
          className="mt-1 w-full resize-y rounded-lg bg-white px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-rose-400"
        />
        {error ? (
          <p className="mt-1 text-xs text-rose-700">{error}</p>
        ) : (
          <p className="mt-1 text-[11px] text-ink-500">
            {t("reject.reason_hint")}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            {t("reject.cancel")}
          </button>
          <button
            type="submit"
            disabled={mutation.isPending || !reason.trim()}
            className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
          >
            {mutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Ban className="h-3 w-3" />
            )}
            {t("reject.confirm")}
          </button>
        </div>
      </form>
    </div>
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
  // Unassigned is the headline triage state — same amber badge as
  // before. ``is_assigned`` is the backend-computed flag so we don't
  // have to walk the ``assignments`` array on every row.
  if (!row.is_assigned) {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
        <AlertTriangle className="mr-1 h-2.5 w-2.5" />
        {t("badge.unassigned")}
      </span>
    );
  }
  // One link → render its code/name directly so the row reads the
  // same as it did before the M2M migration. Many → fall back to a
  // count chip ("3 projects") and let the detail page surface the
  // full list.
  // ``.length === 1`` doesn't narrow ``[0]`` away from ``undefined``
  // under ``noUncheckedIndexedAccess``; destructure the lookup result
  // and bail to the multi-chip path if for some reason the access
  // misses (it can't here, but the type checker can't see that).
  const single = row.assignments.length === 1 ? row.assignments[0] : null;
  if (single) {
    const project = single.project;
    return (
      <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 ring-1 ring-inset ring-blue-200">
        {t("badge.assigned_to", {
          project: project.code || project.name,
        })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 ring-1 ring-inset ring-blue-200">
      {t("badge.assigned_to_n", { count: row.assignments.length })}
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
