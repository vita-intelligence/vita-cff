"use client";

/**
 * Sample-pricing settings tab.
 *
 * Renders + edits the org's ``SamplePricingConfig`` and its ordered
 * discount tier list. Drives the customer's post-proposal sample-
 * selection stage on the portal (PR #3):
 *
 *   * ``free_samples_included`` — deposit covers this many trial
 *     samples at no extra charge.
 *   * ``price_per_extra_sample`` — per-unit price for anything above
 *     the free allowance.
 *   * ``currency_code`` — ISO-4217; falls back to the company's
 *     currency when blank.
 *   * ``discount_tiers`` — editable table of "buy N samples, get
 *     X% off". Discount applies at the end to the extras subtotal
 *     (matches the model's ``compute_sample_extras_cost`` service).
 *
 * The whole payload posts as one PUT — the BE wholesale-replaces
 * the tier list so the FE can treat the rows as a plain array
 * without tracking per-row diffs.
 *
 * Read-only when ``canEdit`` is false (viewer holds
 * ``sample_pricing.view`` but not ``.edit``). Inputs disabled +
 * Save button hidden.
 */

import { Check, CheckCircle2, Loader2, Percent, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  useSamplePricingConfig,
  useSaveSamplePricingConfig,
  type SamplePricingConfigDto,
} from "@/services/payments";


interface TierDraft {
  readonly clientKey: string;
  quantity_threshold: string;
  discount_percent: string;
}


function tiersFromDto(
  dto: SamplePricingConfigDto,
): TierDraft[] {
  return dto.discount_tiers.map((t, i) => ({
    clientKey: `tier-${i}-${t.id ?? Math.random().toString(36).slice(2)}`,
    quantity_threshold: String(t.quantity_threshold),
    discount_percent: String(t.discount_percent),
  }));
}


export function SamplePricingTab({
  orgId,
  canEdit,
}: {
  orgId: string;
  canEdit: boolean;
}) {
  const configQuery = useSamplePricingConfig(orgId);
  const saveMutation = useSaveSamplePricingConfig(orgId);

  const [freeSamples, setFreeSamples] = useState("2");
  const [pricePerExtra, setPricePerExtra] = useState("0");
  const [currency, setCurrency] = useState("");
  const [tiers, setTiers] = useState<TierDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Hydrate the form when the query resolves. Only overwrites local
  // state on the FIRST successful fetch; a manual save's returned
  // config also flows through here via ``useSamplePricingConfig``'s
  // cache update. Doesn't clobber mid-edit changes because
  // ``useQuery`` isn't re-fetching on refocus for this view.
  useEffect(() => {
    if (!configQuery.data) return;
    setFreeSamples(String(configQuery.data.free_samples_included));
    setPricePerExtra(String(configQuery.data.price_per_extra_sample));
    setCurrency(configQuery.data.currency_code);
    setTiers(tiersFromDto(configQuery.data));
  }, [configQuery.data?.id]);

  const dirty = useMemo(() => {
    const src = configQuery.data;
    if (!src) return false;
    if (String(src.free_samples_included) !== freeSamples) return true;
    if (String(src.price_per_extra_sample) !== pricePerExtra) return true;
    if (src.currency_code !== currency) return true;
    if (src.discount_tiers.length !== tiers.length) return true;
    return tiers.some((t, i) => {
      const original = src.discount_tiers[i];
      if (!original) return true;
      return (
        String(original.quantity_threshold) !== t.quantity_threshold ||
        String(original.discount_percent) !== t.discount_percent
      );
    });
  }, [configQuery.data, freeSamples, pricePerExtra, currency, tiers]);

  function addTier() {
    setTiers((prev) => [
      ...prev,
      {
        clientKey: `tier-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        quantity_threshold: "",
        discount_percent: "",
      },
    ]);
  }

  function removeTier(clientKey: string) {
    setTiers((prev) => prev.filter((t) => t.clientKey !== clientKey));
  }

  function updateTier(
    clientKey: string,
    patch: Partial<Omit<TierDraft, "clientKey">>,
  ) {
    setTiers((prev) =>
      prev.map((t) => (t.clientKey === clientKey ? { ...t, ...patch } : t)),
    );
  }

  async function save() {
    setError(null);
    // Reject blank / non-numeric / non-positive tier thresholds
    // before the round-trip. Duplicate threshold check mirrors the
    // BE serializer's ``validate_tiers``.
    const cleanTiers: {
      quantity_threshold: number;
      discount_percent: string;
    }[] = [];
    const seenThresholds = new Set<number>();
    for (const t of tiers) {
      const threshold = Number.parseInt(t.quantity_threshold, 10);
      if (!Number.isFinite(threshold) || threshold <= 0) {
        setError("Every tier needs a positive quantity threshold.");
        return;
      }
      if (seenThresholds.has(threshold)) {
        setError(
          `Duplicate quantity threshold: ${threshold}. Each tier needs a unique quantity.`,
        );
        return;
      }
      seenThresholds.add(threshold);
      const pct = Number.parseFloat(t.discount_percent || "0");
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        setError("Discount percent must be between 0 and 100.");
        return;
      }
      cleanTiers.push({
        quantity_threshold: threshold,
        discount_percent: pct.toFixed(2),
      });
    }
    const free = Number.parseInt(freeSamples, 10);
    if (!Number.isFinite(free) || free < 0) {
      setError("Free samples must be a whole number (0 or more).");
      return;
    }
    const price = Number.parseFloat(pricePerExtra);
    if (!Number.isFinite(price) || price < 0) {
      setError("Price per extra sample must be a positive number.");
      return;
    }
    try {
      await saveMutation.mutateAsync({
        free_samples_included: free,
        price_per_extra_sample: price.toFixed(2),
        currency_code: (currency || "").trim().toUpperCase().slice(0, 3),
        tiers: cleanTiers,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    }
  }

  // Auto-dismiss the success banner after a few seconds so the UI
  // cleans itself up — a persistent green banner reads as broken
  // ("did it actually update?"). 4s is long enough to notice, short
  // enough to fade before the operator's next edit.
  useEffect(() => {
    if (savedAt === null) return;
    const timer = window.setTimeout(() => setSavedAt(null), 4000);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  // Button label morphs to "Saved" for a moment after a successful
  // save even if the operator hasn't started editing again — gives
  // an unmissable click-response signal beyond the toast banner. The
  // ``savedAt`` timer above resets it back to "Save changes".
  const justSaved = savedAt !== null && !dirty;

  // Live worked example under the form so the admin can eyeball the
  // effect of their config before saving. Uses the SAME math as the
  // BE ``compute_sample_extras_cost`` so what you see is what the
  // customer will be quoted.
  const previewCases = [2, 5, 10, 25];
  const preview = useMemo(() => {
    const free = Math.max(0, Number.parseInt(freeSamples || "0", 10) || 0);
    const unit = Math.max(0, Number.parseFloat(pricePerExtra || "0") || 0);
    const parsedTiers = tiers
      .map((t) => ({
        qty: Number.parseInt(t.quantity_threshold || "0", 10) || 0,
        pct: Number.parseFloat(t.discount_percent || "0") || 0,
      }))
      .filter((t) => t.qty > 0);
    return previewCases.map((qty) => {
      const extras = Math.max(0, qty - free);
      const subtotal = extras * unit;
      const winning = parsedTiers
        .filter((t) => t.qty <= qty)
        .sort((a, b) => b.qty - a.qty)[0];
      const pct = winning?.pct ?? 0;
      const total = subtotal * (1 - pct / 100);
      return { qty, extras, subtotal, pct, total };
    });
  }, [freeSamples, pricePerExtra, tiers]);

  if (configQuery.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading pricing…
      </div>
    );
  }

  if (configQuery.isError || !configQuery.data) {
    return (
      <p className="text-sm text-red-600">
        Couldn&rsquo;t load the sample pricing config. Reload to try again.
      </p>
    );
  }

  const currencyLabel = (currency || "GBP").toUpperCase();

  return (
    <div className="flex flex-col gap-8">
      {/* Intro */}
      <section>
        <h2 className="text-lg font-semibold text-ink-1000">Sample pricing</h2>
        <p className="mt-1 text-sm text-ink-500">
          Drives the customer&rsquo;s post-proposal sample-selection step. Every deal includes the
          free allowance below at no extra charge; anything above that is priced per extra sample
          with an optional bulk-discount tier. Numbers here take effect immediately on the next
          customer who reaches that stage.
        </p>
      </section>

      {/* Config card */}
      <section className="rounded-2xl border border-ink-200 bg-white p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              Free samples included
            </span>
            <input
              type="number"
              min={0}
              step={1}
              value={freeSamples}
              disabled={!canEdit}
              onChange={(e) => setFreeSamples(e.target.value)}
              className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
            />
            <span className="text-[11px] text-ink-500">
              Covered by the deposit. Vita default is 2.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              Price per extra sample
            </span>
            <div className="relative">
              <input
                type="number"
                min={0}
                step="0.01"
                value={pricePerExtra}
                disabled={!canEdit}
                onChange={(e) => setPricePerExtra(e.target.value)}
                className="w-full rounded-lg bg-ink-0 px-3 py-2 pr-16 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-500">
                {currencyLabel}
              </span>
            </div>
            <span className="text-[11px] text-ink-500">
              Per unit. Before any discount tier below.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              Currency (ISO 4217)
            </span>
            <input
              type="text"
              value={currency}
              disabled={!canEdit}
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
              placeholder="GBP"
              className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
              maxLength={3}
            />
            <span className="text-[11px] text-ink-500">
              Blank = use company default.
            </span>
          </label>
        </div>
      </section>

      {/* Tier table */}
      <section className="rounded-2xl border border-ink-200 bg-white p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-ink-1000">
              Bulk discount tiers
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              Highest quantity threshold that&rsquo;s ≤ the customer&rsquo;s order wins. Discount
              applies to the extras subtotal (not to the deposit portion).
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              onClick={addTier}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-2 text-xs font-semibold text-white hover:bg-ink-800"
            >
              <Plus className="h-3.5 w-3.5" /> Add tier
            </button>
          ) : null}
        </div>

        {tiers.length === 0 ? (
          <p className="rounded-lg bg-ink-50 px-4 py-6 text-center text-xs text-ink-500">
            No discount tiers yet. Every extra sample costs the flat rate above.
            {canEdit ? " Add a tier to reward larger orders." : ""}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs font-medium text-ink-500">
                  <th className="pb-2 pr-4">Quantity ≥</th>
                  <th className="pb-2 pr-4">Discount %</th>
                  {canEdit ? <th className="pb-2 w-10" aria-hidden /> : null}
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.clientKey} className="border-b border-ink-100 last:border-0">
                    <td className="py-2 pr-4">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={t.quantity_threshold}
                        disabled={!canEdit}
                        onChange={(e) =>
                          updateTier(t.clientKey, {
                            quantity_threshold: e.target.value,
                          })
                        }
                        className="w-24 rounded-lg bg-ink-0 px-2 py-1.5 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <div className="relative w-28">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={t.discount_percent}
                          disabled={!canEdit}
                          onChange={(e) =>
                            updateTier(t.clientKey, {
                              discount_percent: e.target.value,
                            })
                          }
                          className="w-full rounded-lg bg-ink-0 px-2 py-1.5 pr-7 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
                        />
                        <Percent className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
                      </div>
                    </td>
                    {canEdit ? (
                      <td className="py-2">
                        <button
                          type="button"
                          onClick={() => removeTier(t.clientKey)}
                          aria-label="Remove tier"
                          className="rounded-lg p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Live preview */}
      <section className="rounded-2xl border border-orange-200 bg-orange-50/60 p-6">
        <h3 className="text-sm font-semibold text-ink-1000">
          What the customer will see
        </h3>
        <p className="mt-1 text-xs text-ink-600">
          Live worked example — same math the portal picker + finance invoice will use.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-orange-200 text-left text-xs font-medium text-ink-700">
                <th className="pb-2 pr-4">Samples</th>
                <th className="pb-2 pr-4">Extras</th>
                <th className="pb-2 pr-4">Subtotal</th>
                <th className="pb-2 pr-4">Discount</th>
                <th className="pb-2 pr-4">Customer pays</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.qty} className="border-b border-orange-100 last:border-0">
                  <td className="py-2 pr-4 font-mono text-ink-1000">{row.qty}</td>
                  <td className="py-2 pr-4 font-mono text-ink-700">{row.extras}</td>
                  <td className="py-2 pr-4 font-mono text-ink-700">
                    {currencyLabel} {row.subtotal.toFixed(2)}
                  </td>
                  <td className="py-2 pr-4 font-mono text-ink-700">
                    {row.pct.toFixed(2)}%
                  </td>
                  <td className="py-2 pr-4 font-mono font-semibold text-ink-1000">
                    {currencyLabel} {row.total.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Save */}
      {canEdit ? (
        <>
          {/* Success banner — shows for 4s after a successful save.
              Sits above the button row so the operator's eyes land
              on it whether they were looking at the button or the
              live-preview table when they clicked. Auto-dismisses
              (see the timer in ``useEffect`` above) — a persistent
              banner reads as broken. */}
          {justSaved ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <div className="min-w-0">
                <p className="font-semibold">Sample pricing updated.</p>
                <p className="mt-0.5 text-xs text-emerald-800">
                  New numbers take effect on the next customer who reaches
                  the sample-selection stage.
                </p>
              </div>
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
            >
              <span className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full bg-red-500" />
              <p>{error}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={save}
              disabled={
                (!dirty && !justSaved) || saveMutation.isPending
              }
              className={
                justSaved
                  ? "inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed"
                  : "inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              }
              aria-busy={saveMutation.isPending || undefined}
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Saving…
                </>
              ) : justSaved ? (
                <>
                  <Check className="h-4 w-4" /> Saved
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" /> Save changes
                </>
              )}
            </button>
          </div>
        </>
      ) : (
        <p className="text-xs text-ink-500">
          You have view-only access to this module. Ask an admin for
          <span className="mx-1 rounded bg-ink-100 px-1.5 py-0.5 font-mono">sample_pricing.edit</span>
          to make changes.
        </p>
      )}
    </div>
  );
}
