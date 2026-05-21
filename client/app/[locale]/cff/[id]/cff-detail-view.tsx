"use client";

/**
 * Client-side body of the standalone CFF detail page.
 *
 * Layout:
 *
 *   * The CFF body (header strip + customer responses) takes the
 *     full page width — no side column.
 *   * The discussion thread lives in a STICKY BOTTOM DOCK that's
 *     pinned to the viewport and follows the operator while they
 *     scroll the CFF responses. The dock starts expanded so the
 *     chat is the centre of attention; the operator can collapse
 *     it down to a single header bar if they want more reading
 *     room. Collapse state persists across navigations via
 *     ``localStorage`` so coming back to a CFF feels like
 *     resuming the conversation, not re-opening it.
 *
 * The list page's modal stays for the spec / project quick-view
 * surfaces only — the CFF inbox now navigates here directly when
 * the operator hits "Open" on a row.
 */

import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Mail,
  MessageSquare,
  Phone,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { Link } from "@/i18n/navigation";
import {
  useCFFFieldLabels,
  useCFFSubmission,
} from "@/services/cff-submissions";


//: Persisted collapse state — survives navigations + reloads so the
//: dock state matches what the operator left it at last time.
const DOCK_STATE_KEY = "vita-npd:cff-detail:dock-collapsed";

//: Height of the dock's header bar (always visible). Drives both
//: the collapsed-height of the dock itself and the page's
//: bottom-padding so the last response row stays scrollable into
//: view even when the dock is collapsed.
const DOCK_HEADER_HEIGHT_PX = 56;

//: Expanded dock height. Bumped from 55vh after operators flagged
//: it as too cramped to read more than a couple of messages without
//: scrolling — the CFF page is chat-first in practice, so we trade
//: a sliver of the page's top strip for a usable conversation
//: surface. The page header / quick-contact row still peek above
//: the dock so the operator can re-orient without collapsing it.
const DOCK_EXPANDED_VH = 75;


export function CFFDetailView({
  orgId,
  submissionId,
  currentUserId,
}: {
  orgId: string;
  submissionId: string;
  currentUserId: string;
}) {
  const t = useTranslations("cff");
  const format = useFormatter();
  const now = useNow();
  const cffQuery = useCFFSubmission(orgId, submissionId);
  const labelsQuery = useCFFFieldLabels(orgId);

  // Dock collapse state. Defaults to OPEN (chat is the point of
  // the page), then hydrates from ``localStorage`` so a user who
  // last left it closed gets that state back. SSR + first paint
  // both use the default to avoid a hydration mismatch.
  const [dockCollapsed, setDockCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DOCK_STATE_KEY);
      if (stored === "1") setDockCollapsed(true);
      if (stored === "0") setDockCollapsed(false);
    } catch {
      // SSR / private mode / quota — fall through to default.
    }
  }, []);
  const toggleDock = useCallback(() => {
    setDockCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(DOCK_STATE_KEY, next ? "1" : "0");
      } catch {
        // Best-effort persistence.
      }
      return next;
    });
  }, []);

  // Hotkey: ``Esc`` collapses the dock when expanded. Lets a power
  // user dismiss the chat to read the CFF without reaching for the
  // mouse. No-op when collapsed.
  useEffect(() => {
    if (dockCollapsed) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDockCollapsed(true);
        try {
          window.localStorage.setItem(DOCK_STATE_KEY, "1");
        } catch {
          /* swallow */
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dockCollapsed]);

  // Labels payload is keyed by form id; resolve once we know
  // which form this submission came from. Empty fallback so a
  // missing labels payload still renders the raw slugs rather
  // than nothing.
  const labelMap = useMemo(() => {
    const submission = cffQuery.data;
    if (!submission) return {} as Record<string, string>;
    return (
      labelsQuery.data?.field_labels_by_form?.[submission.wix_form_id] ?? {}
    );
  }, [cffQuery.data, labelsQuery.data]);

  // Reserve viewport space so the last CFF row doesn't get
  // permanently hidden behind the dock. ``vh``-based when
  // expanded so the math stays in sync with the fixed dock; px
  // when collapsed so the header bar's height is precise.
  const bodyPaddingBottom = dockCollapsed
    ? `${DOCK_HEADER_HEIGHT_PX + 16}px`
    : `calc(${DOCK_EXPANDED_VH}vh + 16px)`;

  if (cffQuery.isLoading) {
    return (
      <section className="mt-8 text-sm text-ink-500">
        {t("detail.loading")}
      </section>
    );
  }

  if (cffQuery.isError || !cffQuery.data) {
    return (
      <section
        role="alert"
        className="mt-8 flex items-start gap-2 rounded-2xl bg-danger/10 p-4 text-sm text-danger ring-1 ring-inset ring-danger/20"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-col gap-2">
          <p className="font-medium">{t("detail.load_failed")}</p>
          <Link
            href="/cff"
            className="inline-flex items-center gap-1 text-xs text-danger underline-offset-2 hover:underline"
          >
            <ArrowLeft className="h-3 w-3" />
            {t("detail.back_to_inbox")}
          </Link>
        </div>
      </section>
    );
  }

  const submission = cffQuery.data;
  const submissions =
    (submission.raw_payload?.submissions as Record<string, unknown> | undefined)
    ?? {};

  const preview = extractHeaderPreview(submissions);

  // Stable iteration order — JSON parsers preserve insertion order
  // in every modern engine, which lines up with the Wix-side form
  // layout the customer filled in. Walking ``Object.entries``
  // keeps the customer's narrative flow.
  const fieldEntries = Object.entries(submissions).filter(
    ([, value]) => !isEmpty(value),
  );

  return (
    <>
      <div style={{ paddingBottom: bodyPaddingBottom }}>
        <section className="mt-8 flex flex-col gap-2">
          <Link
            href="/cff"
            className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 transition-colors hover:text-ink-1000"
          >
            <ArrowLeft className="h-3 w-3" />
            {t("detail.back_to_inbox")}
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
                {preview.name || t("detail.title")}
              </h1>
              {preview.company ? (
                <p className="text-sm text-ink-700">{preview.company}</p>
              ) : null}
              <p className="text-xs text-ink-500">
                {t("list.received", {
                  when: format.relativeTime(
                    new Date(submission.wix_created_date),
                    now,
                  ),
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill status={submission.wix_status} t={t} />
              {/* Linked-project chips. Each assignment renders its own
                  pill linking to that project — the M2M lets one CFF
                  fan out to multiple workspaces and the operator
                  needs visible jump-off points for every one of them.
                  Falls back to the amber "unassigned" pill when the
                  CFF is still in triage. */}
              {submission.is_assigned ? (
                submission.assignments.map((assignment) => (
                  <Link
                    key={assignment.project.id}
                    href={`/formulations/${assignment.project.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-900 ring-1 ring-inset ring-blue-200 hover:bg-blue-100"
                  >
                    <ExternalLink className="h-3 w-3" />
                    {t("badge.assigned_to", {
                      project:
                        assignment.project.code || assignment.project.name,
                    })}
                  </Link>
                ))
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-200">
                  {t("badge.unassigned")}
                </span>
              )}
            </div>
          </div>

          {preview.email || preview.phone ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {preview.email ? (
                <a
                  href={`mailto:${preview.email}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
                >
                  <Mail className="h-3 w-3 text-ink-500" />
                  {preview.email}
                </a>
              ) : null}
              {preview.phone ? (
                <a
                  href={`tel:${preview.phone.replace(/\s+/g, "")}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
                >
                  <Phone className="h-3 w-3 text-ink-500" />
                  {preview.phone}
                </a>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* Customer responses — full page width. The thread used to
            sit in a side column; the new sticky dock moves it down
            so the responses can stretch and the operator can read
            multi-paragraph briefs without horizontal compression. */}
        <article className="mt-8 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-ink-200">
          <header className="mb-4 flex items-center justify-between border-b border-ink-100 pb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500">
              {t("detail.section_responses")}
            </h2>
          </header>
          {fieldEntries.length === 0 ? (
            <p className="text-sm text-ink-500">
              {t("detail.no_responses")}
            </p>
          ) : (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-[220px_minmax(0,1fr)]">
              {fieldEntries.map(([slug, value]) => (
                <FieldRow
                  key={slug}
                  slug={slug}
                  value={value}
                  label={labelMap[slug] || humanise(slug)}
                />
              ))}
            </dl>
          )}
        </article>
      </div>

      {/* ---- Sticky bottom comments dock ----------------------------
       *  Pinned to the viewport so it follows the operator while
       *  they scroll the response list. Collapsing it leaves only
       *  the header bar visible — a quick way to clear screen real-
       *  estate without losing context (the unread count stays on
       *  the bar, and the inbox bell still pings). Sits at ``z-40``,
       *  one layer below the portal toast stack so an incoming-
       *  comment toast still pops above it. */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white shadow-[0_-6px_18px_rgba(15,23,42,0.06)] transition-[height] duration-200 ease-out"
        style={{
          height: dockCollapsed
            ? `${DOCK_HEADER_HEIGHT_PX}px`
            : `${DOCK_EXPANDED_VH}vh`,
        }}
      >
        <div className="mx-auto flex h-full max-w-7xl flex-col px-4 sm:px-6 md:px-10">
          <button
            type="button"
            onClick={toggleDock}
            aria-expanded={!dockCollapsed}
            aria-controls="cff-comments-dock-body"
            className="flex w-full shrink-0 items-center justify-between border-b border-ink-100 py-3 text-left transition-colors hover:bg-ink-50"
            style={{ height: `${DOCK_HEADER_HEIGHT_PX}px` }}
          >
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/10 text-orange-700 ring-1 ring-inset ring-orange-500/30">
                <MessageSquare className="h-3.5 w-3.5" />
              </span>
              <span className="text-sm font-semibold text-ink-1000">
                {t("detail.dock_title")}
              </span>
              <span className="text-xs text-ink-500">
                {t("detail.dock_subtitle")}
              </span>
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-500">
              {dockCollapsed ? (
                <>
                  {t("detail.dock_open")}
                  <ChevronUp className="h-4 w-4" />
                </>
              ) : (
                <>
                  {t("detail.dock_close")}
                  <ChevronDown className="h-4 w-4" />
                </>
              )}
            </span>
          </button>

          {/* The CommentsPanel is always mounted (so the WS stays
              connected + the unread count stays current); only the
              container scrolls / shrinks. ``hidden`` when collapsed
              keeps screenreaders out of the inert region but lets
              the panel re-show instantly without re-fetching when
              the operator pops it back open. */}
          <div
            id="cff-comments-dock-body"
            className={`min-h-0 flex-1 overflow-hidden ${
              dockCollapsed ? "hidden" : ""
            }`}
          >
            <CommentsPanel
              orgId={orgId}
              entityKind="cff_submission"
              entityId={submissionId}
              canRead={true}
              canWrite={true}
              canModerate={false}
              currentUserId={currentUserId}
              layout="fill"
            />
          </div>
        </div>
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// Field rendering — keep simple. The modal handles the rich
// section / file / address rendering; here we just need labelled
// rows the team can read while chatting.
// ---------------------------------------------------------------------------


function FieldRow({
  slug,
  value,
  label,
}: {
  slug: string;
  value: unknown;
  label: string;
}) {
  return (
    <>
      <dt className="text-xs font-medium text-ink-500" title={slug}>
        {label}
      </dt>
      <dd className="text-sm text-ink-1000">{renderValue(value)}</dd>
    </>
  );
}


function renderValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return <span className="whitespace-pre-line">{value}</span>;
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((v) => typeof v === "string")) {
      return (value as string[]).join(", ");
    }
    // Wix file-upload arrays — each entry is a dict with
    // ``displayName`` / ``fileId`` / ``url`` / ``fileType``.
    // Without this branch the page would dump raw JSON ("Your
    // Signature: [{"displayName": "...", "fileId": "..."}]"),
    // which is what triggered the redesign. Mirrors the
    // file-row treatment the modal uses so the two surfaces
    // stay visually consistent.
    if (value.every(isFileEntry)) {
      return (
        <ul className="flex flex-col gap-2">
          {(value as FileEntry[]).map((file, i) => (
            <li key={file.fileId ?? `${file.displayName ?? "file"}-${i}`}>
              <FileEntryCard file={file} />
            </li>
          ))}
        </ul>
      );
    }
    return (
      <span className="font-mono text-xs text-ink-700">
        {JSON.stringify(value)}
      </span>
    );
  }
  if (typeof value === "object") {
    const parts = Object.values(value as Record<string, unknown>)
      .filter((v) => typeof v === "string" && v.trim())
      .join(", ");
    if (parts) return parts;
    return (
      <span className="font-mono text-xs text-ink-700">
        {JSON.stringify(value)}
      </span>
    );
  }
  return String(value);
}


// ---------------------------------------------------------------------------
// File entries (Wix uploads)
// ---------------------------------------------------------------------------


interface FileEntry {
  displayName?: string;
  fileId?: string;
  url?: string | null;
  fileType?: string;
  imported?: boolean;
}


function isFileEntry(v: unknown): v is FileEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  // Recognise on any one of the three load-bearing keys — Wix
  // sometimes omits ``displayName`` for files dragged in without
  // a name, and sometimes omits ``fileType`` for legacy uploads.
  return "displayName" in o || "fileId" in o || "fileType" in o;
}


function FileEntryCard({ file }: { file: FileEntry }) {
  const fileType = (file.fileType ?? "").toLowerCase();
  const isImage = fileType.startsWith("image/");
  const Icon = isImage ? ImageIcon : FileText;
  const label = file.displayName || file.fileId || "Untitled file";
  // ``url`` from Wix is ``null`` when the file lives behind their
  // private storage and they haven't issued a signed link. We
  // render the same card shape either way so the page doesn't
  // flip layout based on what the integration happened to share —
  // the link version just becomes clickable.
  const hasUrl = Boolean(file.url);

  const inner = (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
          isImage
            ? "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200"
            : "bg-ink-100 text-ink-700 ring-1 ring-inset ring-ink-200"
        }`}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-ink-1000">
          {label}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-ink-500">
          {file.fileType ? <span>{file.fileType}</span> : null}
          {file.fileType && hasUrl ? <span aria-hidden>·</span> : null}
          {hasUrl ? (
            <span>Click to open</span>
          ) : (
            <span title="Wix did not include a public download URL for this file.">
              Stored on Wix · no download link
            </span>
          )}
        </span>
      </span>
    </span>
  );

  // Inline thumbnail for images with a usable URL — gives the
  // operator instant visual confirmation (especially load-bearing
  // for signature fields) without leaving the page.
  const thumbnail =
    isImage && hasUrl ? (
      <img
        src={file.url as string}
        alt={label}
        className="h-12 w-12 shrink-0 rounded-md object-cover ring-1 ring-inset ring-ink-200"
      />
    ) : null;

  if (hasUrl) {
    return (
      <a
        href={file.url as string}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
      >
        {thumbnail}
        {inner}
        <ExternalLink
          className="h-3.5 w-3.5 shrink-0 text-ink-400"
          aria-hidden="true"
        />
      </a>
    );
  }
  return (
    <span className="flex items-center gap-3 rounded-xl bg-ink-50/60 p-3 ring-1 ring-inset ring-ink-200">
      {inner}
    </span>
  );
}


function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isEmpty);
  }
  return false;
}


function humanise(slug: string): string {
  // ``first_name_a83b`` → "First name". Strips trailing 4-char
  // hashes Wix appends + replaces underscores with spaces.
  const stripped = slug.replace(/_[a-z0-9]{4}$/, "").replace(/_/g, " ");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}


interface HeaderPreview {
  name: string;
  company: string;
  email: string;
  phone: string;
}


function extractHeaderPreview(
  submissions: Record<string, unknown>,
): HeaderPreview {
  const findByPrefix = (prefix: string): string => {
    for (const [key, value] of Object.entries(submissions)) {
      if (key.startsWith(prefix) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    return "";
  };
  const first = findByPrefix("first_name");
  const last = findByPrefix("last_name");
  const full = findByPrefix("full_name") || findByPrefix("name");
  const composed = [first, last].filter(Boolean).join(" ").trim();
  return {
    name: composed || full || "",
    company:
      findByPrefix("company") ||
      findByPrefix("brand") ||
      findByPrefix("organization"),
    email: findByPrefix("email"),
    phone: findByPrefix("phone"),
  };
}


function StatusPill({
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
