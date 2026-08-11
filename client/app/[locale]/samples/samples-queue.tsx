"use client";

/**
 * R&D Samples fulfilment queue — 3-column pipeline board.
 *
 * Column layout mirrors ``/finance/payments`` and ``/proposals``
 * so operators moving between stages don't have to relearn the
 * shape:
 *
 *   New          — approved sample Payment, no TrialBatch yet.
 *                  Card CTA opens the "Create trial batch" modal.
 *   In progress  — batch spawned, PSP MO chain hasn't reported
 *                  ``psp_all_stages_completed=True`` yet. Card
 *                  links out to the trial-batch detail page.
 *   Finished     — batch done. Card links to the completed batch
 *                  so you can pull the BOM / QC results.
 *
 * Each column runs its own ``useInfiniteQuery`` against
 * ``GET /api/organizations/<org>/samples/pending/?bucket=…`` with
 * a keyset cursor on ``(approved_at, id)`` — page cost stays
 * ``O(log N + limit)`` regardless of how many rows the org owns.
 * The "millions of records" case pages just as fast on row 999k
 * as on row 20.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type UseInfiniteQueryResult,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  ArrowRight,
  Beaker,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Package,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiClient } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";
import { createTrialBatch } from "@/services/trial_batches";

// ---------------------------------------------------------------------------
// Wire types — mirror apps.trial_batches.api.samples_views
// ---------------------------------------------------------------------------

type Bucket = "new" | "in_progress" | "finished";

interface ComboRef {
  readonly id: string;
  readonly name: string;
  readonly price_delta: string | null;
  readonly is_default: boolean;
}

interface FormulationRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly display_name: string;
  readonly approved_version_id: string | null;
  readonly combos: readonly ComboRef[];
}

interface CustomerRef {
  readonly id: string;
  readonly company: string;
  readonly name: string;
  readonly email: string;
}

interface PaymentRef {
  readonly id: string;
  readonly amount: string | null;
  readonly currency: string;
  readonly paid_at: string | null;
  readonly approved_at: string | null;
  readonly reference: string;
  readonly notes: string;
}

interface TrialBatchRef {
  readonly id: string;
  readonly label: string;
  readonly batch_size_units: number;
  readonly psp_all_stages_completed: boolean;
  readonly packaging_combo_id: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly formulation_id: string | null;
}

interface SampleItem {
  readonly payment: PaymentRef;
  readonly customer: CustomerRef | null;
  readonly formulation: FormulationRef | null;
  readonly trial_batch: TrialBatchRef | null;
}

interface SamplesPage {
  readonly items: readonly SampleItem[];
  readonly next_cursor: string | null;
  readonly counts: Record<Bucket, number>;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

const samplesQueryKey = (orgId: string, bucket: Bucket, search: string) =>
  [...rootQueryKey, "samples", orgId, bucket, search] as const;

async function fetchSamples(args: {
  orgId: string;
  bucket: Bucket;
  search: string;
  cursor: string | null;
}): Promise<SamplesPage> {
  const params = new URLSearchParams();
  params.set("bucket", args.bucket);
  params.set("limit", String(PAGE_SIZE));
  if (args.cursor) params.set("cursor", args.cursor);
  if (args.search) params.set("q", args.search);
  const { data } = await apiClient.get<SamplesPage>(
    `/api/organizations/${args.orgId}/samples/pending/?${params.toString()}`,
  );
  return data;
}

// Each column runs one of these — bucket-scoped infinite query
// with keyset cursor. Debounced search is passed in from the
// parent so every column filters against the same query string.
function useSamplesBucket(args: {
  orgId: string;
  bucket: Bucket;
  search: string;
}): UseInfiniteQueryResult<InfiniteData<SamplesPage, string | null>, Error> {
  return useInfiniteQuery<
    SamplesPage,
    Error,
    InfiniteData<SamplesPage, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: samplesQueryKey(args.orgId, args.bucket, args.search),
    queryFn: ({ pageParam }) =>
      fetchSamples({
        orgId: args.orgId,
        bucket: args.bucket,
        search: args.search,
        cursor: pageParam ?? null,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

const BUCKETS: ReadonlyArray<{
  key: Bucket;
  label: string;
  hint: string;
  accent: string;
  headerIcon: React.ComponentType<{ className?: string }>;
}> = [
  {
    key: "new",
    label: "New",
    hint: "Approved payments waiting on a trial batch.",
    accent: "bg-amber-100 text-amber-800",
    headerIcon: Beaker,
  },
  {
    key: "in_progress",
    label: "In progress",
    hint: "Trial batch spawned; PSP still cooking.",
    accent: "bg-sky-100 text-sky-800",
    headerIcon: Loader2,
  },
  {
    key: "finished",
    label: "Finished",
    hint: "PSP completed — kit is ready to ship.",
    accent: "bg-emerald-100 text-emerald-800",
    headerIcon: CheckCircle2,
  },
];

export function SamplesQueue({ orgId }: { orgId: string }) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<SampleItem | null>(null);

  // Debounce the search so every keystroke doesn't fire 3 fetches
  // (one per column).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const newQ = useSamplesBucket({ orgId, bucket: "new", search: debouncedSearch });
  const wipQ = useSamplesBucket({ orgId, bucket: "in_progress", search: debouncedSearch });
  const doneQ = useSamplesBucket({ orgId, bucket: "finished", search: debouncedSearch });
  const queries: Record<Bucket, ReturnType<typeof useSamplesBucket>> = {
    new: newQ,
    in_progress: wipQ,
    finished: doneQ,
  };

  // Counts come from whichever column responds first — every
  // bucket endpoint returns the SAME ``counts`` block so this is
  // stable regardless of which one lands.
  const counts: Record<Bucket, number> = useMemo(() => {
    const anyPage =
      newQ.data?.pages[0] ??
      wipQ.data?.pages[0] ??
      doneQ.data?.pages[0] ??
      null;
    return (
      anyPage?.counts ?? {
        new: 0,
        in_progress: 0,
        finished: 0,
      }
    );
  }, [newQ.data, wipQ.data, doneQ.data]);

  return (
    <section className="mt-6 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            Samples
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Sample requests move left-to-right: fresh payment →
            trial batch spawned → PSP MO chain complete.
          </p>
        </div>
        <SearchBar value={searchInput} onChange={setSearchInput} />
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {BUCKETS.map((cfg) => (
          <BucketColumn
            key={cfg.key}
            cfg={cfg}
            query={queries[cfg.key]}
            count={counts[cfg.key] ?? 0}
            hasSearch={debouncedSearch.length > 0}
            onOpenNew={cfg.key === "new" ? setSelected : undefined}
          />
        ))}
      </div>

      {selected ? (
        <CreateBatchModal
          orgId={orgId}
          item={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

function BucketColumn({
  cfg,
  query,
  count,
  hasSearch,
  onOpenNew,
}: {
  cfg: (typeof BUCKETS)[number];
  query: ReturnType<typeof useSamplesBucket>;
  count: number;
  hasSearch: boolean;
  onOpenNew?: (item: SampleItem) => void;
}) {
  const rows = useMemo<readonly SampleItem[]>(
    () => query.data?.pages.flatMap((p) => p.items) ?? [],
    [query.data],
  );
  const Icon = cfg.headerIcon;

  return (
    <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="border-b border-ink-100 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon
              className={`h-4 w-4 ${cfg.key === "in_progress" ? "text-sky-700" : cfg.key === "finished" ? "text-emerald-700" : "text-amber-700"}`}
              aria-hidden
            />
            <h2 className="text-sm font-semibold text-ink-1000">{cfg.label}</h2>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.accent}`}>
            {count}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-ink-500">{cfg.hint}</p>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {query.isLoading ? (
          <p className="p-4 text-center text-xs text-ink-500">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading…
          </p>
        ) : query.isError ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 p-3 text-xs text-danger">
            Couldn&rsquo;t load this column. Refresh to try again.
          </p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-center text-xs text-ink-500">
            {hasSearch
              ? "Nothing matches your search here."
              : cfg.key === "new"
                ? "All caught up — no unfulfilled sample payments."
                : cfg.key === "in_progress"
                  ? "No trial batches in flight."
                  : "No completed sample batches yet."}
          </p>
        ) : (
          rows.map((row) => (
            <SampleCard
              key={row.payment.id}
              row={row}
              bucket={cfg.key}
              onOpenNew={onOpenNew}
            />
          ))
        )}

        {query.hasNextPage && !hasSearch ? (
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50"
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function SampleCard({
  row,
  bucket,
  onOpenNew,
}: {
  row: SampleItem;
  bucket: Bucket;
  onOpenNew?: (item: SampleItem) => void;
}) {
  const title =
    row.formulation?.display_name ||
    row.formulation?.name ||
    row.formulation?.code ||
    "Untitled product";
  const code = row.formulation?.code ?? "";
  const customerLabel =
    row.customer?.company || row.customer?.name || row.customer?.email || "Unknown customer";
  const amount = row.payment.amount
    ? formatMoney(row.payment.amount, row.payment.currency)
    : null;

  return (
    <div className="rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {title}
            {code && code !== title ? (
              <span className="ml-1 font-mono text-[10px] text-ink-500">({code})</span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-ink-600">{customerLabel}</p>
        </div>
        {amount ? (
          <p className="shrink-0 text-xs font-semibold tabular-nums text-ink-1000">
            {amount}
          </p>
        ) : null}
      </div>
      <p className="mt-1.5 text-[10px] text-ink-500">
        {bucket === "new"
          ? `Approved ${formatDate(row.payment.approved_at ?? row.payment.paid_at)}`
          : row.trial_batch
            ? `Batch ${row.trial_batch.label || "unnamed"} · ${row.trial_batch.batch_size_units} units`
            : "Batch pending"}
      </p>
      <div className="mt-2 flex items-center justify-end gap-2">
        {bucket === "new" ? (
          <button
            type="button"
            onClick={() => onOpenNew?.(row)}
            className="inline-flex items-center gap-1 rounded-full bg-ink-1000 px-3 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Sparkles className="h-3 w-3" /> Create trial batch
          </button>
        ) : row.trial_batch?.formulation_id ? (
          // Plain anchor because next-intl's typed Link needs a
          // static ``params`` shape only for routes registered in
          // its pathname enum. Trial-batch detail lives outside
          // that surface; localised prefix is provided by the
          // browser's current URL.
          <a
            href={`/formulations/${row.trial_batch.formulation_id}/trial-batches/${row.trial_batch.id}`}
            className="inline-flex items-center gap-1 rounded-full border border-ink-200 px-3 py-1 text-[10px] font-semibold text-ink-700 hover:bg-ink-50"
          >
            {bucket === "finished" ? "View batch" : "Open batch"}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative w-full max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by product, customer, or email…"
        className="h-10 w-full rounded-full border border-ink-200 bg-ink-0 pl-9 pr-9 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create-batch modal
// ---------------------------------------------------------------------------

function CreateBatchModal({
  orgId,
  item,
  onClose,
}: {
  orgId: string;
  item: SampleItem;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const formulation = item.formulation;
  const defaultCombo = formulation?.combos.find((c) => c.is_default) ?? formulation?.combos[0] ?? null;

  const [batchSize, setBatchSize] = useState("");
  const [comboId, setComboId] = useState<string>(defaultCombo?.id ?? "");
  const [label, setLabel] = useState(
    formulation ? `Sample · ${formulation.display_name || formulation.name}` : "",
  );
  const [notes, setNotes] = useState(
    item.customer?.company
      ? `Sample kit for ${item.customer.company}${item.customer.email ? ` (${item.customer.email})` : ""}.`
      : "",
  );

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!formulation?.approved_version_id) {
        throw new Error("This RTG doesn't have an approved version yet.");
      }
      const size = Number.parseInt(batchSize, 10);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error("Batch size must be a positive number.");
      }
      return createTrialBatch(orgId, formulation.id, {
        formulation_version_id: formulation.approved_version_id,
        batch_size_units: size,
        kind: "sample",
        packaging_combo_id: comboId || null,
        label: label.trim(),
        notes: notes.trim(),
        source_payment_id: item.payment.id,
      });
    },
    onSuccess: () => {
      // Invalidate every samples-page query — the fulfilled
      // payment moves out of ``new`` into ``in_progress`` and
      // both columns need to re-fetch. The bucket-agnostic
      // prefix drops the search + bucket qualifier so a fresh
      // query in another search state picks up the change too.
      queryClient.invalidateQueries({
        queryKey: [...rootQueryKey, "samples", orgId],
      });
      onClose();
    },
  });

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      mutation.mutate();
    },
    [mutation],
  );

  const canSubmit =
    !!formulation?.approved_version_id &&
    batchSize.trim().length > 0 &&
    !mutation.isPending;

  const errorMessage = mutation.isError ? extractErrorMessage(mutation.error) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="samples-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-ink-200 bg-ink-0 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-ink-100 p-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-ink-500">
              Create sample trial batch
            </p>
            <h2
              id="samples-modal-title"
              className="mt-1 text-lg font-semibold text-ink-1000"
            >
              {formulation?.display_name || formulation?.name || "Sample"}
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              {item.customer?.company || item.customer?.name || "Customer"}
              {item.payment.amount ? (
                <>
                  {" "}· {formatMoney(item.payment.amount, item.payment.currency)}
                </>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
          >
            <X className="size-4" />
          </button>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-4 p-5">
          {!formulation?.approved_version_id ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              This RTG product doesn&rsquo;t have an approved version yet — a
              scientist needs to sign off on a Final spec before we can spawn
              a batch. Pinging the R&amp;D lead is the fastest path.
            </p>
          ) : null}

          <Field label="Batch size (units)" htmlFor="batch_size">
            <input
              id="batch_size"
              type="number"
              inputMode="numeric"
              min={1}
              required
              value={batchSize}
              onChange={(e) => setBatchSize(e.target.value)}
              className="h-10 w-full rounded-lg border border-ink-200 bg-ink-0 px-3 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
              placeholder="e.g. 500"
              autoFocus
            />
            <p className="mt-1 text-[11px] text-ink-500">
              Sample-kind batches multiply by servings-per-pack behind the scenes.
            </p>
          </Field>

          {formulation && formulation.combos.length > 0 ? (
            <Field label="Packaging combo" htmlFor="packaging_combo">
              <select
                id="packaging_combo"
                value={comboId}
                onChange={(e) => setComboId(e.target.value)}
                className="h-10 w-full rounded-lg border border-ink-200 bg-ink-0 px-3 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
              >
                <option value="">— No combo (loose-bulk) —</option>
                {formulation.combos.map((combo) => (
                  <option key={combo.id} value={combo.id}>
                    {combo.name || "Unnamed combo"}
                    {combo.is_default ? " (default)" : ""}
                  </option>
                ))}
              </select>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-ink-500">
                <Package className="size-3" aria-hidden />
                Overlays the PSP MO&rsquo;s packaging BOM with this combo&rsquo;s items.
              </p>
            </Field>
          ) : null}

          <Field label="Label" htmlFor="batch_label">
            <input
              id="batch_label"
              type="text"
              value={label}
              maxLength={200}
              onChange={(e) => setLabel(e.target.value)}
              className="h-10 w-full rounded-lg border border-ink-200 bg-ink-0 px-3 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
            />
          </Field>

          <Field label="Notes" htmlFor="batch_notes">
            <textarea
              id="batch_notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-ink-200 bg-ink-0 px-3 py-2 text-sm text-ink-1000 outline-none focus:border-ink-400 focus:ring-2 focus:ring-ink-200"
            />
          </Field>

          {errorMessage ? (
            <p
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {errorMessage}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-3.5 py-1.5 text-xs font-semibold text-ink-500 hover:text-ink-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 rounded-full bg-ink-1000 px-4 py-2 text-xs font-semibold text-ink-0 transition-colors hover:bg-ink-900 disabled:opacity-50"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Creating…
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" /> Create trial batch
                  <ArrowRight className="size-3.5" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency || ""}`.trim();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      minimumFractionDigits: 2,
    }).format(n);
  } catch {
    return `£${n.toFixed(2)}`;
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso ?? "—";
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null) {
    const payload = (err as { payload?: Record<string, unknown> }).payload;
    if (payload) {
      const firstKey = Object.keys(payload)[0];
      if (firstKey) {
        const val = payload[firstKey];
        if (Array.isArray(val) && typeof val[0] === "string") {
          return `${firstKey}: ${val[0]}`;
        }
        if (typeof val === "string") return `${firstKey}: ${val}`;
      }
    }
  }
  return "Couldn't create the trial batch. Try again in a moment.";
}
