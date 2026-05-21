"use client";

/**
 * Read-only detail view for one CFF submission.
 *
 * Renders as a **detached floating window** (draggable + resizable)
 * rather than a centered modal so a project / spec-sheet operator
 * can keep the CFF visible while editing the page underneath.
 * Position and size persist to ``localStorage`` so the window
 * stays where the user last put it across navigations and reloads.
 *
 * Structure (top → bottom):
 *
 * 1. **Header** — customer name + company, status pill, assignment
 *    badge, submitted-time relative stamp. Doubles as the drag
 *    handle.
 * 2. **Quick contact strip** — email + phone as clickable
 *    ``mailto:`` / ``tel:`` chips so the triager can reach the
 *    customer in one click.
 * 3. **Sectioned responses** — fields are heuristically bucketed by
 *    slug into Customer / Product brief / Commercial / Attachments /
 *    Other. Each bucket renders as its own card. Within a card,
 *    short single-line answers go into a 2-column grid and long
 *    answers (with newlines or > 100 chars) get their own full-width
 *    block so multi-paragraph free text stays readable.
 * 4. **Source metadata** — Wix status, submission ID, imported
 *    timestamp. Collapsed under a subtle footer because it's
 *    rarely what triage cares about.
 * 5. **Action footer** — Assign / Unassign + Close.
 *
 * Render rules per value type:
 *
 * * ``object`` with address-like keys → multi-line address block.
 * * ``array`` of strings → comma list.
 * * ``array`` of file objects → download links (image preview when
 *   the MIME is recognisable as an image).
 * * string with newlines OR length > 120 chars → full-width text
 *   block in a softer card style.
 * * everything else → inline value in a definition list row.
 *
 * Empty / "None" answers are hidden by default — they're filler
 * the customer left blank and they'd otherwise drown the useful
 * fields. A toggle at the bottom of each section reveals them.
 */

import {
  ExternalLink,
  FileText,
  GripHorizontal,
  Image as ImageIcon,
  Link2,
  Mail,
  Phone,
  Sparkles,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import type { CFFSubmissionDto } from "@/services/cff-submissions";


// ---------------------------------------------------------------------------
// Floating-window state plumbing
// ---------------------------------------------------------------------------
//
// Stored shape: ``{x, y, w, h}`` in viewport pixels. Position is
// top-left corner of the window. We clamp every read + write so a
// previously-saved rect from a larger monitor doesn't open
// off-screen on a laptop today.

interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RECT_STORAGE_KEY = "cff-detail-window-rect";

//: Tight enough that the section cards stay readable, loose enough
//: that the user can still get the page underneath visible.
const MIN_WIDTH = 360;
const MIN_HEIGHT = 360;

//: Default window size on first open. Falls back smaller on
//: laptops; the viewport-aware ``defaultRect`` below shrinks
//: further if the window is small.
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 760;

//: How much of the header must stay inside the viewport so the
//: window can always be grabbed and dragged back. Without this a
//: rage-drag off-screen would orphan the window — losing it to
//: the user's mental "closed" model even though it's still mounted.
const DRAG_VISIBLE_PX = 80;

function defaultRect(): WindowRect {
  if (typeof window === "undefined") {
    return { x: 80, y: 80, w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };
  }
  const w = Math.min(DEFAULT_WIDTH, window.innerWidth - 32);
  const h = Math.min(DEFAULT_HEIGHT, window.innerHeight - 32);
  return {
    x: Math.max(16, Math.round((window.innerWidth - w) / 2)),
    y: Math.max(16, Math.round((window.innerHeight - h) / 2)),
    w,
    h,
  };
}

function clampRect(rect: WindowRect): WindowRect {
  if (typeof window === "undefined") return rect;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_WIDTH, Math.min(rect.w, Math.max(MIN_WIDTH, vw - 16)));
  const h = Math.max(MIN_HEIGHT, Math.min(rect.h, Math.max(MIN_HEIGHT, vh - 16)));
  // Allow the user to push the window mostly off-screen on either
  // side — but always keep ``DRAG_VISIBLE_PX`` of the header
  // visible so it can be grabbed back. ``y`` is bounded so the
  // header stays at-or-below the top of the viewport (we never
  // let it slip under a fixed nav).
  const x = Math.max(DRAG_VISIBLE_PX - w, Math.min(rect.x, vw - DRAG_VISIBLE_PX));
  const y = Math.max(0, Math.min(rect.y, vh - 40));
  return { x, y, w, h };
}

function loadRect(): WindowRect {
  if (typeof window === "undefined") return defaultRect();
  try {
    const raw = window.localStorage.getItem(RECT_STORAGE_KEY);
    if (!raw) return defaultRect();
    const parsed = JSON.parse(raw) as Partial<WindowRect>;
    if (
      typeof parsed.x === "number" && typeof parsed.y === "number"
      && typeof parsed.w === "number" && typeof parsed.h === "number"
    ) {
      return clampRect(parsed as WindowRect);
    }
  } catch {
    // Corrupt JSON / quota exceeded / SSR — fall through to
    // default. Never block opening the window on storage hiccups.
  }
  return defaultRect();
}


export function CFFDetailModal({
  orgId,
  submission,
  fieldLabels,
  canAssign,
  onClose,
  onAssign,
  onCreateProject,
}: {
  orgId: string;
  submission: CFFSubmissionDto;
  /** ``{form_id: {slug: label}}`` from
   *  :func:`useCFFFieldLabels`. */
  fieldLabels: Record<string, Record<string, string>>;
  canAssign: boolean;
  onClose: () => void;
  onAssign: () => void;
  onCreateProject: () => void;
}) {
  void orgId;
  const t = useTranslations("cff");
  const format = useFormatter();
  const now = useNow();

  // -- Floating-window state ----------------------------------------
  // ``rect`` is the source of truth for position + size; ``drag`` is
  // set while the user is pulling the header; ``resizeStart`` is set
  // while pulling the bottom-right corner. Both clear on pointerup.
  // We persist ``rect`` to ``localStorage`` so the user's preferred
  // size and corner placement survive navigations + reloads.
  const [rect, setRect] = useState<WindowRect>(() => defaultRect());
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const resizeStartRef = useRef<
    { x: number; y: number; w: number; h: number } | null
  >(null);
  const [isInteracting, setIsInteracting] = useState(false);

  // Hydrate from ``localStorage`` AFTER the first render so SSR and
  // CSR markup match (the default rect is identical on both sides;
  // only the post-mount restore differs).
  useEffect(() => {
    setRect(loadRect());
  }, []);

  // Persist whenever the rect settles. Skipping the write while the
  // pointer is still down keeps us from spamming ``localStorage`` 60
  // times per second during a drag.
  useEffect(() => {
    if (isInteracting) return;
    try {
      window.localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(rect));
    } catch {
      // Storage quota / private mode — silently drop. The rect
      // stays valid in-memory for the rest of this session.
    }
  }, [rect, isInteracting]);

  // Reclamp on viewport resize so a window dragged to the corner
  // doesn't escape when the user shrinks the browser.
  useEffect(() => {
    const onResize = () => setRect((prev) => clampRect(prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Global pointer move / up while a drag OR a resize is in flight.
  // Attaching at ``window`` (not the element) means the gesture
  // survives the cursor briefly leaving the window — typing on a
  // fast drag would otherwise "drop" the window mid-motion.
  useEffect(() => {
    if (!isInteracting) return;
    const onMove = (event: PointerEvent) => {
      const dragOffset = dragOffsetRef.current;
      const resizeStart = resizeStartRef.current;
      if (dragOffset) {
        setRect((prev) =>
          clampRect({
            ...prev,
            x: event.clientX - dragOffset.x,
            y: event.clientY - dragOffset.y,
          }),
        );
      } else if (resizeStart) {
        setRect((prev) =>
          clampRect({
            ...prev,
            w: resizeStart.w + (event.clientX - resizeStart.x),
            h: resizeStart.h + (event.clientY - resizeStart.y),
          }),
        );
      }
    };
    const onUp = () => {
      dragOffsetRef.current = null;
      resizeStartRef.current = null;
      setIsInteracting(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [isInteracting]);

  const startDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Don't hijack pointerdowns on the close button or future
    // interactive controls placed in the header.
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, [data-no-drag]")) return;
    dragOffsetRef.current = {
      x: event.clientX - rect.x,
      y: event.clientY - rect.y,
    };
    setIsInteracting(true);
  }, [rect.x, rect.y]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.stopPropagation();
      resizeStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        w: rect.w,
        h: rect.h,
      };
      setIsInteracting(true);
    },
    [rect.w, rect.h],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const labels = fieldLabels[submission.wix_form_id] ?? {};
  const submissions =
    (submission.raw_payload?.submissions as Record<string, unknown> | undefined)
    ?? {};

  // -- Top-of-modal "who is this" header data ------------------------
  const customerName = composeName(submissions);
  const company = pickFirstString(submissions, [
    "company_name_as_per_customer_account_form",
    "company_name",
    "company",
    "brand",
    "organization",
  ]);
  const email = pickFirstString(submissions, ["email"]);
  const phone = pickFirstString(submissions, ["phone"]);

  // -- Bucketize remaining fields ------------------------------------
  // ``handledSlugs`` is everything the header already rendered so we
  // don't double-render it inside the Customer section.
  const handledSlugs = useMemo(() => {
    const s = new Set<string>();
    // Name + email + phone are pulled into the header strip — keep
    // them OUT of the Customer card to avoid a redundant row.
    addBySlugPrefix(submissions, s, [
      "first_name",
      "last_name",
      "full_name",
      "email",
      "phone",
    ]);
    return s;
  }, [submissions]);

  const sections = useMemo(
    () => bucketize(submissions, handledSlugs),
    [submissions, handledSlugs],
  );

  return (
    <div
      role="dialog"
      aria-labelledby="cff-detail-title"
      // Detached floating window: no backdrop, no full-screen
      // container. Sits above page chrome (``z-50``) but leaves the
      // page beneath fully interactive. Inline position + size is
      // driven by ``rect`` so the user can drag + resize freely.
      className="fixed z-50 flex flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-ink-200"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        // Suppress text selection while a drag/resize gesture is
        // active. Without this the cursor's motion across the page
        // selects copy underneath and the gesture feels "sticky".
        userSelect: isInteracting ? "none" : undefined,
        touchAction: "none",
      }}
    >
      {/* ---- Header (drag handle) ---- */}
      <header
        onPointerDown={startDrag}
        className="flex cursor-grab items-start justify-between gap-4 border-b border-ink-100 bg-white px-6 py-4 active:cursor-grabbing"
      >
        <div className="min-w-0 flex flex-1 items-start gap-2">
          <GripHorizontal
            className="mt-1 h-4 w-4 shrink-0 text-ink-400"
            aria-hidden="true"
          />
          <div className="min-w-0 flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="cff-detail-title"
                className="truncate text-base font-semibold text-ink-1000"
              >
                {customerName || t("detail.title")}
              </h2>
              <StatusPill status={submission.wix_status} t={t} />
            </div>
            {company ? (
              <p className="truncate text-sm text-ink-700">{company}</p>
            ) : null}
            <p className="text-[11px] text-ink-500">
              {t("list.received", {
                when: format.relativeTime(
                  new Date(submission.wix_created_date),
                  now,
                ),
              })}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" data-no-drag>
          {/* Escape hatch to the standalone CFF page. The page is
              the comments-first surface where the team can have a
              durable discussion thread linked into the messenger
              inbox; the modal stays the rich triage view. Opens in
              a new tab so the operator's modal-driven flow is not
              interrupted. */}
          <Link
            href={`/cff/${submission.id}`}
            target="_blank"
            rel="noopener noreferrer"
            title={t("detail.open_full_page")}
            aria-label={t("detail.open_full_page")}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {t("detail.open_full_page")}
            </span>
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("detail.close")}
            className="rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

        {/* ---- Body ---- */}
        <div className="flex-1 overflow-y-auto bg-ink-50 px-6 py-5">
          {/* Assignment ribbon — renders one blue chip per linked
              project (the M2M lets a single CFF fan out to many
              workspaces), or the amber "still in triage" banner when
              the assignment set is empty. The dedicated assign modal
              is the place for per-link detach; here we just surface
              the current state at a glance. */}
          {submission.is_assigned ? (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {submission.assignments.map((assignment) => (
                <span
                  key={assignment.project.id}
                  className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-900 ring-1 ring-inset ring-blue-200"
                >
                  {t("badge.assigned_to", {
                    project:
                      assignment.project.code || assignment.project.name,
                  })}
                </span>
              ))}
            </div>
          ) : (
            <div className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
              {t("badge.unassigned")}
            </div>
          )}

          {/* Quick-contact strip */}
          {email || phone ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {email ? (
                <a
                  href={`mailto:${email}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
                >
                  <Mail className="h-3 w-3 text-ink-500" />
                  {email}
                </a>
              ) : null}
              {phone ? (
                <a
                  href={`tel:${phone.replace(/\s+/g, "")}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
                >
                  <Phone className="h-3 w-3 text-ink-500" />
                  {phone}
                </a>
              ) : null}
            </div>
          ) : null}

          {/* Sectioned form responses */}
          <div className="flex flex-col gap-4">
            {sections.map((section) =>
              section.entries.length === 0 ? null : (
                <SectionCard
                  key={section.key}
                  title={t(`detail.section_${section.key}` as "section_customer")}
                  entries={section.entries}
                  labels={labels}
                />
              ),
            )}
          </div>

          {/* Source meta — always last, dimmer */}
          <details className="mt-6 rounded-xl bg-white p-3 ring-1 ring-ink-200">
            <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wider text-ink-500">
              {t("detail.section_meta")}
            </summary>
            <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-[140px_minmax(0,1fr)]">
              <dt className="text-ink-500">{t("detail.wix_status")}</dt>
              <dd className="text-ink-1000">
                {t(`status.${submission.wix_status as "CONFIRMED"}`)}
              </dd>
              <dt className="text-ink-500">{t("detail.wix_created")}</dt>
              <dd className="text-ink-1000">
                {format.dateTime(new Date(submission.wix_created_date), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </dd>
              <dt className="text-ink-500">
                {t("detail.imported_at", { when: "" }).trim() || "Imported"}
              </dt>
              <dd className="text-ink-1000">
                {format.relativeTime(new Date(submission.imported_at), now)}
              </dd>
              <dt className="text-ink-500">Wix ID</dt>
              <dd className="break-all font-mono text-[11px] text-ink-700">
                {submission.wix_submission_id}
              </dd>
            </dl>
          </details>
        </div>

        {/* ---- Footer ---- */}
        <footer className="flex items-center justify-end gap-2 border-t border-ink-100 bg-white px-6 py-3">
          {canAssign ? (
            <>
              {/* Both triage actions stay visible regardless of
                  current assignment state. Under the M2M model a CFF
                  can spawn additional projects or be wired into more
                  existing ones at any point — hiding the buttons
                  after the first link is created would lock the
                  triager out of that follow-up path. */}
              <button
                type="button"
                onClick={onAssign}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
              >
                <Link2 className="h-3.5 w-3.5" />
                {t("assign.open")}
              </button>
              {/* Primary path: spin up the project + auto-assign
                  the sales person from the CFF. */}
              <button
                type="button"
                onClick={onCreateProject}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t("create_project.open")}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            {t("detail.close")}
          </button>
        </footer>
        {/* Resize handle (bottom-right). Sits above all other
            content so it remains grabbable even when the footer
            buttons are at full width. The visual cue is the
            diagonal lines pseudo-element rendered via the SVG
            below — tied to the same pointerdown that drives the
            window-resize gesture. */}
        <span
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("detail.resize_handle")}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize text-ink-400 hover:text-ink-700"
          style={{ touchAction: "none" }}
        >
          <svg
            viewBox="0 0 16 16"
            className="h-full w-full"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <line x1="11" y1="15" x2="15" y2="11" />
            <line x1="6" y1="15" x2="15" y2="6" />
          </svg>
        </span>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Section card — renders one bucket of fields with the right layout
// per value type. Single-line values share a 2-column grid; long-text
// and object values get full-width blocks below the grid so the
// reader's eye never has to crawl across an awkward narrow column.
// ---------------------------------------------------------------------------


function SectionCard({
  title,
  entries,
  labels,
}: {
  title: string;
  entries: ReadonlyArray<readonly [string, unknown]>;
  labels: Record<string, string>;
}) {
  const t = useTranslations("cff");

  const [showEmpty, setShowEmpty] = useState(false);

  const populated = entries.filter(([, v]) => !isEmpty(v));
  const empty = entries.filter(([, v]) => isEmpty(v));

  // Split populated entries into compact (single-line short) vs
  // wide (multi-line / long / structured) so the layout serves
  // each kind well rather than forcing both into the same grid.
  const compact: typeof populated = [];
  const wide: typeof populated = [];
  for (const entry of populated) {
    (isWideValue(entry[1]) ? wide : compact).push(entry);
  }

  if (populated.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-ink-200">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-600">
        {title}
      </h3>

      {compact.length > 0 ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[180px_minmax(0,1fr)]">
          {compact.map(([slug, value]) => (
            <CompactRow
              key={slug}
              label={prettyLabel(slug, labels)}
              value={value}
            />
          ))}
        </dl>
      ) : null}

      {wide.length > 0 ? (
        <div className={compact.length > 0 ? "mt-4 flex flex-col gap-3" : "flex flex-col gap-3"}>
          {wide.map(([slug, value]) => (
            <WideRow
              key={slug}
              label={prettyLabel(slug, labels)}
              value={value}
            />
          ))}
        </div>
      ) : null}

      {empty.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowEmpty((v) => !v)}
          className="mt-3 text-[11px] font-medium text-ink-500 hover:text-ink-700"
        >
          {showEmpty
            ? `Hide ${empty.length} empty`
            : `Show ${empty.length} empty fields`}
        </button>
      ) : null}

      {showEmpty && empty.length > 0 ? (
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 text-ink-400 sm:grid-cols-[180px_minmax(0,1fr)]">
          {empty.map(([slug]) => (
            <div key={slug} className="contents">
              <dt className="text-[11px] uppercase tracking-wider">
                {prettyLabel(slug, labels)}
              </dt>
              <dd className="text-xs italic">{t("detail.no_fields") /* "—" feel */ === "No fields captured." ? "—" : "—"}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}


function CompactRow({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </dt>
      <dd className="text-sm text-ink-1000">{renderInlineValue(value)}</dd>
    </>
  );
}


function WideRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-ink-50 p-3 ring-1 ring-inset ring-ink-100">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-600">
        {label}
      </dt>
      <dd className="text-sm text-ink-1000">{renderBlockValue(value)}</dd>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Value renderers — by type
// ---------------------------------------------------------------------------


function renderInlineValue(value: unknown): React.ReactNode {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    // Multi-select / chip list. Files don't reach here because
    // ``isWideValue`` routes them to the block renderer.
    return (
      <span className="inline-flex flex-wrap gap-1">
        {value.map((v, i) => (
          <span
            key={i}
            className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-800"
          >
            {typeof v === "string" ? v : JSON.stringify(v)}
          </span>
        ))}
      </span>
    );
  }
  return "—";
}


function renderBlockValue(value: unknown): React.ReactNode {
  if (typeof value === "string") {
    // Preserve newlines + leading whitespace the customer typed.
    return <p className="whitespace-pre-wrap break-words">{value}</p>;
  }
  if (Array.isArray(value)) {
    // File upload arrays — Wix returns each file as a dict with
    // ``displayName`` / ``url`` / ``fileType``. ``url`` may be
    // ``None`` for non-public files; show the name regardless so
    // the team at least knows what was attached.
    if (value.every((v) => isFileEntry(v))) {
      return (
        <ul className="flex flex-col gap-2">
          {value.map((file, i) => (
            <FileEntryRow key={i} file={file as FileEntry} />
          ))}
        </ul>
      );
    }
    // Short list of strings → chips, just like inline.
    return renderInlineValue(value);
  }
  if (value && typeof value === "object") {
    // Address-like object. We render the keys we know about in
    // postal order, falling back to a comma-joined dump for
    // anything we don't recognise.
    const obj = value as Record<string, unknown>;
    const addressLines = formatAddressLikeObject(obj);
    if (addressLines.length > 0) {
      return (
        <address className="not-italic text-sm leading-snug text-ink-1000">
          {addressLines.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </address>
      );
    }
    // Unknown object shape — readable JSON as last resort.
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-ink-700">
        {JSON.stringify(obj, null, 2)}
      </pre>
    );
  }
  return "—";
}


// ---------------------------------------------------------------------------
// File rendering
// ---------------------------------------------------------------------------


interface FileEntry {
  displayName?: string;
  fileId?: string;
  url?: string | null;
  fileType?: string;
  imported?: boolean;
}


function isFileEntry(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "displayName" in o || "fileId" in o || "fileType" in o;
}


function FileEntryRow({ file }: { file: FileEntry }) {
  const isImage = (file.fileType ?? "").toLowerCase().startsWith("image/");
  const Icon = isImage ? ImageIcon : FileText;
  const body = (
    <span className="inline-flex items-center gap-2">
      <Icon className="h-4 w-4 text-ink-500" />
      <span className="font-medium text-ink-1000">
        {file.displayName || file.fileId || "file"}
      </span>
      {file.fileType ? (
        <span className="text-[11px] text-ink-500">{file.fileType}</span>
      ) : null}
    </span>
  );
  if (file.url) {
    return (
      <li>
        <a
          href={file.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
        >
          {body}
        </a>
      </li>
    );
  }
  return (
    <li>
      <span
        title="Wix did not include a public download URL for this file."
        className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-ink-700 ring-1 ring-inset ring-ink-200"
      >
        {body}
      </span>
    </li>
  );
}


// ---------------------------------------------------------------------------
// Address-like object → ordered postal lines
// ---------------------------------------------------------------------------


function formatAddressLikeObject(obj: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const pick = (key: string): string => {
    const v = obj[key];
    return typeof v === "string" ? v.trim() : "";
  };

  const line1 = pick("addressLine") || pick("address_line") || pick("street");
  const line2 = pick("addressLine2") || pick("address_line_2");
  const city = pick("city");
  const subdivision = pick("subdivision") || pick("region") || pick("state");
  const postal = pick("postalCode") || pick("postal_code") || pick("zip");
  const country = pick("country");

  if (line1) lines.push(line1);
  if (line2) lines.push(line2);
  const cityRow = [city, subdivision, postal].filter(Boolean).join(", ");
  if (cityRow) lines.push(cityRow);
  if (country) lines.push(country);

  return lines;
}


// ---------------------------------------------------------------------------
// Field bucketing
// ---------------------------------------------------------------------------


type SectionKey = "customer" | "product" | "commercial" | "attachments" | "other";


interface Section {
  key: SectionKey;
  entries: Array<readonly [string, unknown]>;
}


function bucketize(
  submissions: Record<string, unknown>,
  skip: Set<string>,
): Section[] {
  const customer: Array<readonly [string, unknown]> = [];
  const product: Array<readonly [string, unknown]> = [];
  const commercial: Array<readonly [string, unknown]> = [];
  const attachments: Array<readonly [string, unknown]> = [];
  const other: Array<readonly [string, unknown]> = [];

  for (const [slug, value] of Object.entries(submissions)) {
    if (skip.has(slug)) continue;
    const bucket = categorizeSlug(slug, value);
    if (bucket === "customer") customer.push([slug, value]);
    else if (bucket === "product") product.push([slug, value]);
    else if (bucket === "commercial") commercial.push([slug, value]);
    else if (bucket === "attachments") attachments.push([slug, value]);
    else other.push([slug, value]);
  }

  return [
    { key: "customer", entries: customer },
    { key: "product", entries: product },
    { key: "commercial", entries: commercial },
    { key: "attachments", entries: attachments },
    { key: "other", entries: other },
  ];
}


function categorizeSlug(slug: string, value: unknown): SectionKey {
  const s = slug.toLowerCase();

  // Attachments take precedence — a value that's a file array
  // belongs in the attachments card no matter what the slug says.
  if (Array.isArray(value) && value.every(isFileEntry)) {
    return "attachments";
  }
  if (s.includes("signature") || s.includes("file") || s.includes("upload")) {
    return "attachments";
  }

  if (
    s.includes("address") ||
    s.includes("company") ||
    s.includes("brand") ||
    s.includes("organization") ||
    s.startsWith("first_name") ||
    s.startsWith("last_name") ||
    s.startsWith("full_name") ||
    s.startsWith("email") ||
    s.startsWith("phone") ||
    s.includes("delivery")
  ) {
    return "customer";
  }

  if (
    s.includes("market") ||
    s.includes("product") ||
    s.includes("package") ||
    s.includes("packaging") ||
    s.includes("target") ||
    s.includes("nutritional") ||
    s.includes("requirements") ||
    s.includes("dose") ||
    s.includes("active") ||
    s.includes("flavour") ||
    s.includes("flavor") ||
    s.includes("colour") ||
    s.includes("color") ||
    s.includes("excipient") ||
    s.includes("if_others")
  ) {
    return "product";
  }

  if (
    s.includes("quantity") ||
    s.includes("moq") ||
    s.includes("mo_q") ||
    s.includes("price") ||
    s.includes("budget") ||
    s.includes("timeline") ||
    s.includes("deadline") ||
    s.includes("account_manager") ||
    s.includes("vita_manufacture") ||
    s.startsWith("date") ||
    s.includes("date_picker")
  ) {
    return "commercial";
  }

  return "other";
}


// ---------------------------------------------------------------------------
// Helpers — emptiness, "wide" classification, label prettification
// ---------------------------------------------------------------------------


function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return true;
    // Common "I left it blank" sentinels customers type when they
    // can't skip a required field.
    if (/^(none|n\/a|na|-+)$/i.test(trimmed)) return true;
    return false;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.values(obj).every(
      (v) =>
        v === null ||
        v === undefined ||
        (typeof v === "string" && v.trim() === ""),
    );
  }
  return false;
}


function isWideValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 120 || value.includes("\n");
  }
  if (Array.isArray(value)) {
    if (value.every(isFileEntry)) return true;
    // Lists of strings stay inline as chips.
    return false;
  }
  if (value && typeof value === "object") return true;
  return false;
}


const SLUG_TAIL = /_[a-f0-9]{2,8}$/;


function prettyLabel(slug: string, labels: Record<string, string>): string {
  const cached = labels[slug];
  if (cached) return cached;
  return (
    slug
      .replace(SLUG_TAIL, "")
      .replace(/_/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || slug
  );
}


function pickFirstString(
  submissions: Record<string, unknown>,
  prefixes: string[],
): string {
  for (const prefix of prefixes) {
    for (const [slug, value] of Object.entries(submissions)) {
      if (slug.startsWith(prefix) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "";
}


function composeName(submissions: Record<string, unknown>): string {
  const first = pickFirstString(submissions, ["first_name"]);
  const last = pickFirstString(submissions, ["last_name"]);
  const combined = [first, last].filter(Boolean).join(" ");
  if (combined) return combined;
  return pickFirstString(submissions, ["full_name", "name"]);
}


function addBySlugPrefix(
  submissions: Record<string, unknown>,
  set: Set<string>,
  prefixes: string[],
): void {
  for (const slug of Object.keys(submissions)) {
    if (prefixes.some((p) => slug.startsWith(p))) {
      set.add(slug);
    }
  }
}


// ---------------------------------------------------------------------------
// Status pill (reused style from list view but local so the modal
// doesn't depend on a sibling component's internal export)
// ---------------------------------------------------------------------------


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
