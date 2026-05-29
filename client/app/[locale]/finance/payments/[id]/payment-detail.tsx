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
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { Link } from "@/i18n/navigation";
import {
  useApprovePayment,
  usePayment,
  useVoidPayment,
  type PaymentDto,
  type PaymentStatus,
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
}: {
  orgId: string;
  paymentId: string;
  canApprove: boolean;
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
              {data.formulation_code || data.formulation_name || "project"}
            </span>
          </h1>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 ring-1 ring-inset ${tone}`}
            >
              <StatusIcon className="h-3 w-3" />
              {STATUS_LABEL[data.status]}
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
      <Grid payment={data} />
    </section>
  );
}


function Grid({ payment }: { payment: PaymentDto }) {
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
        <p className="text-sm font-medium text-ink-1000">
          {payment.assigned_finance_officer_email || (
            <span className="italic text-ink-500">Unassigned</span>
          )}
        </p>
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

      <Card title="Linked label design">
        {payment.label_design ? (
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

      {payment.notes ? (
        <Card title="Notes" className="lg:col-span-3">
          <p className="whitespace-pre-line text-sm text-ink-800">
            {payment.notes}
          </p>
        </Card>
      ) : null}
    </div>
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
