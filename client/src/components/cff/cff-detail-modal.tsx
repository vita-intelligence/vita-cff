"use client";

/**
 * Read-only detail view for one CFF submission.
 *
 * Structure (top → bottom):
 *
 * 1. **Header** — customer name + company, status pill, assignment
 *    badge, submitted-time relative stamp.
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
  FileText,
  Image as ImageIcon,
  Link2,
  Mail,
  Phone,
  Sparkles,
  X,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import type { CFFSubmissionDto } from "@/services/cff-submissions";


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
      aria-modal="true"
      aria-labelledby="cff-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-3xl max-h-[92vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        {/* ---- Header ---- */}
        <header className="flex items-start justify-between gap-4 border-b border-ink-100 px-6 py-4">
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
          <button
            type="button"
            onClick={onClose}
            aria-label={t("detail.close")}
            className="rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* ---- Body ---- */}
        <div className="flex-1 overflow-y-auto bg-ink-50 px-6 py-5">
          {/* Assignment ribbon */}
          {submission.project ? (
            <div className="mb-4 rounded-xl bg-blue-50 px-3 py-2 text-xs text-blue-900 ring-1 ring-inset ring-blue-200">
              {t("badge.assigned_to", {
                project:
                  submission.project.code || submission.project.name,
              })}
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
          {canAssign && !submission.project ? (
            <>
              {/* Secondary path: attach to a project that already
                  exists. Lives behind the primary "create" so
                  triagers don't accidentally bury a new request in
                  an unrelated project. */}
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
      </div>
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
