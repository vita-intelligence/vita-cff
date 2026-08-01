"use client";

import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { type DepositGateDto } from "@/services/formulations/types";

/**
 * Bright banner shown across every tab of the project workspace when
 * the accepted proposal's deposit hasn't been paid yet. Mirrors the
 * pre-labelling PAYMENT_PENDING banner pattern — same tone, same
 * "waiting on finance" copy shape — so scientists learn the surface
 * once and read it consistently across both gates.
 *
 * Self-hides for:
 * - Projects with no accepted proposal (``reason = "no_proposal"``)
 * - Proposals quoted with 0% deposit (``reason = "no_deposit_required"``)
 * - Deposits that are already approved (``reason = "deposit_paid"``)
 *
 * When approved a small emerald confirmation appears once — cleared
 * by the parent view when the project advances into trial batches.
 */
export function DepositGateBanner({ gate }: { gate: DepositGateDto }) {
  if (gate.reason === "no_proposal" || gate.reason === "no_deposit_required") {
    return null;
  }

  if (gate.reason === "deposit_paid") {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-emerald-300/80 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          Deposit received for {gate.proposal_code} — trial batches unlocked.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm shadow-sm dark:border-amber-500/60 dark:bg-amber-950/40 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2 sm:items-center">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300 sm:mt-0" />
        <div>
          <p className="font-semibold text-amber-900 dark:text-amber-100">
            Trial batches locked — awaiting deposit
          </p>
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-200/80">
            {gate.proposal_code
              ? `${gate.deposit_percent}% deposit on ${gate.proposal_code} hasn't been received by finance yet. Trial batches unlock the moment the payment is recorded and approved.`
              : "Awaiting finance to confirm the customer deposit."}
          </p>
        </div>
      </div>
      {gate.pending_payment_id ? (
        <Link
          href={`/finance/payments/${gate.pending_payment_id}`}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/70 bg-white px-3 py-1.5 text-xs font-semibold text-amber-800 shadow-sm transition-colors hover:bg-amber-100 dark:border-amber-600/70 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          View in finance <ArrowRight className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}
