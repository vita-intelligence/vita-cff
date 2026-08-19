"use client";

/**
 * Client-side sample-selection card for the NPD portal.
 *
 * Fetches the pricing + current allocation on mount, renders a
 * quantity stepper with a live running-total using the same tiered
 * discount math the BE ``compute_sample_extras_cost`` runs, and
 * POSTs the confirm. On success calls ``router.refresh()`` so the
 * enclosing server component re-fetches ``product-detail`` and the
 * pipeline chip flips to done (this card unmounts).
 *
 * Copy + math mirror the web-site portal's ``SampleSelectionCard``
 * one-for-one so both portals convey the same offer. Rendered in
 * the NPD brutalist style (black borders, orange accents) so it
 * blends with the surrounding page chrome.
 */

import { CheckCircle2, FlaskConical, Loader2, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";


interface Tier {
  readonly quantity_threshold: number;
  readonly discount_percent: string;
}


interface Pricing {
  readonly free_samples_included: number;
  readonly price_per_extra_sample: string;
  readonly currency_code: string;
  readonly discount_tiers: readonly Tier[];
}


interface Allocation {
  readonly status: "draft" | "confirmed";
  readonly quantity_ordered: number;
}


interface Payload {
  readonly pricing: Pricing;
  readonly allocation: Allocation;
}


export function SampleSelectionCard({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [quantity, setQuantity] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await apiClient.get<Payload>(
          `/api/portal/projects/${projectId}/sample-selection/`,
        );
        if (cancelled) return;
        setPayload(data);
        const seed =
          data.allocation.quantity_ordered > 0
            ? data.allocation.quantity_ordered
            : data.pricing.free_samples_included;
        setQuantity(seed);
        setPhase("ready");
      } catch (err: unknown) {
        if (!cancelled) {
          setError(portalErrorMessage(err));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const breakdown = useMemo(() => {
    if (!payload) return null;
    const free = payload.pricing.free_samples_included;
    const unit = Number.parseFloat(payload.pricing.price_per_extra_sample) || 0;
    const extras = Math.max(0, quantity - free);
    const subtotal = extras * unit;
    const winning = payload.pricing.discount_tiers
      .map((t) => ({
        qty: t.quantity_threshold,
        pct: Number.parseFloat(t.discount_percent) || 0,
      }))
      .filter((t) => t.qty <= quantity)
      .sort((a, b) => b.qty - a.qty)[0];
    const pct = winning?.pct ?? 0;
    const total = subtotal * (1 - pct / 100);
    return { extras, subtotal, pct, total, winningTierQty: winning?.qty };
  }, [payload, quantity]);

  async function confirm() {
    if (!payload) return;
    setError(null);
    setBusy(true);
    try {
      await apiClient.post(
        `/api/portal/projects/${projectId}/sample-selection/confirm/`,
        { quantity_ordered: quantity },
      );
      // Ask the enclosing server component to re-fetch — pipeline
      // chip flips to done + this card unmounts.
      router.refresh();
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className="mt-4 border-2 border-black bg-white p-4 text-xs uppercase tracking-widest text-neutral-600">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading sample options…
        </span>
      </div>
    );
  }
  if (phase === "error" || !payload) {
    return (
      <div className="mt-4 border-2 border-black bg-white p-4 text-sm text-red-700">
        Couldn&rsquo;t load the sample options. Please refresh.
      </div>
    );
  }

  const currency = payload.pricing.currency_code || "GBP";
  const free = payload.pricing.free_samples_included;
  const canDec = quantity > free;
  const canInc = quantity < 10_000;

  return (
    <section className="mb-10 border-2 border-black bg-orange-50 p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black bg-orange-500 text-black">
          <FlaskConical className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-black">
            Choose your samples
          </p>
          <p className="mt-1 text-lg font-black uppercase leading-tight">
            How many trial samples do you want?
          </p>
          <p className="mt-1 text-sm text-neutral-800">
            {free} sample{free !== 1 ? "s" : ""} come free with your deposit.
            {payload.pricing.discount_tiers.length > 0
              ? " Extras get bulk discounts at the tiers below."
              : " Extras are priced per sample."}
          </p>
        </div>
      </div>

      {/* Stepper */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-2 border-black bg-white p-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.max(free, q - 1))}
            disabled={!canDec}
            aria-label="Fewer samples"
            className={`flex h-10 w-10 items-center justify-center border-2 border-black transition-colors ${
              canDec ? "bg-white hover:bg-black hover:text-white" : "opacity-40"
            }`}
          >
            <Minus className="h-4 w-4" />
          </button>
          <div className="flex flex-col items-center">
            <input
              type="number"
              min={free}
              max={10_000}
              value={quantity}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                if (Number.isFinite(v)) {
                  setQuantity(Math.max(free, Math.min(10_000, v)));
                }
              }}
              className="w-24 border-2 border-black bg-white px-3 py-1.5 text-center text-2xl font-black tracking-tight text-black focus:outline-none"
            />
            <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-neutral-600">
              Samples
            </span>
          </div>
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.min(10_000, q + 1))}
            disabled={!canInc}
            aria-label="More samples"
            className={`flex h-10 w-10 items-center justify-center border-2 border-black transition-colors ${
              canInc ? "bg-white hover:bg-black hover:text-white" : "opacity-40"
            }`}
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-widest text-neutral-600">
            Extras cost
          </p>
          <p className="text-2xl font-black leading-none">
            {currency} {breakdown ? breakdown.total.toFixed(2) : "0.00"}
          </p>
          {breakdown && breakdown.pct > 0 ? (
            <p className="mt-1 text-[11px] font-bold uppercase tracking-widest text-emerald-700">
              {breakdown.pct.toFixed(0)}% bulk discount
            </p>
          ) : null}
        </div>
      </div>

      {/* Tier hints */}
      {payload.pricing.discount_tiers.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {payload.pricing.discount_tiers
            .slice()
            .sort((a, b) => a.quantity_threshold - b.quantity_threshold)
            .map((t) => {
              const active = breakdown?.winningTierQty === t.quantity_threshold;
              return (
                <button
                  key={t.quantity_threshold}
                  type="button"
                  onClick={() =>
                    setQuantity(Math.max(free, t.quantity_threshold))
                  }
                  className={`border-2 border-black p-3 text-left text-xs transition-all ${
                    active
                      ? "bg-black text-white"
                      : "bg-white hover:shadow-[3px_3px_0_0_black]"
                  }`}
                >
                  <p className="text-sm font-black">{t.quantity_threshold}+</p>
                  <p className="mt-0.5 text-[11px] uppercase tracking-wide opacity-80">
                    {Number.parseFloat(t.discount_percent).toFixed(0)}% off
                  </p>
                </button>
              );
            })}
        </div>
      ) : null}

      {/* Breakdown */}
      {breakdown && breakdown.extras > 0 ? (
        <p className="mt-4 text-xs text-neutral-700">
          {free} free + {breakdown.extras} extra
          {breakdown.extras !== 1 ? "s" : ""} @ {currency}{" "}
          {Number.parseFloat(payload.pricing.price_per_extra_sample).toFixed(2)}{" "}
          = {currency} {breakdown.subtotal.toFixed(2)}
          {breakdown.pct > 0 ? (
            <>
              {" "}
              − {breakdown.pct.toFixed(0)}% ={" "}
              <span className="font-bold text-black">
                {currency} {breakdown.total.toFixed(2)}
              </span>
            </>
          ) : null}
          . Added to your deposit invoice.
        </p>
      ) : (
        <p className="mt-4 text-xs text-neutral-700">
          You&rsquo;re within the free allowance — no extra cost on top of your
          deposit.
        </p>
      )}

      {error ? (
        <p className="mt-4 border-2 border-red-700 bg-red-100 px-3 py-2 text-sm font-medium text-red-900">
          {error}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-white transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[4px_4px_0_0_black] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Confirming…
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4" /> Confirm {quantity} sample
              {quantity !== 1 ? "s" : ""}
            </>
          )}
        </button>
      </div>
    </section>
  );
}
