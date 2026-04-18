"use client";

import { Button } from "@heroui/react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCcw,
  ScrollText,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  useInfiniteAuditLog,
  type AuditLogEntryDto,
  type AuditLogFilters,
} from "@/services/audit";


/**
 * Org-wide audit log viewer.
 *
 * Lists every recorded write in the caller's organisation, newest
 * first. A compact filter bar narrows by action, target type, and
 * date range; each row expands to a before/after diff. Capability-
 * gated at the page level — this component assumes the caller has
 * ``audit.view`` and falls back to an empty state when the DB is
 * new.
 */
export function AuditLogTab({ orgId }: { orgId: string }) {
  const tAudit = useTranslations("audit_log");

  const [filters, setFilters] = useState<AuditLogFilters>({});
  const query = useInfiniteAuditLog(orgId, filters, { pageSize: 50 });

  const rows = useMemo<readonly AuditLogEntryDto[]>(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((p) => p.results);
  }, [query.data]);

  const isLoading = query.isLoading || query.isFetching;

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink-1000">
            {tAudit("title")}
          </h2>
          <p className="mt-1 text-sm text-ink-500">{tAudit("subtitle")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          onClick={() => query.refetch()}
          isDisabled={isLoading}
        >
          <RefreshCcw className="h-3.5 w-3.5" />
          {tAudit("actions.refresh")}
        </Button>
      </header>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        tAudit={tAudit}
      />

      {rows.length === 0 && !isLoading ? (
        <EmptyState tAudit={tAudit} />
      ) : (
        <ul className="flex flex-col gap-1 rounded-2xl bg-ink-0 p-2 shadow-sm ring-1 ring-ink-200">
          {rows.map((row) => (
            <AuditRow key={row.id} entry={row} tAudit={tAudit} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-center">
        {query.hasNextPage ? (
          <Button
            type="button"
            variant="outline"
            size="md"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink-0 px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
            onClick={() => query.fetchNextPage()}
            isDisabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tAudit("actions.load_more")}
          </Button>
        ) : rows.length > 0 ? (
          <p className="text-xs text-ink-500">{tAudit("end_of_list")}</p>
        ) : null}
      </div>
    </section>
  );
}


// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------


function FilterBar({
  filters,
  onChange,
  tAudit,
}: {
  filters: AuditLogFilters;
  onChange: (filters: AuditLogFilters) => void;
  tAudit: ReturnType<typeof useTranslations<"audit_log">>;
}) {
  const setField = (
    key: keyof AuditLogFilters,
    value: string | undefined,
  ) => {
    const next: AuditLogFilters = { ...filters };
    if (!value) delete next[key];
    else (next as Record<string, string>)[key] = value;
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 gap-3 rounded-2xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200 md:grid-cols-4">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-700">
          {tAudit("filters.module")}
        </span>
        <select
          value={filters.action_prefix ?? ""}
          onChange={(e) =>
            setField("action_prefix", e.target.value || undefined)
          }
          className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        >
          <option value="">{tAudit("filters.module_all")}</option>
          <option value="formulation">
            {tAudit("filters.module_formulation")}
          </option>
          <option value="formulation_version">
            {tAudit("filters.module_version")}
          </option>
          <option value="formulation_line">
            {tAudit("filters.module_line")}
          </option>
          <option value="spec_sheet">{tAudit("filters.module_spec")}</option>
          <option value="trial_batch">
            {tAudit("filters.module_batch")}
          </option>
          <option value="product_validation">
            {tAudit("filters.module_qc")}
          </option>
          <option value="catalogue">
            {tAudit("filters.module_catalogue")}
          </option>
          <option value="catalogue_item">
            {tAudit("filters.module_item")}
          </option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-700">
          {tAudit("filters.since")}
        </span>
        <input
          type="date"
          value={filters.since ?? ""}
          onChange={(e) => setField("since", e.target.value || undefined)}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-ink-700">
          {tAudit("filters.until")}
        </span>
        <input
          type="date"
          value={filters.until ?? ""}
          onChange={(e) => setField("until", e.target.value || undefined)}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
      </label>

      <div className="flex items-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          onClick={() => onChange({})}
          isDisabled={Object.keys(filters).length === 0}
        >
          {tAudit("filters.clear")}
        </Button>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------


function AuditRow({
  entry,
  tAudit,
}: {
  entry: AuditLogEntryDto;
  tAudit: ReturnType<typeof useTranslations<"audit_log">>;
}) {
  const [open, setOpen] = useState(false);

  const actorLabel = entry.actor
    ? entry.actor.full_name || entry.actor.email
    : tAudit("actor_system");

  const hasDetails = entry.before !== null || entry.after !== null;

  return (
    <li className="rounded-xl hover:bg-ink-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!hasDetails}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm disabled:cursor-default"
      >
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-ink-400">
          {hasDetails ? (
            open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )
          ) : null}
        </span>
        <span className="w-40 flex-shrink-0 text-xs text-ink-500">
          {formatTimestamp(entry.created_at)}
        </span>
        <span className="w-48 flex-shrink-0 truncate text-sm text-ink-1000">
          {actorLabel}
        </span>
        <span className="flex-1 truncate text-sm text-ink-700">
          <span className="font-medium">{entry.action}</span>
          <span className="ml-2 text-xs text-ink-500">
            {entry.target_type} · {shortId(entry.target_id)}
          </span>
        </span>
      </button>

      {open && hasDetails ? (
        <div className="grid grid-cols-1 gap-3 border-t border-ink-100 px-3 py-3 md:grid-cols-2">
          <JsonBlock
            label={tAudit("labels.before")}
            payload={entry.before}
          />
          <JsonBlock
            label={tAudit("labels.after")}
            payload={entry.after}
          />
        </div>
      ) : null}
    </li>
  );
}


function JsonBlock({
  label,
  payload,
}: {
  label: string;
  payload: unknown;
}) {
  const rendered = useMemo(() => {
    if (payload === null || payload === undefined) return null;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }, [payload]);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-900/5 p-3 font-mono text-[11px] leading-snug text-ink-700 ring-1 ring-inset ring-ink-200">
        {rendered ?? "—"}
      </pre>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------


function EmptyState({
  tAudit,
}: {
  tAudit: ReturnType<typeof useTranslations<"audit_log">>;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
      <ScrollText className="h-8 w-8 text-ink-300" />
      <p className="text-sm font-medium text-ink-1000">
        {tAudit("empty.title")}
      </p>
      <p className="text-xs text-ink-500">{tAudit("empty.hint")}</p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/** Short display form for an id column: first UUID segment or the
 * full string when it's already short. */
function shortId(raw: string): ReactNode {
  if (!raw) return "—";
  const first = raw.split("-", 1)[0] ?? raw;
  return first.length > 8 ? first.slice(0, 8) : first;
}


/** ISO timestamp → ``2026-04-18 22:05`` for compact display. No
 * locale-dependent formatting — this panel is audit forensics, not
 * marketing copy, and stable parseability beats pretty. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
