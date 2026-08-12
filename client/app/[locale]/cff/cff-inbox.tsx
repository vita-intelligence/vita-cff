"use client";

import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  Inbox,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

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


type Bucket = "unassigned" | "assigned" | "rejected";


/**
 * Client-side body of the CFF page — 3-column pipeline board.
 *
 * Same shape as ``/finance/payments`` / ``/proposals`` / ``/samples``
 * so operators moving between triage surfaces don't have to
 * relearn the layout. CFFs move left-to-right as decisions land:
 *
 *   New       — untouched triage queue (not assigned, not rejected).
 *   Assigned  — attached to at least one project (or, for RTG rows,
 *               carrying a drafted proposal — the auto-drafted
 *               quote IS the attachment).
 *   Rejected  — declined via the reject action. Card carries the
 *               reason inline so the operator can see at a glance
 *               why we said no.
 *
 * Each column runs its own ``useInfiniteCFFSubmissions`` AND owns
 * its own search input — searching in "New" narrows the New column
 * without touching Assigned or Rejected, so a triager can hunt one
 * lane without losing the counts / rows in the others. Cursor
 * pagination on the backend (existing ``CFFCursorPagination``)
 * means the "millions of rows" case pages just as fast on row 999k
 * as on row 20. Counts are read from each column's own response so
 * the count badge stays in lock-step with that column's search.
 */
export function CFFInbox({
  orgId,
  canAssign,
}: {
  orgId: string;
  canAssign: boolean;
}) {
  const t = useTranslations("cff");

  // Detail view now lives on a dedicated route — the inbox no
  // longer mounts the floating-window modal. Assign / Create-
  // project actions stay inline as modals because they're
  // one-tap actions that shouldn't pull the operator off the
  // inbox queue.
  const [openAssign, setOpenAssign] = useState<CFFSubmissionDto | null>(null);
  const [openCreate, setOpenCreate] = useState<CFFSubmissionDto | null>(null);
  const [openReject, setOpenReject] = useState<CFFSubmissionDto | null>(null);

  return (
    <>
      <section className="mt-6 flex flex-col gap-4">
        <SyncStatusBanner orgId={orgId} t={t} />

        <div className="grid gap-4 lg:grid-cols-3">
          {CFF_BUCKETS.map((cfg) => (
            <CFFBucketColumn
              key={cfg.key}
              cfg={cfg}
              orgId={orgId}
              canAssign={canAssign}
              onAssign={setOpenAssign}
              onCreateProject={setOpenCreate}
              onReject={setOpenReject}
              t={t}
            />
          ))}
        </div>
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


// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------


const CFF_BUCKETS: ReadonlyArray<{
  key: Bucket;
  labelKey: "unassigned_label" | "assigned_label" | "rejected_label";
  hintKey: "unassigned_hint" | "assigned_hint" | "rejected_hint";
  emptyKey: "unassigned" | "assigned" | "rejected";
  accent: string;
  headerIcon: React.ComponentType<{ className?: string }>;
  headerIconTone: string;
}> = [
  {
    key: "unassigned",
    labelKey: "unassigned_label",
    hintKey: "unassigned_hint",
    emptyKey: "unassigned",
    accent: "bg-amber-100 text-amber-800",
    headerIcon: Inbox,
    headerIconTone: "text-amber-700",
  },
  {
    key: "assigned",
    labelKey: "assigned_label",
    hintKey: "assigned_hint",
    emptyKey: "assigned",
    accent: "bg-sky-100 text-sky-800",
    headerIcon: Check,
    headerIconTone: "text-sky-700",
  },
  {
    key: "rejected",
    labelKey: "rejected_label",
    hintKey: "rejected_hint",
    emptyKey: "rejected",
    accent: "bg-rose-100 text-rose-800",
    headerIcon: Ban,
    headerIconTone: "text-rose-700",
  },
];


function CFFBucketColumn({
  cfg,
  orgId,
  canAssign,
  onAssign,
  onCreateProject,
  onReject,
  t,
}: {
  cfg: (typeof CFF_BUCKETS)[number];
  orgId: string;
  canAssign: boolean;
  onAssign: (row: CFFSubmissionDto) => void;
  onCreateProject: (row: CFFSubmissionDto) => void;
  onReject: (row: CFFSubmissionDto) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce per-column so a fast typer only pays for one fetch
  // per pause, not one per keystroke. Independent from sibling
  // columns — each column owns its own search state.
  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedSearch(searchInput.trim()),
      250,
    );
    return () => clearTimeout(handle);
  }, [searchInput]);

  const query = useInfiniteCFFSubmissions({
    orgId,
    state: cfg.key,
    search: debouncedSearch || undefined,
  });

  const rows = useMemo<readonly CFFSubmissionDto[]>(
    () => query.data?.pages.flatMap((p) => p.results) ?? [],
    [query.data],
  );

  // Count comes from this column's own response so it stays scoped
  // to this column's search — narrowing "New" doesn't change the
  // badge on "Rejected".
  const count = query.data?.pages[0]?.counts?.[cfg.key] ?? 0;

  const hasSearch = debouncedSearch.length > 0;
  const Icon = cfg.headerIcon;

  return (
    <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="space-y-3 border-b border-ink-100 p-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Icon className={`h-4 w-4 ${cfg.headerIconTone}`} aria-hidden />
              <h2 className="text-sm font-semibold text-ink-1000">
                {t(`buckets.${cfg.labelKey}`)}
              </h2>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.accent}`}
            >
              {count}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-ink-500">
            {t(`buckets.${cfg.hintKey}`)}
          </p>
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
            aria-hidden
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("filter.search_placeholder")}
            className="h-8 w-full rounded-full border border-ink-200 bg-ink-0 pl-8 pr-8 text-[11px] text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
          />
          {searchInput ? (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              aria-label={t("filter.search_clear")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {query.isPending ? (
          <p className="p-4 text-center text-xs text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            {t("list.loading")}
          </p>
        ) : query.isError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            {t("errors.wix_cff_unknown_error")}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-ink-500">
            {hasSearch ? t("empty.search") : t(`empty.${cfg.emptyKey}`)}
          </p>
        ) : (
          rows.map((row) => (
            <CFFRow
              key={row.id}
              row={row}
              orgId={orgId}
              onAssign={canAssign ? () => onAssign(row) : undefined}
              onCreateProject={canAssign ? () => onCreateProject(row) : undefined}
              onReject={canAssign ? () => onReject(row) : undefined}
              t={t}
            />
          ))
        )}

        {query.hasNextPage ? (
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            {query.isFetchingNextPage ? (
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            ) : null}
            {t("list.load_more")}
          </button>
        ) : null}
      </div>
    </article>
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

  const receivedIso = new Date(
    row.wix_created_date || row.imported_at,
  ).toISOString();
  const receivedRel = format.relativeTime(
    new Date(row.wix_created_date || row.imported_at),
    now,
  );

  return (
    <article className="flex flex-col gap-2 rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm">
      {/* Header — customer + status chip. Title truncates so long
          names don't push the chip off; chip is ``shrink-0`` so it
          never gets compressed to unreadable width. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {customerName}
          </p>
          {previewFields.company ? (
            <p className="mt-0.5 truncate text-[11px] text-ink-600">
              {previewFields.company}
            </p>
          ) : null}
          {previewFields.email && previewFields.email !== customerName ? (
            <p className="truncate text-[11px] text-ink-500">
              {previewFields.email}
            </p>
          ) : null}
        </div>
        <div className="shrink-0">
          <StatusChip
            status={
              row.wix_status ||
              (row.provenance === "portal" ? "PORTAL" : "UNKNOWN")
            }
            t={t}
          />
        </div>
      </div>

      {/* Assignment badge on its own line so it can wrap gracefully
          without fighting the header for width. */}
      <div className="min-w-0">
        <AssignmentBadge row={row} t={t} />
      </div>

      {/* Received-when line — relative + short id. Full ISO in
          ``title`` for audit / timezone edge cases. */}
      <p
        className="truncate text-[10px] text-ink-500"
        title={receivedIso}
      >
        {t("list.received", { when: receivedRel })}
        <span className="ml-1.5 font-mono text-ink-400">
          #{row.id.slice(0, 8)}
        </span>
      </p>

      {/* Rejected rows carry their reason inline so the operator
          browsing the Rejected tab can see at a glance why we said
          no without opening the detail page. */}
      {row.is_rejected && row.rejection_reason ? (
        <p className="rounded-lg bg-rose-50 px-2 py-1 text-[10px] text-rose-900 ring-1 ring-inset ring-rose-200">
          <span className="font-semibold">{t("reject.reason_label")}:</span>{" "}
          <span className="whitespace-pre-wrap">{row.rejection_reason}</span>
          {row.rejected_by ? (
            <span className="ml-1 text-rose-700">
              — {row.rejected_by.full_name}
            </span>
          ) : null}
        </p>
      ) : null}

      {/* Actions row — bottom-anchored, wraps if too wide for the
          column. Buttons stay compact so common cases fit on one
          line even in narrow columns. */}
      <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5">
        {row.is_rejected ? (
          <button
            type="button"
            disabled={unrejectMutation.isPending}
            onClick={() =>
              unrejectMutation.mutate({ submissionId: row.id })
            }
            className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-2.5 py-1 text-[10px] font-semibold text-ink-700 hover:bg-ink-50 disabled:opacity-60"
          >
            {unrejectMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            {t("reject.undo")}
          </button>
        ) : row.submission_kind === "ready_to_go" &&
          row.drafted_proposal_id ? (
          // RTG rows never take the project attachment path — the
          // auto-drafted proposal IS the deliverable. Deep-link
          // into the quote so the operator lands on the artefact
          // that actually needs their attention.
          <>
            {onReject ? (
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-2.5 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50"
              >
                <Ban className="h-3 w-3" />
                {t("reject.open")}
              </button>
            ) : null}
            <Link
              href={`/proposals/${row.drafted_proposal_id}`}
              prefetch={false}
              className="inline-flex items-center gap-1 rounded-full bg-orange-500 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-orange-600"
            >
              {t("rtg_actions.view_proposal")}
            </Link>
          </>
        ) : (
          <>
            {onReject && !row.is_assigned ? (
              <button
                type="button"
                onClick={onReject}
                className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-2.5 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50"
              >
                <Ban className="h-3 w-3" />
                {t("reject.open")}
              </button>
            ) : null}
            {onAssign ? (
              <button
                type="button"
                onClick={onAssign}
                className="inline-flex items-center rounded-full border border-ink-200 px-2.5 py-1 text-[10px] font-semibold text-ink-700 hover:bg-ink-50"
              >
                {t("assign.open")}
              </button>
            ) : null}
            {onCreateProject ? (
              <button
                type="button"
                onClick={onCreateProject}
                className="inline-flex items-center rounded-full bg-orange-500 px-2.5 py-1 text-[10px] font-semibold text-white hover:bg-orange-600"
              >
                {t("create_project.open")}
              </button>
            ) : null}
          </>
        )}
        <Link
          href={`/cff/${row.id}`}
          prefetch={false}
          className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-2.5 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900"
        >
          {t("list.open")}
          <LinkIconSlot
            idleIcon={<ChevronRight className="h-3 w-3" />}
            spinnerSizeClassName="h-3 w-3"
          />
        </Link>
      </div>
    </article>
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
  // Portal-provenance submissions carry no Wix status, so callers
  // may pass ``null``/``""`` here. Normalise so ``t()`` can't miss.
  const key = status || "UNKNOWN";
  const tone =
    key === "CONFIRMED"
      ? "bg-success/10 text-success ring-success/20"
      : key === "PORTAL"
        ? "bg-blue-100 text-blue-700 ring-blue-200"
        : key === "UNKNOWN"
          ? "bg-ink-100 text-ink-600 ring-ink-200"
          : "bg-warning/10 text-warning ring-warning/20";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${tone}`}
    >
      {t(`status.${key as "CONFIRMED"}`)}
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
      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
        <AlertTriangle className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{t("badge.unassigned")}</span>
      </span>
    );
  }
  // Ready-to-Go submissions never get a project link — the
  // auto-drafted proposal IS the attachment. Show it first (before
  // the project-based chips) so the operator immediately knows the
  // quote is already in the drawer and there's nothing left to
  // triage on this row.
  if (
    row.submission_kind === "ready_to_go" &&
    row.drafted_proposal_code
  ) {
    return (
      <span className="inline-flex max-w-full items-center truncate rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
        <span className="truncate">
          {t("badge.drafted_as", {
            proposal: row.drafted_proposal_code,
          })}
        </span>
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
      <span className="inline-flex max-w-full items-center truncate rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 ring-1 ring-inset ring-blue-200">
        <span className="truncate">
          {t("badge.assigned_to", {
            project: project.code || project.name,
          })}
        </span>
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 ring-1 ring-inset ring-blue-200">
      {t("badge.assigned_to_n", { count: row.assignments.length })}
    </span>
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
