"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Banknote,
  Loader2,
  Paperclip,
  Plus,
  Receipt,
  Search,
  X,
} from "lucide-react";

import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import {
  fetchPendingPaymentProjects,
  uploadPaymentInvoice,
  useAwaitingDeposits,
  usePayments,
  usePendingPaymentProjects,
  useRecordPayment,
  type AwaitingDepositDto,
  type PaymentDto,
  type PendingProjectDto,
} from "@/services/payments";


/** Human-readable label for the DRF codes the payment serializer can
 *  emit. Falls back to the raw code (e.g. "blank") when we haven't
 *  mapped it, so a brand-new code still renders something legible
 *  rather than a generic "validation error". */
const FIELD_LABEL: Record<string, string> = {
  formulation: "Project",
  amount: "Amount",
  currency: "Currency",
  method: "Payment method",
  external_reference: "Reference",
  invoice_number: "Invoice number",
  paid_at: "Paid at",
  notes: "Notes",
};


const CODE_MESSAGE: Record<string, string> = {
  required: "is required.",
  blank: "can't be blank.",
  null: "can't be empty.",
  invalid: "is not in a valid format.",
  invalid_choice: "is not one of the allowed values.",
  max_string_length: "is too long.",
  max_length: "is too long.",
  min_value: "is too small.",
  max_value: "is too large.",
  min_decimal_places: "needs more decimal places.",
  max_decimal_places:
    "has too many decimal places (max 2 — e.g. 100.00, not 100.0000).",
  max_digits: "is too long.",
  invalid_uuid: "is not a valid project id.",
  does_not_exist: "could not be found.",
};


function formatPaymentError(e: unknown): string {
  if (e instanceof ApiError) {
    const fieldErrorPairs: string[] = [];
    for (const [field, value] of Object.entries(e.fieldErrors)) {
      const codes = Array.isArray(value) ? value : Object.values(value).flat();
      const text = (codes as string[])
        .map((code) => CODE_MESSAGE[code] ?? code)
        .join(" ");
      const label = FIELD_LABEL[field] ?? field;
      fieldErrorPairs.push(`${label} ${text}`);
    }
    if (fieldErrorPairs.length > 0) return fieldErrorPairs.join(" · ");
    if (e.payload?.detail) return e.payload.detail;
    return e.message || "Could not record payment.";
  }
  return (
    (e as { message?: string })?.message ?? "Could not record payment."
  );
}


/** Debounce hook — return ``value`` only after ``delay`` ms of stillness.
 *  Avoids hammering the pending-projects endpoint on every keystroke. */
function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}


export function PaymentsList({
  orgId,
  canRecord,
  canApprove,
}: {
  orgId: string;
  canRecord: boolean;
  canApprove: boolean;
}) {
  // Pipeline layout: three side-by-side columns, each a live
  // paginated list. Instead of one status dropdown, every stage
  // is on screen simultaneously so finance never has to click a
  // tab to find out a new order landed.
  const pendingQ = usePayments(orgId, "pending");
  const approvedQ = usePayments(orgId, "approved");
  const voidedQ = usePayments(orgId, "voided");

  // Per-column search boxes — each one is a client-side filter
  // over its own tab's data. Cheap because the backend queries
  // return page-sized arrays already.
  const [pendingColSearch, setPendingColSearch] = useState("");
  const [approvedColSearch, setApprovedColSearch] = useState("");
  const [voidedColSearch, setVoidedColSearch] = useState("");

  // ONE debounced search feeds both awaiting queues (finals +
  // deposits) inside the Needs-attention column. Old code kept two
  // separate boxes; the pipeline layout groups them so one input
  // is enough.
  const debouncedNeedsSearch = useDebounced(pendingColSearch, 250);
  const pending = usePendingPaymentProjects(orgId, debouncedNeedsSearch);
  const pendingItems = useMemo<ReadonlyArray<PendingProjectDto>>(
    () => pending.data?.pages.flatMap((p) => p.items) ?? [],
    [pending.data],
  );
  const pendingTotal = pending.data?.pages[0]?.total ?? 0;

  const [showCreate, setShowCreate] = useState(false);
  // Project that pre-fills the record-payment dialog. ``null`` means
  // "blank dialog" — the manual record-payment button (rare path).
  const [prefilledProject, setPrefilledProject] =
    useState<PendingProjectDto | null>(null);

  const openDialogFor = (project: PendingProjectDto | null) => {
    setPrefilledProject(project);
    setShowCreate(true);
  };

  // Deposit-side dialog. Separate from the finals dialog because the
  // preset shape is different (proposal vs formulation) and the copy
  // reads differently. Signing a proposal no longer materialises a
  // Payment row automatically — finance records it here off the
  // "Awaiting payment · Deposits" sub-tab once the money lands.
  const [depositDialog, setDepositDialog] =
    useState<AwaitingDepositDto | null>(null);

  // Awaiting deposits — shares the column-1 search box with
  // awaiting finals. See ``debouncedNeedsSearch`` above.
  const awaitingDeposits = useAwaitingDeposits(orgId, debouncedNeedsSearch);
  const depositItems = useMemo<ReadonlyArray<AwaitingDepositDto>>(
    () => awaitingDeposits.data?.pages.flatMap((p) => p.items) ?? [],
    [awaitingDeposits.data],
  );
  const depositsTotal = awaitingDeposits.data?.pages[0]?.total ?? 0;

  // Client-side filter helper for the Approved / Voided columns.
  // Server pagination returns page-sized arrays; a scan-per-card
  // is cheap and lets each column search on the same bag of
  // fields (project code, formulation name, proposal code,
  // reference, invoice number, notes) without a new API round-trip.
  const filterPayments = (
    rows: ReadonlyArray<PaymentDto> | undefined,
    q: string,
  ): ReadonlyArray<PaymentDto> => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((p) =>
      (
        (p.formulation_code || "") +
        " " +
        (p.formulation_name || "") +
        " " +
        (p.proposal_code || "") +
        " " +
        (p.external_reference || "") +
        " " +
        (p.invoice_number || "") +
        " " +
        (p.notes || "")
      )
        .toLowerCase()
        .includes(needle),
    );
  };

  const approvedRows = filterPayments(approvedQ.data, approvedColSearch);
  const voidedRows = filterPayments(voidedQ.data, voidedColSearch);
  const pendingPayRows = filterPayments(pendingQ.data, pendingColSearch);

  const needsAttentionCount =
    pendingTotal + depositsTotal + (pendingQ.data?.length ?? 0);

  return (
    <section className="mt-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-1000">Payments</h1>
          <p className="text-xs text-ink-500">
            Every stage on one screen. Needs attention on the left is
            where new orders and awaited deposits land — approving a
            payment there unlocks label design for that project.
          </p>
        </div>
        {canRecord ? (
          <button
            type="button"
            onClick={() => openDialogFor(null)}
            className="inline-flex items-center gap-1 rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Plus className="h-3 w-3" /> Record payment
          </button>
        ) : null}
      </header>

      {/* Pipeline board — three side-by-side columns, each an
       *  independent live queue with its own search box. Grid on
       *  large screens, horizontal-scroll strip on smaller ones so
       *  the "everything at a glance" property survives narrow
       *  viewports.
       */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* ---------- Column 1: NEEDS ATTENTION ---------- */}
        <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
          <header className="border-b border-ink-100 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Receipt className="h-4 w-4 text-amber-700" />
                <h2 className="text-sm font-semibold text-ink-1000">
                  Needs attention
                </h2>
              </div>
              {needsAttentionCount > 0 ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                  {needsAttentionCount}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-ink-500">
              New portal orders, awaited deposits, and pending
              payments — anything finance still owes an action on.
            </p>
            <div className="relative mt-3">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
                aria-hidden
              />
              <input
                type="search"
                value={pendingColSearch}
                onChange={(e) => setPendingColSearch(e.target.value)}
                placeholder="Search…"
                className="h-9 w-full rounded-lg bg-ink-50 pl-9 pr-9 text-xs text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
              />
              {pendingColSearch ? (
                <button
                  type="button"
                  onClick={() => setPendingColSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto p-3">
            {/* Deposits sub-section */}
            {depositsTotal > 0 ? (
              <section>
                <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                  Awaiting deposits · {depositsTotal}
                </p>
                <div className="space-y-2">
                  {depositItems.map((d) => (
                    <DepositCard
                      key={d.proposal_id}
                      deposit={d}
                      canRecord={canRecord}
                      onRecord={() => setDepositDialog(d)}
                    />
                  ))}
                  {awaitingDeposits.hasNextPage ? (
                    <button
                      type="button"
                      onClick={() => awaitingDeposits.fetchNextPage()}
                      disabled={awaitingDeposits.isFetchingNextPage}
                      className="w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50"
                    >
                      {awaitingDeposits.isFetchingNextPage
                        ? "Loading…"
                        : "Load more"}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Awaiting finals sub-section */}
            {pendingTotal > 0 ? (
              <section>
                <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                  Awaiting finals · {pendingTotal}
                </p>
                <div className="space-y-2">
                  {pendingItems.map((p) => (
                    <PendingCard
                      key={p.formulation_id}
                      project={p}
                      canRecord={canRecord}
                      onRecord={() => openDialogFor(p)}
                    />
                  ))}
                  {pending.hasNextPage ? (
                    <button
                      type="button"
                      onClick={() => pending.fetchNextPage()}
                      disabled={pending.isFetchingNextPage}
                      className="w-full rounded-lg px-3 py-1.5 text-[11px] font-semibold text-ink-600 hover:bg-ink-50 disabled:opacity-50"
                    >
                      {pending.isFetchingNextPage ? "Loading…" : "Load more"}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* Pending Payment rows sub-section */}
            {pendingPayRows.length > 0 ? (
              <section>
                <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                  Pending payments · {pendingPayRows.length}
                </p>
                <div className="space-y-2">
                  {pendingPayRows.map((p) => (
                    <PaymentCard key={p.id} payment={p} />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Empty state — only when EVERY sub-section is empty. */}
            {pending.isLoading ||
            awaitingDeposits.isLoading ||
            pendingQ.isLoading ? (
              <p className="p-4 text-center text-xs text-ink-500">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Loading…
              </p>
            ) : depositsTotal === 0 &&
              pendingTotal === 0 &&
              pendingPayRows.length === 0 ? (
              <p className="p-4 text-center text-xs text-ink-500">
                {pendingColSearch
                  ? `Nothing matches "${pendingColSearch}".`
                  : "Nothing waiting on you right now."}
              </p>
            ) : null}
          </div>
        </article>

        {/* ---------- Column 2: APPROVED ---------- */}
        <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
          <header className="border-b border-ink-100 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Banknote className="h-4 w-4 text-emerald-700" />
                <h2 className="text-sm font-semibold text-ink-1000">
                  Approved
                </h2>
              </div>
              {approvedQ.data ? (
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-700">
                  {approvedQ.data.length}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-ink-500">
              Confirmed and posted. Label design has been unlocked
              for these projects.
            </p>
            <div className="relative mt-3">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
                aria-hidden
              />
              <input
                type="search"
                value={approvedColSearch}
                onChange={(e) => setApprovedColSearch(e.target.value)}
                placeholder="Search…"
                className="h-9 w-full rounded-lg bg-ink-50 pl-9 pr-9 text-xs text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
              />
              {approvedColSearch ? (
                <button
                  type="button"
                  onClick={() => setApprovedColSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </header>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {approvedQ.isLoading ? (
              <p className="p-4 text-center text-xs text-ink-500">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Loading…
              </p>
            ) : approvedRows.length === 0 ? (
              <p className="p-4 text-center text-xs text-ink-500">
                {approvedColSearch
                  ? `Nothing matches "${approvedColSearch}".`
                  : "No approved payments yet."}
              </p>
            ) : (
              approvedRows.map((p) => <PaymentCard key={p.id} payment={p} />)
            )}
          </div>
        </article>

        {/* ---------- Column 3: VOIDED ---------- */}
        <article className="flex min-h-[24rem] flex-col rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
          <header className="border-b border-ink-100 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <X className="h-4 w-4 text-rose-700" />
                <h2 className="text-sm font-semibold text-ink-1000">Voided</h2>
              </div>
              {voidedQ.data ? (
                <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-700">
                  {voidedQ.data.length}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-[11px] text-ink-500">
              Cancelled or reversed — kept here for the audit trail.
            </p>
            <div className="relative mt-3">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
                aria-hidden
              />
              <input
                type="search"
                value={voidedColSearch}
                onChange={(e) => setVoidedColSearch(e.target.value)}
                placeholder="Search…"
                className="h-9 w-full rounded-lg bg-ink-50 pl-9 pr-9 text-xs text-ink-1000 ring-1 ring-inset ring-transparent placeholder:text-ink-400 focus:bg-ink-0 focus:outline-none focus:ring-orange-400"
              />
              {voidedColSearch ? (
                <button
                  type="button"
                  onClick={() => setVoidedColSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </header>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {voidedQ.isLoading ? (
              <p className="p-4 text-center text-xs text-ink-500">
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                Loading…
              </p>
            ) : voidedRows.length === 0 ? (
              <p className="p-4 text-center text-xs text-ink-500">
                {voidedColSearch
                  ? `Nothing matches "${voidedColSearch}".`
                  : "No voided payments."}
              </p>
            ) : (
              voidedRows.map((p) => <PaymentCard key={p.id} payment={p} />)
            )}
          </div>
        </article>
      </div>

      {showCreate && canRecord ? (
        <RecordPaymentDialog
          orgId={orgId}
          prefilledProject={prefilledProject}
          onClose={() => {
            setShowCreate(false);
            setPrefilledProject(null);
          }}
        />
      ) : null}

      {depositDialog && canRecord ? (
        <RecordDepositDialog
          orgId={orgId}
          deposit={depositDialog}
          onClose={() => setDepositDialog(null)}
        />
      ) : null}
    </section>
  );
}


function PendingRow({
  project,
  canRecord,
  onRecord,
}: {
  project: PendingProjectDto;
  canRecord: boolean;
  onRecord: () => void;
}) {
  const since = new Date(project.label_design_created_at);
  const days = Math.max(
    0,
    Math.floor((Date.now() - since.getTime()) / 86_400_000),
  );
  const waitTone =
    days >= 30
      ? "bg-rose-100 text-rose-900"
      : days >= 7
        ? "bg-amber-100 text-amber-900"
        : "bg-emerald-100 text-emerald-900";
  return (
    <tr className="border-t border-ink-100 align-middle hover:bg-ink-50/40">
      <td className="px-3 py-2">
        <div className="font-semibold text-ink-1000">
          {project.formulation_code || "Untitled"}
        </div>
        <div className="text-[11px] text-ink-500">
          {project.formulation_name || ""}
          {project.proposal_code ? ` · ${project.proposal_code}` : ""}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="text-ink-1000">
          {project.customer_company || project.customer_name || "—"}
        </div>
        {project.customer_email ? (
          <div className="text-[11px] text-ink-500">
            {project.customer_email}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${waitTone}`}
        >
          {days === 0 ? "today" : `${days}d`}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        {canRecord ? (
          <button
            type="button"
            onClick={onRecord}
            className="inline-flex items-center gap-1 rounded-md bg-ink-1000 px-2.5 py-1 text-[11px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Plus className="h-3 w-3" /> Record payment
          </button>
        ) : null}
      </td>
    </tr>
  );
}


function DepositRow({
  deposit,
  canRecord,
  onRecord,
}: {
  deposit: AwaitingDepositDto;
  canRecord: boolean;
  onRecord: () => void;
}) {
  const signed = deposit.proposal_accepted_at
    ? new Date(deposit.proposal_accepted_at)
    : null;
  const daysWaiting = signed
    ? Math.max(
        0,
        Math.floor((Date.now() - signed.getTime()) / 86_400_000),
      )
    : null;
  return (
    <tr className="border-t border-ink-100 align-middle">
      <td className="px-3 py-2">
        <div className="font-semibold text-ink-1000">{deposit.proposal_code}</div>
        <div className="text-[11px] text-ink-500">
          {deposit.formulation_name || deposit.formulation_code || "—"}
          {deposit.line_count > 1
            ? ` · +${deposit.line_count - 1} more`
            : ""}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="text-ink-1000">
          {deposit.customer_company || deposit.customer_name || "—"}
        </div>
        {deposit.customer_email ? (
          <div className="text-[11px] text-ink-500">
            {deposit.customer_email}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <div className="font-semibold tabular-nums text-ink-1000">
          {deposit.deposit_amount ?? "—"}{" "}
          <span className="text-ink-500">{deposit.currency}</span>
        </div>
        <div className="text-[11px] text-ink-500">
          {deposit.deposit_percent}% of proposal
        </div>
      </td>
      <td className="px-3 py-2 text-ink-500">
        {signed ? (
          <>
            {signed.toLocaleDateString()}
            {daysWaiting !== null && daysWaiting > 0 ? (
              <span className="ml-1 text-[11px]">
                · {daysWaiting}d
              </span>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {canRecord ? (
          <button
            type="button"
            onClick={onRecord}
            className="inline-flex items-center gap-1 rounded-md bg-ink-1000 px-2 py-1 text-[11px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Plus className="h-3 w-3" /> Record payment
          </button>
        ) : null}
      </td>
    </tr>
  );
}


/** Invoice cell: surfaces attached files with a paperclip + count,
 *  falls back to the plain ``invoice_number`` text, and — when the
 *  row has neither — shows an explicit "Attach" link deep-linking
 *  into the detail page where the upload UI lives. Without this
 *  affordance the list view has no visible path to the upload flow. */
function InvoiceCell({ payment }: { payment: PaymentDto }) {
  const count = payment.invoices.length;
  if (count > 0) {
    return (
      <Link
        href={`/finance/payments/${payment.id}`}
        className="inline-flex items-center gap-1 text-ink-700 hover:text-orange-700"
        title={`${count} file${count === 1 ? "" : "s"} attached`}
      >
        <Paperclip className="h-3.5 w-3.5" />
        <span className="tabular-nums">{count}</span>
        {payment.invoice_number ? (
          <span className="ml-1 text-ink-500">· {payment.invoice_number}</span>
        ) : null}
      </Link>
    );
  }
  if (payment.invoice_number) {
    return <span>{payment.invoice_number}</span>;
  }
  return (
    <Link
      href={`/finance/payments/${payment.id}`}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-700 hover:underline"
    >
      <Paperclip className="h-3 w-3" />
      Attach
    </Link>
  );
}


function PaymentRow({
  payment,
}: {
  payment: PaymentDto;
}) {
  return (
    <tr className="border-t border-ink-100 align-middle">
      <td className="px-3 py-2">
        <Link
          href={`/finance/payments/${payment.id}`}
          className="block font-semibold text-ink-1000 hover:text-orange-700"
        >
          {payment.kind === "deposit"
            ? payment.proposal_code || "Deposit"
            : payment.formulation_code || "Payment"}
        </Link>
        <div className="text-[11px] text-ink-500">
          {payment.kind === "deposit"
            ? "Deposit — bundle-level"
            : payment.formulation_name}
        </div>
      </td>
      <td className="px-3 py-2 font-semibold tabular-nums">
        {payment.amount} {payment.currency}
        {/* Kind chip in the amount cell so it stays visible on
            narrow layouts (the deposit vs final distinction is the
            single most important classification finance uses to
            triage the queue). */}
        <span
          className={
            "ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset " +
            (payment.kind === "deposit"
              ? "bg-amber-100 text-amber-800 ring-amber-300"
              : "bg-sky-100 text-sky-800 ring-sky-300")
          }
          title={
            payment.kind === "deposit"
              ? `Deposit${payment.proposal_deposit_percent ? ` — ${payment.proposal_deposit_percent}% of proposal total` : ""}`
              : "Final payment — unlocks label design"
          }
        >
          {payment.kind === "deposit"
            ? `Dep${payment.proposal_deposit_percent ? ` ${payment.proposal_deposit_percent}%` : ""}`
            : "Final"}
        </span>
      </td>
      <td className="px-3 py-2 capitalize">{payment.method.replace("_", " ")}</td>
      <td className="px-3 py-2">
        <InvoiceCell payment={payment} />
      </td>
      <td className="px-3 py-2 text-ink-500">
        {payment.paid_at
          ? new Date(payment.paid_at).toLocaleDateString()
          : "—"}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={payment.status} />
      </td>
      <td className="px-3 py-2 text-right">
        {/* Approve / Void moved to the detail page so a mis-click on
            the list can't accidentally approve a payment. Row-level
            actions here would sit millimetres from the row link and
            fire the wrong mutation. */}
        <Link
          href={`/finance/payments/${payment.id}`}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-500 hover:text-orange-700"
        >
          Open
        </Link>
      </td>
    </tr>
  );
}


function StatusBadge({ status }: { status: PaymentDto["status"] }) {
  const map: Record<PaymentDto["status"], string> = {
    pending: "bg-amber-100 text-amber-900",
    approved: "bg-emerald-100 text-emerald-900",
    voided: "bg-rose-100 text-rose-900",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${map[status]}`}
    >
      {status}
    </span>
  );
}


function RecordPaymentDialog({
  orgId,
  prefilledProject,
  onClose,
}: {
  orgId: string;
  prefilledProject: PendingProjectDto | null;
  onClose: () => void;
}) {
  const record = useRecordPayment(orgId);

  // Selected project for this dialog session.
  const [selectedProject, setSelectedProject] = useState<
    PendingProjectDto | null
  >(prefilledProject);
  const formulationId = selectedProject?.formulation_id ?? "";

  // Amount + currency are pre-populated from the linked proposal's
  // ``subtotal`` (the figure the customer was quoted). Finance can
  // overwrite if reality differs (partial payment, late fee, etc.) —
  // we just save them a manual lookup in the common case.
  const [amount, setAmount] = useState(prefilledProject?.proposal_amount ?? "");
  const [currency, setCurrency] = useState(
    prefilledProject?.proposal_currency || "GBP",
  );
  // Whether the user has manually overridden the auto-filled amount.
  // We track this so swapping to a different project via "Change"
  // overwrites the amount cleanly when the user hadn't touched it,
  // but preserves whatever the user typed if they did.
  const [amountTouched, setAmountTouched] = useState(false);

  // Re-sync amount/currency when the project changes (via the
  // "Change" link's typed UUID or any other path). Skip if the user
  // already typed a custom amount.
  useEffect(() => {
    if (amountTouched) return;
    setAmount(selectedProject?.proposal_amount ?? "");
    if (selectedProject?.proposal_currency) {
      setCurrency(selectedProject.proposal_currency);
    }
  }, [selectedProject, amountTouched]);
  const [method, setMethod] = useState<
    "bank_transfer" | "card" | "stripe" | "other"
  >("bank_transfer");
  const [externalRef, setExternalRef] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [paidAt, setPaidAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    // Normalise the amount to 2 decimal places before sending —
    // ``Payment.amount`` only accepts 2dp and either the
    // pre-filled value (4dp proposal subtotal) or a user-typed
    // number could carry more. Doing the rounding here so finance
    // never has to think about it. Banker's rounding (half-up)
    // matches the backend's quantize.
    const normalisedAmount = (() => {
      const trimmed = amount.trim();
      if (!trimmed) return trimmed;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return trimmed; // let the backend 400 it
      return n.toFixed(2);
    })();

    try {
      await record.mutateAsync({
        formulation: formulationId,
        amount: normalisedAmount,
        currency,
        method,
        external_reference: externalRef,
        invoice_number: invoiceNumber,
        paid_at: new Date(paidAt).toISOString(),
        notes,
      });
      onClose();
    } catch (e) {
      // App-wide errors are normalised into ``ApiError`` (see
      // ``src/lib/api/errors.ts``). 400 / validation errors land on
      // ``fieldErrors`` keyed by field name with arrays of DRF
      // codes (e.g. ``{ amount: ["max_decimal_places"] }``). We
      // surface that as ``field: human-readable code`` so finance
      // sees the actual cause in the dialog, not the generic axios
      // "Request failed with status code 400".
      // eslint-disable-next-line no-console
      console.error("Record payment failed:", e);
      setErr(formatPaymentError(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-ink-0 p-5 shadow-lg">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-ink-1000">
            <Banknote className="h-4 w-4" /> Record payment
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-ink-500 hover:text-ink-700"
          >
            ✕
          </button>
        </header>
        <form onSubmit={onSubmit} className="space-y-2">
          <FormRow label="Project">
            {selectedProject ? (
              <div className="flex items-start justify-between gap-2 rounded-md bg-ink-50 px-3 py-2 ring-1 ring-ink-200">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                    {selectedProject.formulation_code || "Project"}
                  </p>
                  <p className="truncate text-sm font-semibold text-ink-1000">
                    {selectedProject.formulation_name || "Untitled"}
                  </p>
                  <p className="truncate text-[11px] text-ink-500">
                    {selectedProject.customer_company ||
                      selectedProject.customer_name ||
                      "—"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedProject(null)}
                  className="text-[10px] font-semibold uppercase tracking-wide text-ink-500 hover:text-ink-700"
                >
                  Change
                </button>
              </div>
            ) : (
              <input
                required
                value={formulationId}
                onChange={(e) =>
                  setSelectedProject({
                    formulation_id: e.target.value,
                    formulation_code: "",
                    formulation_name: "",
                    label_design_id: "",
                    label_design_created_at: "",
                    proposal_code: "",
                    proposal_id: null,
                    proposal_amount: null,
                    proposal_currency: "",
                    customer_name: "",
                    customer_company: "",
                    customer_email: "",
                  })
                }
                placeholder="Paste project UUID (ad-hoc payment)"
                className="w-full rounded border border-ink-200 px-2 py-1.5 font-mono text-xs"
              />
            )}
          </FormRow>
          <div className="grid grid-cols-2 gap-2">
            <FormRow label="Amount">
              <input
                required
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountTouched(true);
                }}
                inputMode="decimal"
                className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
              />
              {selectedProject?.proposal_amount &&
              amount === selectedProject.proposal_amount ? (
                <p className="mt-1 text-[10px] text-ink-500">
                  Pre-filled from proposal{" "}
                  {selectedProject.proposal_code || ""} subtotal.
                </p>
              ) : null}
            </FormRow>
            <FormRow label="Currency">
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
              />
            </FormRow>
          </div>
          <FormRow label="Method">
            <select
              value={method}
              onChange={(e) =>
                setMethod(
                  e.target.value as
                    | "bank_transfer"
                    | "card"
                    | "stripe"
                    | "other",
                )
              }
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="card">Card</option>
              <option value="stripe">Stripe</option>
              <option value="other">Other</option>
            </select>
          </FormRow>
          <FormRow label="External reference">
            <input
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          <FormRow label="Invoice number">
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          <FormRow label="Paid at">
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          <FormRow label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          {err ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
            >
              {err}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={record.isPending}
              className="rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
            >
              {record.isPending ? "Saving…" : "Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


/** Deposit-side record dialog. Sibling of ``RecordPaymentDialog`` for
 *  finals — different preset shape (proposal + expected amount + %),
 *  posts with ``kind: "deposit"`` and the proposal FK instead of a
 *  formulation FK. */
function RecordDepositDialog({
  orgId,
  deposit,
  onClose,
}: {
  orgId: string;
  deposit: AwaitingDepositDto;
  onClose: () => void;
}) {
  const record = useRecordPayment(orgId);
  const [amount, setAmount] = useState(deposit.deposit_amount ?? "");
  const [currency, setCurrency] = useState(deposit.currency || "GBP");
  const [method, setMethod] = useState<
    "bank_transfer" | "card" | "stripe" | "other"
  >("bank_transfer");
  const [externalRef, setExternalRef] = useState("");
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null);
  const [paidAt, setPaidAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // Tracks the second step (file upload) so the button stays in
  // "Saving…" state across both create + upload rather than flickering
  // back to idle mid-flow.
  const [uploading, setUploading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const normalisedAmount = (() => {
      const trimmed = amount.trim();
      if (!trimmed) return trimmed;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return trimmed;
      return n.toFixed(2);
    })();
    let created: PaymentDto;
    try {
      created = await record.mutateAsync({
        kind: "deposit",
        proposal: deposit.proposal_id,
        amount: normalisedAmount,
        currency,
        method,
        external_reference: externalRef,
        paid_at: new Date(paidAt).toISOString(),
        notes,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Record deposit failed:", e);
      setErr(formatPaymentError(e));
      return;
    }
    // Payment row exists now. Attach the invoice as a second step —
    // the upload endpoint is keyed on payment_id, so it needs the
    // row to exist first. If the upload fails we surface the error
    // without discarding the Payment (better than losing the record);
    // the user can retry the upload from the detail page.
    if (invoiceFile) {
      setUploading(true);
      try {
        await uploadPaymentInvoice(orgId, created.id, invoiceFile);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Invoice upload failed:", e);
        setErr(
          "Payment recorded, but the invoice file didn't upload. " +
            "You can attach it from the payment detail page.",
        );
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-ink-0 p-5 shadow-lg">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-ink-1000">
            <Banknote className="h-4 w-4" /> Record deposit
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-ink-500 hover:text-ink-700"
          >
            ✕
          </button>
        </header>
        <form onSubmit={onSubmit} className="space-y-2">
          <FormRow label="Proposal">
            <div className="rounded-md bg-amber-50 px-3 py-2 ring-1 ring-amber-200">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                {deposit.proposal_code} · {deposit.deposit_percent}% deposit
              </p>
              <p className="truncate text-sm font-semibold text-ink-1000">
                {deposit.customer_company ||
                  deposit.customer_name ||
                  "—"}
              </p>
              {deposit.formulation_name || deposit.formulation_code ? (
                <p className="truncate text-[11px] text-ink-500">
                  {deposit.formulation_name || deposit.formulation_code}
                  {deposit.line_count > 1
                    ? ` · +${deposit.line_count - 1} more`
                    : ""}
                </p>
              ) : null}
            </div>
          </FormRow>
          <div className="grid grid-cols-2 gap-2">
            <FormRow label="Amount">
              <input
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
              />
              {deposit.deposit_amount &&
              amount === deposit.deposit_amount ? (
                <p className="mt-1 text-[10px] text-ink-500">
                  Pre-filled — {deposit.deposit_percent}% of{" "}
                  {deposit.proposal_code} subtotal.
                </p>
              ) : null}
            </FormRow>
            <FormRow label="Currency">
              <input
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
              />
            </FormRow>
          </div>
          <FormRow label="Method">
            <select
              value={method}
              onChange={(e) =>
                setMethod(
                  e.target.value as
                    | "bank_transfer"
                    | "card"
                    | "stripe"
                    | "other",
                )
              }
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            >
              <option value="bank_transfer">Bank transfer</option>
              <option value="card">Card</option>
              <option value="stripe">Stripe</option>
              <option value="other">Other</option>
            </select>
          </FormRow>
          <FormRow label="External reference">
            <input
              value={externalRef}
              onChange={(e) => setExternalRef(e.target.value)}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          <FormRow label="Invoice file">
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
              onChange={(e) =>
                setInvoiceFile(e.target.files?.[0] ?? null)
              }
              className="block w-full text-xs text-ink-700 file:mr-2 file:rounded file:border-0 file:bg-ink-100 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-ink-700 hover:file:bg-ink-200"
            />
            <p className="mt-1 text-[10px] text-ink-500">
              {invoiceFile
                ? `${invoiceFile.name} · ${(invoiceFile.size / 1024).toFixed(1)} KB`
                : "PDF / image / Office doc (max 20 MB). Optional — you can attach it later from the payment detail page."}
            </p>
          </FormRow>
          <FormRow label="Paid at">
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          <FormRow label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded border border-ink-200 px-2 py-1.5 text-xs"
            />
          </FormRow>
          {err ? (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
            >
              {err}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-ink-100 px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={record.isPending || uploading}
              className="rounded-md bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
            >
              {record.isPending
                ? "Saving…"
                : uploading
                  ? "Uploading invoice…"
                  : "Record"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


function FormRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}


/* --------------------------------------------------------------
 * Card components used by the pipeline layout. Each is the same
 * data as its ``*Row`` sibling above but rendered as a compact
 * vertical card so it fits the narrow column widths.
 * -------------------------------------------------------------- */


function PaymentCard({ payment }: { payment: PaymentDto }) {
  const customerLabel = payment.customer_company || payment.customer_name;
  return (
    <Link
      href={`/finance/payments/${payment.id}`}
      className="block rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm hover:border-ink-200 hover:shadow"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {payment.kind === "deposit"
              ? payment.proposal_code || "Deposit"
              : payment.formulation_code || "Payment"}
          </p>
          <p className="truncate text-[11px] text-ink-500">
            {payment.kind === "deposit"
              ? "Deposit — bundle-level"
              : payment.formulation_name}
          </p>
        </div>
        <span
          className={
            "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1 ring-inset " +
            (payment.kind === "deposit"
              ? "bg-amber-100 text-amber-800 ring-amber-300"
              : "bg-sky-100 text-sky-800 ring-sky-300")
          }
        >
          {payment.kind === "deposit"
            ? `Dep${payment.proposal_deposit_percent ? ` ${payment.proposal_deposit_percent}%` : ""}`
            : "Final"}
        </span>
      </div>
      {customerLabel ? (
        <p className="mt-1 truncate text-[11px] text-ink-600">
          {customerLabel}
        </p>
      ) : null}
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums text-ink-1000">
          {payment.amount} {payment.currency}
        </p>
        <StatusBadge status={payment.status} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-ink-500">
        <span className="capitalize">{payment.method.replace("_", " ")}</span>
        <span>
          {payment.paid_at
            ? new Date(payment.paid_at).toLocaleDateString()
            : "—"}
        </span>
      </div>
    </Link>
  );
}


function PendingCard({
  project,
  canRecord,
  onRecord,
}: {
  project: PendingProjectDto;
  canRecord: boolean;
  onRecord: () => void;
}) {
  const created = new Date(project.label_design_created_at);
  const days = Math.max(
    0,
    Math.floor((Date.now() - created.getTime()) / 86_400_000),
  );
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {project.formulation_code}
          </p>
          <p className="truncate text-[11px] text-ink-500">
            {project.formulation_name}
          </p>
        </div>
      </div>
      {(project.customer_company || project.customer_name) ? (
        <p className="mt-1 truncate text-[11px] text-ink-600">
          {project.customer_company || project.customer_name}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-ink-500">
          {days === 0 ? "Today" : `${days}d waiting`}
        </span>
        {canRecord ? (
          <button
            type="button"
            onClick={onRecord}
            className="rounded-md bg-ink-1000 px-2 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900"
          >
            <Plus className="inline h-3 w-3" /> Record
          </button>
        ) : null}
      </div>
    </div>
  );
}


function DepositCard({
  deposit,
  canRecord,
  onRecord,
}: {
  deposit: AwaitingDepositDto;
  canRecord: boolean;
  onRecord: () => void;
}) {
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-0 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink-1000">
            {deposit.proposal_code || "Proposal"}
          </p>
          <p className="truncate text-[11px] text-ink-500">
            {deposit.formulation_name}
          </p>
        </div>
      </div>
      {(deposit.customer_company || deposit.customer_name) ? (
        <p className="mt-1 truncate text-[11px] text-ink-600">
          {deposit.customer_company || deposit.customer_name}
        </p>
      ) : null}
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums text-ink-1000">
          {deposit.deposit_amount ?? "—"}{" "}
          <span className="text-[10px] text-ink-500">{deposit.currency}</span>
        </p>
        <span className="text-[10px] text-ink-500">
          {deposit.deposit_percent}%
        </span>
      </div>
      {canRecord ? (
        <button
          type="button"
          onClick={onRecord}
          className="mt-2 w-full rounded-md bg-ink-1000 px-2 py-1 text-[10px] font-semibold text-ink-0 hover:bg-ink-900"
        >
          <Plus className="inline h-3 w-3" /> Record deposit
        </button>
      ) : null}
    </div>
  );
}
