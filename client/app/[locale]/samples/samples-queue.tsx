"use client";

/**
 * R&D Samples fulfilment queue.
 *
 * Reads ``GET /api/organizations/<org>/samples/pending/`` and
 * renders one card per unfulfilled sample payment. Clicking Create
 * trial batch opens a compact modal that collects only the fields
 * a scientist HAS to touch (batch size + packaging combo + label +
 * notes); the formulation version + kind=sample + source_payment
 * are auto-attached from the payment context.
 *
 * State approach: `useQuery` for the list, `useMutation` for the
 * create. On mutation success we invalidate the list — the newly-
 * fulfilled payment drops off the queue because the endpoint
 * excludes any payment that already has a linked TrialBatch.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  ArrowRight,
  Beaker,
  Loader2,
  Package,
  Search,
  ShoppingBag,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { apiClient } from "@/lib/api";
import { createTrialBatch } from "@/services/trial_batches";
import type { TrialBatchDto } from "@/services/trial_batches";
import { rootQueryKey } from "@/lib/query";

// ---------------------------------------------------------------------------
// Wire types — mirror apps.trial_batches.api.samples_views.PendingSamplePaymentsView
// ---------------------------------------------------------------------------

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

interface PendingSampleItem {
  readonly payment: PaymentRef;
  readonly customer: CustomerRef | null;
  readonly formulation: FormulationRef | null;
}

interface PendingSamplesResponse {
  readonly items: readonly PendingSampleItem[];
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const samplesQueryKey = (orgId: string) =>
  [...rootQueryKey, "samples", "pending", orgId] as const;

async function fetchPendingSamples(orgId: string): Promise<PendingSamplesResponse> {
  const { data } = await apiClient.get<PendingSamplesResponse>(
    `/api/organizations/${orgId}/samples/pending/`,
  );
  return data;
}

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export function SamplesQueue({ orgId }: { orgId: string }) {
  const query = useQuery({
    queryKey: samplesQueryKey(orgId),
    queryFn: () => fetchPendingSamples(orgId),
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<PendingSampleItem | null>(null);

  // Memo-wrap the fallback so ``items`` keeps a stable identity
  // when the query data hasn't landed yet — otherwise the ``??
  // []`` fresh array would invalidate the filter memo on every
  // render and re-run the search unnecessarily.
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((row) => {
      const bits = [
        row.formulation?.code ?? "",
        row.formulation?.name ?? "",
        row.formulation?.display_name ?? "",
        row.customer?.company ?? "",
        row.customer?.name ?? "",
        row.customer?.email ?? "",
        row.payment.reference,
      ]
        .join(" ")
        .toLowerCase();
      return bits.includes(q);
    });
  }, [items, search]);

  return (
    <section className="mt-6 flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            Samples
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Approved sample requests waiting on a trial batch. Turn each one
            into a sample-kind batch and the customer moves off the queue.
          </p>
        </div>
        <span className="rounded-full bg-ink-100 px-2.5 py-1 text-xs font-semibold text-ink-700">
          {items.length} pending
        </span>
      </header>

      <SearchBar value={search} onChange={setSearch} />

      {query.isLoading ? (
        <StateCard>
          <span className="inline-flex items-center gap-2 text-sm text-ink-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading pending samples…
          </span>
        </StateCard>
      ) : query.isError ? (
        <StateCard tone="danger">
          Couldn&rsquo;t load the queue right now. Refresh the page — if this
          persists let engineering know.
        </StateCard>
      ) : items.length === 0 ? (
        <StateCard>
          <div className="flex flex-col items-center gap-2 text-center">
            <ShoppingBag className="h-6 w-6 text-ink-400" aria-hidden />
            <p className="text-sm text-ink-600">
              Nothing waiting — every sample payment on file has a trial
              batch. New requests will land here as finance approves them.
            </p>
          </div>
        </StateCard>
      ) : filtered.length === 0 ? (
        <StateCard>
          <div className="flex flex-col items-center gap-2 text-center">
            <Search className="h-6 w-6 text-ink-400" aria-hidden />
            <p className="text-sm text-ink-600">Nothing matches your search.</p>
          </div>
        </StateCard>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((row) => (
            <li key={row.payment.id}>
              <SampleRow row={row} onCreate={() => setSelected(row)} />
            </li>
          ))}
        </ul>
      )}

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
// Row
// ---------------------------------------------------------------------------

function SampleRow({
  row,
  onCreate,
}: {
  row: PendingSampleItem;
  onCreate: () => void;
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
    : "—";
  return (
    <article className="flex flex-wrap items-center gap-4 rounded-2xl border border-ink-200 bg-ink-0 p-4 shadow-sm shadow-black/[0.02] transition-colors hover:border-ink-300 sm:p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
        <Beaker className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink-1000 sm:text-base">
          {title}
          {code && code !== title ? (
            <span className="ml-2 font-mono text-xs text-ink-500">({code})</span>
          ) : null}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-ink-500">
          <span className="truncate">{customerLabel}</span>
          {row.customer?.email ? (
            <>
              <span>·</span>
              <span className="truncate">{row.customer.email}</span>
            </>
          ) : null}
          <span>·</span>
          <span>Approved {formatDate(row.payment.approved_at ?? row.payment.paid_at)}</span>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-right text-sm font-semibold tabular-nums text-ink-1000">
          {amount}
        </p>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink-1000 px-3.5 py-1.5 text-xs font-semibold text-ink-0 transition-colors hover:bg-ink-900"
        >
          <Sparkles className="size-3.5" /> Create trial batch
        </button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function CreateBatchModal({
  orgId,
  item,
  onClose,
}: {
  orgId: string;
  item: PendingSampleItem;
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

  // Escape + body scroll lock, matching the marketing portal's
  // modal ergonomic so muscle memory carries over.
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

  const mutation: UseMutationResult<
    TrialBatchDto,
    unknown,
    void
  > = useMutation({
    mutationFn: async () => {
      if (!formulation?.approved_version_id) {
        throw new Error("Missing formulation version");
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
      queryClient.invalidateQueries({ queryKey: samplesQueryKey(orgId) });
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

  const errorMessage = mutation.isError
    ? extractErrorMessage(mutation.error)
    : null;

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
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
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
// Search + shared bits
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

function StateCard({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  const toneCls =
    tone === "danger"
      ? "border-danger/40 bg-danger/5 text-danger"
      : "border-ink-200 bg-ink-50 text-ink-600";
  return (
    <div className={`rounded-2xl border ${toneCls} p-6 text-sm`}>
      {children}
    </div>
  );
}

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

// ---------------------------------------------------------------------------
// Formatting + error extraction
// ---------------------------------------------------------------------------

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
    const detail = (err as { message?: string }).message;
    if (detail) return detail;
  }
  return "Couldn't create the trial batch. Try again in a moment.";
}
