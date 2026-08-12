"use client";

/**
 * Single-payment detail page — full traceability for a finance team
 * member or auditor. Shows everything the list row had to omit:
 *
 * * Amount + currency + paid date + method + reference + invoice
 * * Recorded-by (user + when), approved-by (user + when), voided
 *   state (yes / no, when), assigned finance officer
 * * Linked label-design row with a deep link to the labelling
 *   workspace so the same project context is one click away
 * * Approve + void actions for cap-holders (gated by ``canApprove``)
 *
 * Mirror in shape of the labelling workspace's audit card — same
 * hero + grid of metadata cards so a finance reviewer scanning the
 * page feels at home if they've used the labelling page.
 */

import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  Loader2,
  Pencil,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import { useMemberships } from "@/services/members";
import {
  useApprovePayment,
  useAssignPaymentFinanceOfficer,
  useDeletePaymentInvoice,
  usePatchPayment,
  usePayment,
  usePspInvoicesForPayment,
  useUploadPaymentInvoice,
  useVoidPayment,
  type PaymentDto,
  type PaymentInvoiceDto,
  type PaymentStatus,
  type PspInvoiceDto,
} from "@/services/payments";


const STATUS_TONE: Record<PaymentStatus, string> = {
  pending: "bg-amber-50 text-amber-800 ring-amber-200",
  approved: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  voided: "bg-rose-50 text-rose-800 ring-rose-200",
};

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: "Pending approval",
  approved: "Approved",
  voided: "Voided",
};

const STATUS_ICON: Record<PaymentStatus, typeof Clock> = {
  pending: Clock,
  approved: CheckCircle2,
  voided: XCircle,
};


export function PaymentDetail({
  orgId,
  paymentId,
  canApprove,
  canEdit,
  canAssignOfficer,
}: {
  orgId: string;
  paymentId: string;
  canApprove: boolean;
  /** ``finance.record_payment`` holders can edit the mutable
   *  subset of a pending payment (notes / invoice / paid date /
   *  etc). Approved or voided rows are locked server-side. */
  canEdit: boolean;
  /** ``finance.assign_officer`` holders can pick or clear the
   *  finance officer pointer on the row. */
  canAssignOfficer: boolean;
}) {
  const { data, isLoading, error } = usePayment(orgId, paymentId);

  if (isLoading) {
    return (
      <p className="mt-6 inline-flex items-center gap-2 text-sm text-ink-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading payment…
      </p>
    );
  }
  if (error || !data) {
    return (
      <p className="mt-6 text-sm text-danger">
        Couldn&rsquo;t load that payment.{" "}
        <Link href="/finance/payments" className="underline">
          Back to list
        </Link>
        .
      </p>
    );
  }

  const StatusIcon = STATUS_ICON[data.status];
  const tone = STATUS_TONE[data.status];

  return (
    <section className="mt-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/finance/payments"
            className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-700"
          >
            <ArrowLeft className="h-3 w-3" />
            Back to payments
          </Link>
          <h1 className="mt-1 text-lg font-semibold text-ink-1000">
            {data.invoice_number || "Payment"}{" "}
            <span className="text-ink-500">
              ·{" "}
              {data.kind === "deposit"
                ? data.proposal_code || "proposal"
                : data.formulation_code || data.formulation_name || "project"}
            </span>
          </h1>
          <p className="mt-1 inline-flex items-center gap-2 text-xs font-medium">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset ${tone}`}
            >
              <StatusIcon className="h-3 w-3" />
              {STATUS_LABEL[data.status]}
            </span>
            {/* Kind chip — makes the two gates visually distinct at a
                glance. Amber for deposit (money-in before work starts),
                sky for final (money-in before labelling). */}
            <span
              className={
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset " +
                (data.kind === "deposit"
                  ? "bg-amber-100 text-amber-800 ring-amber-300"
                  : "bg-sky-100 text-sky-800 ring-sky-300")
              }
              title={
                data.kind === "deposit"
                  ? `Deposit (${data.proposal_deposit_percent ?? "?"}% of proposal total) — unlocks trial batches`
                  : "Final payment — unlocks label design"
              }
            >
              {data.kind === "deposit"
                ? `Deposit${data.proposal_deposit_percent ? ` · ${data.proposal_deposit_percent}%` : ""}`
                : "Final"}
            </span>
          </p>
        </div>
        {canApprove ? (
          <PaymentDetailActions
            orgId={orgId}
            paymentId={data.id}
            status={data.status}
          />
        ) : null}
      </header>
      <Grid
        orgId={orgId}
        payment={data}
        canEdit={canEdit && data.status === "pending"}
        canAssignOfficer={canAssignOfficer}
      />
    </section>
  );
}


function Grid({
  orgId,
  payment,
  canEdit,
  canAssignOfficer,
}: {
  orgId: string;
  payment: PaymentDto;
  canEdit: boolean;
  canAssignOfficer: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // PSP invoice mirror — lifted here so we can hide the manual
  // "Attach invoice" reminder card when PSP already has invoices
  // (the reminder is meaningless when the real invoice exists).
  // Silent-degrades to ``supported: true, invoices: []`` on any
  // failure so the manual card stays as fallback.
  const pspInvoices = usePspInvoicesForPayment(orgId, payment.id);
  const pspHasInvoices = (pspInvoices.data?.invoices.length ?? 0) > 0;

  if (editing) {
    return (
      <EditForm
        orgId={orgId}
        payment={payment}
        onClose={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Amount">
        <p className="text-2xl font-semibold text-ink-1000">
          {payment.amount}{" "}
          <span className="text-sm font-medium text-ink-500">
            {payment.currency}
          </span>
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Paid {new Date(payment.paid_at).toLocaleDateString()} · via{" "}
          {payment.method.replace(/_/g, " ")}
        </p>
      </Card>

      <Card title="Recorded by">
        <p className="text-sm font-medium text-ink-1000">
          {payment.recorded_by_email || "—"}
        </p>
        <p className="mt-1 text-xs text-ink-500">
          On {new Date(payment.created_at).toLocaleString()}
        </p>
      </Card>

      <Card title="Approved by">
        {payment.approved_by_email ? (
          <>
            <p className="text-sm font-medium text-ink-1000">
              {payment.approved_by_email}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              On{" "}
              {payment.approved_at
                ? new Date(payment.approved_at).toLocaleString()
                : "—"}
            </p>
          </>
        ) : (
          <p className="text-sm italic text-ink-500">Awaiting approval</p>
        )}
      </Card>

      <Card title="Finance officer">
        {canAssignOfficer ? (
          <FinanceOfficerPicker orgId={orgId} payment={payment} />
        ) : (
          <p className="text-sm font-medium text-ink-1000">
            {payment.assigned_finance_officer_email || (
              <span className="italic text-ink-500">Unassigned</span>
            )}
          </p>
        )}
      </Card>

      <Card title="Invoice / reference">
        <p className="text-sm font-medium text-ink-1000">
          {payment.invoice_number || (
            <span className="italic text-ink-500">No invoice number</span>
          )}
        </p>
        {payment.external_reference ? (
          <p className="mt-1 break-all text-xs text-ink-500">
            Ref: {payment.external_reference}
          </p>
        ) : null}
      </Card>

      <Card
        title={
          payment.kind === "deposit"
            ? "Linked proposal"
            : "Linked label design"
        }
      >
        {payment.kind === "deposit" ? (
          payment.proposal ? (
            <Link
              href={`/proposals/${payment.proposal}`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 hover:underline"
            >
              <ShieldCheck className="h-4 w-4" />
              Open {payment.proposal_code || "proposal"}
            </Link>
          ) : (
            <p className="text-sm italic text-ink-500">No proposal linked</p>
          )
        ) : payment.label_design ? (
          <Link
            href={`/labelling/${payment.label_design}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:underline"
          >
            <ShieldCheck className="h-4 w-4" />
            Open workspace
          </Link>
        ) : (
          <p className="text-sm italic text-ink-500">
            No label workflow linked
          </p>
        )}
      </Card>

      {/* PSP invoices come first — they're the source of truth for
          what got billed. When PSP has them, the manual "attach an
          invoice PDF" reminder below is suppressed (would be noise).
          Manual attachments only re-appear as a fallback when PSP
          has nothing (integration off / no invoice raised yet) OR
          when historic manual files exist. */}
      <div className="lg:col-span-3">
        <PspInvoicesCard orgId={orgId} paymentId={payment.id} />
      </div>

      {(!pspHasInvoices || payment.invoices.length > 0) && (
        <div className="lg:col-span-3">
          <InvoiceFilesCard
            orgId={orgId}
            paymentId={payment.id}
            invoices={payment.invoices}
            canEdit={canEdit}
          />
        </div>
      )}

      <Card title="Notes" className="lg:col-span-3">
        {payment.notes ? (
          <p className="whitespace-pre-line text-sm text-ink-800">
            {payment.notes}
          </p>
        ) : (
          <p className="text-sm italic text-ink-500">No notes recorded.</p>
        )}
      </Card>

      {canEdit ? (
        <div className="lg:col-span-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-xs font-semibold text-ink-1000 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit payment details
          </button>
          <p className="mt-1 text-[11px] text-ink-500">
            Only available while the payment is pending. After approval, void
            and re-record to make corrections.
          </p>
        </div>
      ) : null}
    </div>
  );
}


/** Finance-officer pill + dropdown menu. Scoped to members tagged
 *  ``finance`` so the picker doesn't surface every sales /
 *  scientist user. Mirrors the labelling workspace's designer
 *  picker visually. */
function FinanceOfficerPicker({
  orgId,
  payment,
}: {
  orgId: string;
  payment: PaymentDto;
}) {
  const [open, setOpen] = useState(false);
  const members = useMemberships(orgId, {
    enabled: open,
    group: "finance",
  });
  const assign = useAssignPaymentFinanceOfficer(orgId, payment.id);
  const options = useMemo(() => {
    const rows = members.data ?? [];
    return rows
      .map((m) => ({
        id: m.user.id,
        label:
          m.user.full_name?.trim() || m.user.email || "(unnamed)",
        email: m.user.email,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [members.data]);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink-1000">
        {payment.assigned_finance_officer_email || (
          <span className="italic text-ink-500">Unassigned</span>
        )}
      </p>
      <select
        value={payment.assigned_finance_officer ?? ""}
        onFocus={() => setOpen(true)}
        onChange={(e) =>
          assign.mutate(e.target.value ? e.target.value : null)
        }
        disabled={assign.isPending}
        className="w-full rounded-md border-0 bg-ink-0 px-2 py-1.5 text-xs font-medium text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">— Unassigned —</option>
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {options.length === 0 && members.isFetched ? (
        <p className="text-[10px] text-ink-500">
          No members tagged{" "}
          <code className="rounded bg-ink-100 px-1">finance</code> yet.
        </p>
      ) : null}
    </div>
  );
}


/** Inline edit form. Submits a PATCH with whichever fields the
 *  user touched. Backend rejects edits on non-pending rows. */
function EditForm({
  orgId,
  payment,
  onClose,
}: {
  orgId: string;
  payment: PaymentDto;
  onClose: () => void;
}) {
  const patch = usePatchPayment(orgId, payment.id);
  const [amount, setAmount] = useState(payment.amount);
  const [currency, setCurrency] = useState(payment.currency);
  const [method, setMethod] = useState(payment.method);
  const [externalReference, setExternalReference] = useState(
    payment.external_reference,
  );
  const [invoiceNumber, setInvoiceNumber] = useState(payment.invoice_number);
  const [paidAt, setPaidAt] = useState(payment.paid_at.slice(0, 16));
  const [notes, setNotes] = useState(payment.notes);
  const [err, setErr] = useState<string | null>(null);

  // Sync local state if the underlying payment is refetched mid-edit.
  useEffect(() => {
    setAmount(payment.amount);
    setCurrency(payment.currency);
  }, [payment.amount, payment.currency]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await patch.mutateAsync({
        amount,
        currency,
        method,
        external_reference: externalReference,
        invoice_number: invoiceNumber,
        paid_at: new Date(paidAt).toISOString(),
        notes,
      });
      onClose();
    } catch (e) {
      const detail = (
        e as { response?: { data?: { detail?: string } } }
      )?.response?.data?.detail;
      setErr(detail ?? "Couldn't save the changes.");
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-2xl bg-ink-0 p-5 ring-1 ring-ink-200"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-1000">
          Edit payment
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
          aria-label="Cancel edit"
        >
          <XCircle className="h-4 w-4" />
        </button>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount">
          <input
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label="Currency">
          <input
            type="text"
            maxLength={3}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label="Method">
          <select
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as PaymentDto["method"])
            }
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          >
            <option value="bank_transfer">Bank transfer</option>
            <option value="card">Card</option>
            <option value="stripe">Stripe</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Paid at">
          <input
            type="datetime-local"
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label="Invoice number">
          <input
            type="text"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label="External reference">
          <input
            type="text"
            value={externalReference}
            onChange={(e) => setExternalReference(e.target.value)}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
        <Field label="Notes" full>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md bg-ink-50 px-3 py-2 text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </Field>
      </div>

      {err ? (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-inset ring-rose-200">
          {err}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-2 text-xs font-semibold text-ink-700 hover:bg-ink-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={patch.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-2 text-xs font-semibold text-ink-0 hover:bg-ink-900 disabled:opacity-50"
        >
          {patch.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save changes
        </button>
      </div>
    </form>
  );
}


function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={`block ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}


function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <article
      className={`rounded-2xl bg-ink-0 p-5 ring-1 ring-ink-200 ${className ?? ""}`}
    >
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </article>
  );
}


const _MAX_INVOICE_MB = 20;


function _formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


/** Attached invoice files (PDFs, scans of paper receipts, etc.).
 *  Always renders download links so an approved / voided payment
 *  still surfaces its audit evidence. Upload + delete only when
 *  ``canEdit`` — same gate as the "Edit payment details" button. */
function InvoiceFilesCard({
  orgId,
  paymentId,
  invoices,
  canEdit,
}: {
  orgId: string;
  paymentId: string;
  invoices: ReadonlyArray<PaymentInvoiceDto>;
  canEdit: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useUploadPaymentInvoice(orgId, paymentId);
  const remove = useDeletePaymentInvoice(orgId, paymentId);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onPick = (file: File | null) => {
    if (!file) return;
    setUploadError(null);
    if (file.size > _MAX_INVOICE_MB * 1024 * 1024) {
      setUploadError(`File too large — max ${_MAX_INVOICE_MB} MB.`);
      return;
    }
    upload.mutate(file, {
      onError: (err: unknown) => {
        const msg =
          (err as { response?: { data?: { detail?: string } } })?.response
            ?.data?.detail || "Upload failed.";
        setUploadError(msg);
      },
      onSuccess: () => {
        if (inputRef.current) inputRef.current.value = "";
      },
    });
  };

  return (
    <Card title="Invoice files">
      {invoices.length === 0 ? (
        <p className="text-sm italic text-ink-500">
          No invoice attached yet.
          {canEdit
            ? " Upload the invoice PDF you sent the customer so it's on the audit trail."
            : ""}
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {invoices.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
            >
              <FileText className="h-4 w-4 shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-1000">
                  {f.filename}
                </p>
                <p className="text-xs text-ink-500">
                  {_formatFileSize(f.byte_size)} · Uploaded by{" "}
                  {f.uploaded_by_email || "—"} ·{" "}
                  {new Date(f.uploaded_at).toLocaleDateString()}
                </p>
              </div>
              {f.url ? (
                <a
                  href={f.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  <Download className="h-3 w-3" />
                  Open
                </a>
              ) : null}
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => {
                    if (remove.isPending) return;
                    if (
                      window.confirm(
                        `Remove "${f.filename}" from this payment?`,
                      )
                    ) {
                      remove.mutate(f.id);
                    }
                  }}
                  disabled={remove.isPending}
                  className="inline-flex items-center rounded-md p-1 text-ink-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                  aria-label={`Delete ${f.filename}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="mt-3 flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-2 text-xs font-semibold text-ink-0 hover:bg-ink-800">
            {upload.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {upload.isPending ? "Uploading…" : "Attach invoice"}
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept="application/pdf,image/jpeg,image/png,image/webp,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
              onChange={(e) => onPick(e.target.files?.[0] ?? null)}
              disabled={upload.isPending}
            />
          </label>
          <p className="text-[11px] text-ink-500">
            PDF, image, or Office doc up to {_MAX_INVOICE_MB} MB.
          </p>
        </div>
      ) : null}
      {uploadError ? (
        <p className="mt-2 text-xs text-rose-700">{uploadError}</p>
      ) : null}
    </Card>
  );
}


/** PSP-side CustomerInvoices for the CO this payment mirrors.
 *  Purely read-only — surfaces the "already invoiced on PSP" state
 *  so the accountant doesn't have to switch to PSP to answer
 *  "has an invoice been raised against this order?". Hidden
 *  entirely on payment kinds that don't map to a PSP CO (deposits
 *  today) via the backend's ``supported: false`` signal. */
function PspInvoicesCard({
  orgId,
  paymentId,
}: {
  orgId: string;
  paymentId: string;
}) {
  const query = usePspInvoicesForPayment(orgId, paymentId);

  // Hide the card on unsupported payment kinds (deposit) — no CO
  // to mirror, so the card would always read "no invoices" which
  // looks like an operator problem it isn't.
  if (query.data && !query.data.supported) return null;

  const invoices = query.data?.invoices ?? [];

  return (
    <Card title="Invoices on PSP">
      {query.isLoading ? (
        <p className="inline-flex items-center gap-2 text-sm text-ink-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Fetching from PSP…
        </p>
      ) : invoices.length === 0 ? (
        <p className="text-sm italic text-ink-500">
          No invoice raised on PSP for this order yet. Invoices generated
          on PSP will show here automatically.
        </p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {invoices.map((inv) => (
            <PspInvoiceRow key={inv.uuid} invoice={inv} />
          ))}
        </ul>
      )}
    </Card>
  );
}


function PspInvoiceRow({ invoice }: { invoice: PspInvoiceDto }) {
  const tone = _PSP_INVOICE_STATUS_TONE[invoice.status] ?? _PSP_INVOICE_STATUS_TONE.default;
  const total = _formatPspMoney(invoice.grand_total, invoice.currency_code);
  const dateLabel = invoice.invoice_date
    ? new Date(invoice.invoice_date).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Draft";

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-700">
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-ink-1000">{total}</p>
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${tone}`}
          >
            {invoice.status.replace(/_/g, " ")}
          </span>
          {invoice.kind !== "invoice" ? (
            <span className="inline-flex rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium text-ink-700">
              {invoice.kind.replace(/_/g, " ")}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-[11px] text-ink-500">
          {dateLabel}
          {invoice.due_date ? (
            <>
              {" · Due "}
              {new Date(invoice.due_date).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </>
          ) : null}
        </p>
      </div>
    </li>
  );
}


// Status → chip tone. Mirrors PSP's own invoice status palette so
// an operator crossing between apps sees the same colours.
const _PSP_INVOICE_STATUS_TONE: Record<string, string> = {
  draft: "bg-ink-100 text-ink-700 ring-ink-200",
  sent: "bg-sky-50 text-sky-800 ring-sky-200",
  paid: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  cancelled: "bg-rose-50 text-rose-800 ring-rose-200",
  default: "bg-ink-100 text-ink-700 ring-ink-200",
};


// Currency-code + amount formatter. PSP ships amounts as decimal
// strings (never touched by JS math); we render them verbatim to
// avoid precision drift, prefixed with the currency's symbol where
// we have a mapping.
const _PSP_CURRENCY_SYMBOLS: Record<string, string> = {
  GBP: "£",
  EUR: "€",
  USD: "$",
};


function _formatPspMoney(amount: string, currency: string): string {
  const sym = _PSP_CURRENCY_SYMBOLS[currency] || currency;
  return `${sym} ${amount}`;
}


/** Real org-bound action buttons rendered on top of the page when
 *  ``canApprove`` AND the payment is still pending. Approve flips
 *  to ``approved`` and unlocks the label workflow; Void marks the
 *  payment ``voided`` with a free-text reason that's persisted on
 *  the row's notes field. */
export function PaymentDetailActions({
  orgId,
  paymentId,
  status,
}: {
  orgId: string;
  paymentId: string;
  status: PaymentStatus;
}) {
  const approve = useApprovePayment(orgId);
  const voidIt = useVoidPayment(orgId);
  const [voidPrompt, setVoidPrompt] = useState(false);
  const [voidNotes, setVoidNotes] = useState("");
  if (status !== "pending") return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <button
        type="button"
        disabled={approve.isPending}
        onClick={() => approve.mutate(paymentId)}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-semibold text-ink-0 hover:bg-emerald-700 disabled:opacity-50"
      >
        {approve.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5" />
        )}
        Approve payment
      </button>
      {voidPrompt ? (
        <div className="flex flex-col gap-2 rounded-lg bg-ink-0 p-3 ring-1 ring-ink-200">
          <textarea
            value={voidNotes}
            onChange={(e) => setVoidNotes(e.target.value)}
            rows={2}
            placeholder="Reason for voiding (optional)"
            className="w-72 rounded-md border-0 bg-ink-50 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-rose-400"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setVoidPrompt(false)}
              className="rounded-md px-2 py-1 text-[11px] text-ink-500 hover:bg-ink-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={voidIt.isPending}
              onClick={() =>
                voidIt.mutate(
                  { paymentId, notes: voidNotes },
                  { onSuccess: () => setVoidPrompt(false) },
                )
              }
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-ink-0 hover:bg-rose-700 disabled:opacity-50"
            >
              {voidIt.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <XCircle className="h-3 w-3" />
              )}{" "}
              Confirm void
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setVoidPrompt(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50"
        >
          <XCircle className="h-3.5 w-3.5" />
          Void
        </button>
      )}
    </div>
  );
}
