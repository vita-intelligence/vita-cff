"use client";

/**
 * Client-side "Request dispatch" affordance for the NPD warehouse
 * page. One instance per lot card — renders the button, owns the
 * dialog state, POSTs to /api/portal/warehouse/dispatch-requests/,
 * and refreshes the server-component parent on success so the lot's
 * on-hand qty + summary tiles update.
 *
 * Ownership validation lives on PSP (the dispatch is created with
 * ``source="portal"`` and the customer_uuid resolved by vita-cff);
 * this component only enforces client-side sanity (positive qty ≤
 * on hand). PSP's validation errors surface as ``detail`` codes
 * mapped to customer-safe copy in
 * ``apps.client_portal.api.warehouse_views._DISPATCH_ERROR_COPY``.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Check, Loader2, Send, Truck } from "lucide-react";

import { apiClient } from "@/lib/api";


interface Props {
  readonly lotUuid: string;
  readonly lotCode: string;
  readonly itemName: string;
  readonly qtyOnHand: string;
  readonly unitSymbol: string;
}


export function DispatchRequestButton({
  lotUuid,
  lotCode,
  itemName,
  qtyOnHand,
  unitSymbol,
}: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 border-2 border-black bg-black px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white transition-all hover:bg-neutral-800 active:translate-y-px"
      >
        <Truck className="h-3.5 w-3.5" />
        Request dispatch
      </button>
      {open ? (
        <DispatchDialog
          lotUuid={lotUuid}
          lotCode={lotCode}
          itemName={itemName}
          qtyOnHand={qtyOnHand}
          unitSymbol={unitSymbol}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}


function DispatchDialog({
  lotUuid,
  lotCode,
  itemName,
  qtyOnHand,
  unitSymbol,
  onClose,
}: Props & { onClose: () => void }) {
  const router = useRouter();
  const [qty, setQty] = useState<string>(qtyOnHand);
  const [reference, setReference] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string>("");

  const qtyOnHandNum = Number.parseFloat(qtyOnHand || "0");
  const qtyNum = Number.parseFloat(qty || "0");
  const qtyValid =
    Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum <= qtyOnHandNum;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!qtyValid || phase === "sending") return;
    setPhase("sending");
    setErrorMessage("");
    try {
      await apiClient.post("/api/portal/warehouse/dispatch-requests/", {
        lot_uuid: lotUuid,
        qty,
        reference: reference || undefined,
        notes: notes || undefined,
      });
      setPhase("sent");
      // Give the success state a beat of visibility, then close and
      // ask the server component to re-fetch so the lot's on-hand
      // qty + summary tiles reflect the pending reservation.
      setTimeout(() => {
        onClose();
        router.refresh();
      }, 900);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { message?: string; detail?: string } } })
          ?.response?.data?.message ||
        "Couldn't queue that dispatch. Try again in a moment.";
      setErrorMessage(detail);
      setPhase("error");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => phase !== "sending" && onClose()}
    >
      <div
        className="w-full max-w-md border-2 border-black bg-white p-5 shadow-[8px_8px_0_0_black]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-2 border-black bg-orange-500">
            <Truck className="h-5 w-5 text-black" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-700">
              Request dispatch
            </p>
            <h2 className="mt-1 truncate text-lg font-black uppercase">{itemName}</h2>
            <p className="mt-0.5 font-mono text-[11px] text-neutral-500">
              {lotCode} · {qtyOnHand} {unitSymbol} on hand
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">
              Quantity to dispatch
            </label>
            <div className="mt-1.5 flex items-stretch border-2 border-black">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max={qtyOnHand}
                step="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
                disabled={phase === "sending" || phase === "sent"}
                className="min-w-0 flex-1 bg-white px-3 py-2 text-lg font-black tabular-nums outline-none"
                autoFocus
              />
              <span className="flex items-center border-l-2 border-black bg-neutral-100 px-3 text-xs font-bold uppercase tracking-widest">
                {unitSymbol}
              </span>
            </div>
            {!qtyValid && qty !== "" ? (
              <p className="mt-1 text-[11px] text-red-700">
                Must be between 1 and {qtyOnHand} {unitSymbol}.
              </p>
            ) : null}
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">
              Your reference (optional)
            </label>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={200}
              disabled={phase === "sending" || phase === "sent"}
              placeholder="e.g. PO-1234"
              className="mt-1.5 block w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none"
            />
          </div>

          <div>
            <label className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600">
              Notes for our team (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={500}
              disabled={phase === "sending" || phase === "sent"}
              placeholder="Ship to a different address, delivery window, anything else…"
              className="mt-1.5 block w-full resize-none border-2 border-black bg-white px-3 py-2 text-sm outline-none"
            />
          </div>

          {phase === "error" ? (
            <div className="flex items-start gap-2 border-2 border-red-700 bg-red-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-800" />
              <p className="text-xs text-red-900">{errorMessage}</p>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={phase === "sending"}
              className="inline-flex items-center justify-center border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black transition-colors hover:bg-neutral-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!qtyValid || phase === "sending" || phase === "sent"}
              className="inline-flex items-center justify-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
            >
              {phase === "sending" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                </>
              ) : phase === "sent" ? (
                <>
                  <Check className="h-4 w-4" /> Sent
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" /> Send request
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
