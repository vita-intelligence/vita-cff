"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  TrendingDown,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import {
  usePatchProposalLine,
  useProposalSavingsAtScale,
} from "@/services/proposals";
import type {
  ProposalLineDto,
  ProposalSavingsAtScaleRowDto,
  ProposalSavingsIngredientRowDto,
  ProposalSavingsLabourRowDto,
} from "@/services/proposals";
import { useSpecification } from "@/services/specifications";

const FALLBACK_MARGIN_PERCENT = 30;
const MARGIN_PERSIST_DEBOUNCE_MS = 600;

/** Compute the proposal line's current gross margin % from its
 *  cost/price pair. Returns `null` when either number is missing
 *  or invalid, so the panel falls back to a sane default. */
function marginFromLine(line: ProposalLineDto): number | null {
  const cost = Number.parseFloat(line.unit_cost ?? "");
  const price = Number.parseFloat(line.unit_price ?? "");
  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  return ((price - cost) / price) * 100;
}


/** Preferred seed for the panel's default margin. Priority:
 *   1. The line's persisted ``tier_margin_overrides["1"]`` — the
 *      operator's exact typed value, byte-equal to what the portal
 *      reads.
 *   2. The director's approved margin on the linked spec sheet.
 *   3. The line's own derived margin (lossy, back-calculated from
 *      rounded unit_cost + unit_price).
 */
function marginFromSpecOrLine(
  specMarginPct: number | null,
  line: ProposalLineDto,
): number | null {
  const persisted = defaultMarginFromTierOverrides(line.tier_margin_overrides);
  if (persisted !== null) return persisted;
  if (specMarginPct !== null && Number.isFinite(specMarginPct)) {
    return specMarginPct;
  }
  return marginFromLine(line);
}


/** Parse the server-side ``tier_margin_overrides`` dict (keys are
 *  multiplier strings, values are decimal strings) into the local
 *  per-row override shape. The ``"1"`` entry stores the typed
 *  default margin for roundtrip-safe persistence — we EXCLUDE it
 *  from this map so the base tier doesn't render with the
 *  "overridden" badge + reset affordance. The default-margin
 *  seed effect reads it separately. */
function parseTierOverrides(
  raw: Readonly<Record<string, string>> | null | undefined,
): Record<number, number> {
  if (!raw) return {};
  const out: Record<number, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const mult = Number.parseInt(key, 10);
    const margin = Number(value);
    if (
      Number.isFinite(mult) &&
      mult > 1 &&
      Number.isFinite(margin) &&
      margin >= 0 &&
      margin < 100
    ) {
      out[mult] = margin;
    }
  }
  return out;
}


/** Pick the typed default margin out of ``tier_margin_overrides``
 *  (the ``"1"`` entry). Returns null when absent / malformed so
 *  the caller can fall back to the line-derived margin. */
function defaultMarginFromTierOverrides(
  raw: Readonly<Record<string, string>> | null | undefined,
): number | null {
  if (!raw) return null;
  const base = raw["1"];
  if (base === undefined || base === null) return null;
  const n = Number(base);
  if (!Number.isFinite(n) || n < 0 || n >= 100) return null;
  return n;
}


/** Serialise the local shape back for a server PATCH. Keys as
 *  multiplier strings, values rounded to 4 decimals as strings. */
function serialiseTierOverrides(
  map: Record<number, number>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [mult, margin] of Object.entries(map)) {
    if (!Number.isFinite(margin)) continue;
    out[String(mult)] = margin.toFixed(4);
  }
  return out;
}

function formatMoneyLocal(
  value: number | null | undefined,
  currency: string,
  maxFractionDigits = 2,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const threshold = Math.pow(10, -maxFractionDigits) / 2;
  if (value > 0 && value < threshold) {
    // Positive but rounds to zero at this precision — mark it as
    // "below the display granularity" so a 6 mg × £1/kg ingredient
    // doesn't read as "no price data".
    try {
      const tiny = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: currency || "GBP",
        maximumFractionDigits: maxFractionDigits,
        minimumFractionDigits: maxFractionDigits,
      }).format(threshold * 2);
      return `<${tiny}`;
    } catch {
      return `<${(threshold * 2).toFixed(maxFractionDigits)} ${currency || ""}`.trim();
    }
  }
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      maximumFractionDigits: maxFractionDigits,
      minimumFractionDigits: Math.min(2, maxFractionDigits),
    }).format(value);
  } catch {
    return `${value.toFixed(maxFractionDigits)} ${currency || ""}`.trim();
  }
}

function parseDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Volume progression card. Three vertical zones:
 *
 *   1. Table — one row per quantity breakpoint (quoted × 1 / 2 / 5
 *      / 10 / 25 / 50) with cost per unit split into ingredients +
 *      labour, plus a per-row **margin override** and derived
 *      customer-facing unit price + total price.
 *   2. Breakdown — click a row to expand its ingredient + labour
 *      sources; "based on what data" transparency the sales team
 *      can share with the client.
 */
export function ProposalSavingsAtScalePanel({
  orgId,
  proposalId,
  currencyCode,
  line,
  canEdit,
}: {
  readonly orgId: string;
  readonly proposalId: string;
  readonly currencyCode: string;
  /** First (and currently only) line on the proposal. Its margin
   *  seeds the panel's default; editing the default writes a
   *  patched `unit_price` back to this line so the proposal's own
   *  numbers stay in sync. */
  readonly line: ProposalLineDto;
  /** Whether the signed-in user can patch the proposal. Terminal
   *  proposals disable the margin input. */
  readonly canEdit: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const format = useFormatter();

  const query = useProposalSavingsAtScale(orgId, proposalId);
  const data = query.data;
  const currency = data?.currency_code || currencyCode || "GBP";

  // Pull the attached spec sheet when the line has one so the
  // panel's default margin reflects what the DIRECTOR approved,
  // not whatever the proposal line was created with. The query
  // auto-invalidates when the spec sheet is edited, so a director
  // changing their approved margin elsewhere flows into this
  // panel on next refetch.
  const specSheetId = line.specification_sheet_id ?? null;
  const specQuery = useSpecification(orgId, specSheetId ?? "", {
    initialData: undefined,
  });
  const specMargin: number | null = (() => {
    if (!specSheetId) return null;
    const raw = specQuery.data?.margin_percent;
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  })();

  const seededMargin =
    marginFromSpecOrLine(specMargin, line) ?? FALLBACK_MARGIN_PERCENT;
  const [defaultMargin, setDefaultMargin] = useState(seededMargin);

  // Re-sync local state when the server-side source (spec margin
  // or line) changes. Compare against a ref so we don't fight an
  // in-flight local edit — only sync when the server moved to a
  // value WE don't already represent.
  const lastServerMarginRef = useRef(seededMargin);
  useEffect(() => {
    const serverMargin = marginFromSpecOrLine(specMargin, line);
    if (serverMargin === null) return;
    if (Math.abs(serverMargin - lastServerMarginRef.current) < 0.01) return;
    lastServerMarginRef.current = serverMargin;
    setDefaultMargin(serverMargin);
  }, [line, specMargin]);

  /** multiplier → override margin. Missing key means "use default".
   *  Seeded from the proposal line's persisted ``tier_margin_overrides``
   *  (synced across all operators + consumed by the portal payload). */
  const [marginByMult, setMarginByMult] = useState<Record<number, number>>(
    () => parseTierOverrides(line.tier_margin_overrides),
  );
  const [expandedMult, setExpandedMult] = useState<number | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // Re-sync tier overrides when the server-side line changes (edit
  // from another operator, revert, etc.). Compare serialised shape
  // so we don't fight an in-flight local edit.
  const lastTierOverrideRef = useRef<string>(
    JSON.stringify(line.tier_margin_overrides ?? {}),
  );
  useEffect(() => {
    const serverStr = JSON.stringify(line.tier_margin_overrides ?? {});
    if (serverStr === lastTierOverrideRef.current) return;
    lastTierOverrideRef.current = serverStr;
    setMarginByMult(parseTierOverrides(line.tier_margin_overrides));
  }, [line.tier_margin_overrides]);

  const resolveMargin = (mult: number): number =>
    marginByMult[mult] ?? defaultMargin;

  // Base tier (×1) is the quoted qty — its total_per_unit is the
  // authoritative projected cost for the line. We sync that cost
  // into the proposal line's `unit_cost`, and derive `unit_price`
  // from (cost, margin). Debounced so a flurry of state changes
  // only produces one PATCH; cost + margin edits land in a single
  // mutation (line.unit_cost + line.unit_price together).
  const patchLine = usePatchProposalLine(orgId, proposalId);
  const debouncedWriteRef = useRef<number | null>(null);

  // Debounced write-back for per-tier margin overrides. Called from
  // onMarginChange/onMarginReset so the portal (and anyone else
  // reading the proposal) sees the sales team's actual tier
  // margins, not just the default. Fires via the same
  // patchProposalLine mutation as the default-margin flow.
  const tierDebounceRef = useRef<number | null>(null);
  const persistTierOverrides = useCallback(
    (next: Record<number, number>) => {
      if (!canEdit) return;
      if (tierDebounceRef.current) {
        window.clearTimeout(tierDebounceRef.current);
      }
      tierDebounceRef.current = window.setTimeout(() => {
        const payload = serialiseTierOverrides(next);
        lastTierOverrideRef.current = JSON.stringify(payload);
        patchLine.mutate(
          {
            lineId: line.id,
            payload: { tier_margin_overrides: payload },
          },
          {
            onError: (err) => {
              setWriteError(
                err instanceof Error
                  ? err.message
                  : "Couldn't save tier margin.",
              );
            },
            onSuccess: () => setWriteError(null),
          },
        );
      }, MARGIN_PERSIST_DEBOUNCE_MS);
    },
    [canEdit, line.id, patchLine],
  );
  useEffect(
    () => () => {
      if (tierDebounceRef.current) {
        window.clearTimeout(tierDebounceRef.current);
      }
    },
    [],
  );

  const baseRow = data?.rows.find((r) => r.multiplier === 1) ?? null;
  const baseCostRaw = baseRow?.total_per_unit ?? null;
  const baseCost = baseCostRaw !== null ? Number(baseCostRaw) : null;

  useEffect(() => {
    if (!canEdit) return;
    if (defaultMargin < 0 || defaultMargin >= 100) return;
    // Need a positive cost to project a price from. Prefer the
    // panel's computed base cost (reality from PSP + routing);
    // fall back to the line's existing unit_cost so a formulation
    // without PSP data still gets its margin write-back.
    const cost =
      baseCost !== null && baseCost > 0
        ? baseCost
        : Number.parseFloat(line.unit_cost ?? "");
    if (!Number.isFinite(cost) || cost <= 0) return;

    const serverCost = Number.parseFloat(line.unit_cost ?? "");
    const serverMargin = marginFromLine(line);
    const costInSync =
      Number.isFinite(serverCost) && Math.abs(serverCost - cost) < 0.0005;
    const marginInSync =
      serverMargin !== null &&
      Math.abs(serverMargin - defaultMargin) < 0.01;
    if (costInSync && marginInSync) return;

    if (debouncedWriteRef.current) {
      window.clearTimeout(debouncedWriteRef.current);
    }
    debouncedWriteRef.current = window.setTimeout(() => {
      const nextPrice = cost / (1 - defaultMargin / 100);
      const roundedCost = Number(cost.toFixed(4));
      const roundedPrice = Number(nextPrice.toFixed(4));
      // Also persist the margin verbatim as the base-tier override
      // so the portal uses the operator's typed value directly
      // instead of back-deriving it from the rounded cost/price
      // pair (which drifts 33% → 32.9965% once stored). The
      // existing per-tier overrides ride alongside — this just
      // adds / updates the "1" key.
      const nextTierOverrides = serialiseTierOverrides({
        ...marginByMult,
        1: defaultMargin,
      });
      lastServerMarginRef.current = defaultMargin;
      lastTierOverrideRef.current = JSON.stringify(nextTierOverrides);
      patchLine.mutate(
        {
          lineId: line.id,
          payload: {
            unit_cost: roundedCost.toFixed(4),
            unit_price: roundedPrice.toFixed(4),
            tier_margin_overrides: nextTierOverrides,
          },
        },
        {
          onError: (err) => {
            setWriteError(
              err instanceof Error
                ? err.message
                : "Couldn't update proposal cost / margin.",
            );
          },
          onSuccess: () => setWriteError(null),
        },
      );
    }, MARGIN_PERSIST_DEBOUNCE_MS);

    return () => {
      if (debouncedWriteRef.current) {
        window.clearTimeout(debouncedWriteRef.current);
        debouncedWriteRef.current = null;
      }
    };
  }, [defaultMargin, canEdit, line, patchLine, baseCost]);

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div className="flex items-start gap-3">
          <TrendingDown className="mt-0.5 size-5 text-emerald-600" />
          <div>
            <h2 className="text-base font-semibold text-ink-1000">
              {tProposals("savings_at_scale.title")}
            </h2>
            <p className="mt-0.5 max-w-2xl text-sm text-ink-500">
              {tProposals("savings_at_scale.subtitle")}
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-600">
          <span className="font-medium">
            {canEdit ? "Default margin" : "Margin (locked)"}
          </span>
          <div className="flex items-center">
            <input
              type="number"
              min={0}
              max={99}
              step="0.5"
              value={Number.isFinite(defaultMargin)
                ? Number(defaultMargin.toFixed(2))
                : 0}
              disabled={!canEdit || patchLine.isPending}
              onChange={(e) =>
                setDefaultMargin(Math.min(99, Math.max(0, Number(e.target.value) || 0)))
              }
              className="h-8 w-16 rounded-md border border-ink-200 bg-ink-0 px-2 text-right font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
            <span className="ml-1 text-ink-500">%</span>
            {patchLine.isPending ? (
              <Loader2 className="ml-1 size-3 animate-spin text-ink-400" />
            ) : null}
          </div>
        </label>
      </header>

      {writeError ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="size-3.5" />
          <span>{writeError}</span>
        </div>
      ) : null}

      {query.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-500">
          <Loader2 className="size-4 animate-spin" />
          Computing the progression…
        </div>
      ) : query.isError ? (
        <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4" />
          <div>
            <p className="font-medium">Couldn&apos;t load the progression.</p>
            <p className="text-xs">
              {query.error instanceof Error
                ? query.error.message
                : "Unknown error."}
            </p>
          </div>
        </div>
      ) : !data || data.rows.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-ink-200 px-3 py-6 text-center text-xs text-ink-500">
          Add a product with a formulation first — the progression
          needs stage + BOM data to compute scale savings.
        </p>
      ) : !data.psp_configured ? (
        <p className="mt-4 rounded-md border border-dashed border-ink-200 px-3 py-6 text-center text-xs text-ink-500">
          PSP isn&apos;t configured for this workspace yet — scale
          costs rely on live vendor + workstation data.
        </p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-ink-50 text-[11px] uppercase tracking-wider text-ink-500">
                <tr>
                  <th className="w-6 px-2 py-2" />
                  <th className="px-2 py-2 text-left font-medium">Qty</th>
                  <th className="hidden px-2 py-2 text-right font-medium md:table-cell">
                    Ingr. / unit
                  </th>
                  <th className="hidden px-2 py-2 text-right font-medium md:table-cell">
                    Labour / unit
                  </th>
                  <th className="px-2 py-2 text-right font-medium">Cost / unit</th>
                  <th className="px-2 py-2 text-right font-medium">
                    <span className="hidden sm:inline">Margin %</span>
                    <span className="sm:hidden">%</span>
                  </th>
                  <th className="px-2 py-2 text-right font-medium">
                    Price / unit
                  </th>
                  <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">
                    Order cost
                  </th>
                  <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">
                    Order price
                  </th>
                  <th className="hidden px-2 py-2 text-right font-medium lg:table-cell">
                    Savings / unit
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {(() => {
                  // Compute the base row's live price from the base
                  // cost + the base-tier margin — this is the anchor
                  // every tier's "savings vs base" row compares to.
                  // Reading ``row.savings_per_unit_vs_base`` would
                  // use the server's cost-only savings, which doesn't
                  // move when the operator drops the per-tier margin;
                  // deriving locally keeps the savings column honest
                  // with whatever margins are currently typed.
                  const baseRowLive = data.rows.find(
                    (r) => r.multiplier === 1,
                  );
                  const baseCostNum =
                    baseRowLive && baseRowLive.total_per_unit !== null
                      ? Number(baseRowLive.total_per_unit)
                      : null;
                  const baseMargin = resolveMargin(1);
                  const basePricePerUnit =
                    baseCostNum !== null &&
                    Number.isFinite(baseCostNum) &&
                    baseCostNum > 0 &&
                    baseMargin >= 0 &&
                    baseMargin < 100
                      ? baseCostNum / (1 - baseMargin / 100)
                      : null;
                  return data.rows.map((row) => {
                  const expanded = expandedMult === row.multiplier;
                  const marginPercent = resolveMargin(row.multiplier);
                  return (
                    <RowGroup
                      key={row.multiplier}
                      row={row}
                      currency={currency}
                      format={format}
                      isBase={row.multiplier === 1}
                      basePricePerUnit={basePricePerUnit}
                      expanded={expanded}
                      canEdit={canEdit}
                      onToggle={() =>
                        setExpandedMult((prev) =>
                          prev === row.multiplier ? null : row.multiplier,
                        )
                      }
                      marginPercent={marginPercent}
                      marginOverridden={row.multiplier in marginByMult}
                      onMarginChange={(next) => {
                        setMarginByMult((prev) => {
                          const updated = { ...prev, [row.multiplier]: next };
                          persistTierOverrides(updated);
                          return updated;
                        });
                      }}
                      onMarginReset={() => {
                        setMarginByMult((prev) => {
                          const { [row.multiplier]: _, ...rest } = prev;
                          persistTierOverrides(rest);
                          return rest;
                        });
                      }}
                    />
                  );
                  });
                })()}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-[11px] text-ink-500">
            Click any row to expand the data behind the number —
            which vendor + tier priced each ingredient, and whether
            labour used the routing&apos;s fixed cost or the
            workstation&apos;s hourly rate.
          </p>
        </>
      )}
    </section>
  );
}


function RowGroup({
  row,
  currency,
  format,
  isBase,
  basePricePerUnit,
  expanded,
  canEdit,
  onToggle,
  marginPercent,
  marginOverridden,
  onMarginChange,
  onMarginReset,
}: {
  readonly row: ProposalSavingsAtScaleRowDto;
  readonly currency: string;
  readonly format: ReturnType<typeof useFormatter>;
  readonly isBase: boolean;
  //: Price per unit of the base (×1) row, computed from the base
  //: cost + the base-tier margin currently typed in the UI. Each
  //: row's "savings vs quoted" column is ``base − tier`` using
  //: both live prices, so dropping the margin on a non-base tier
  //: immediately widens the savings number (which is what the
  //: customer-facing portal computes too).
  readonly basePricePerUnit: number | null;
  readonly expanded: boolean;
  //: Mirrors the panel-level ``canEdit`` gate — ``false`` locks
  //: the per-tier margin input + hides the reset affordance so the
  //: visual state matches the "no writes will be persisted" rule
  //: at the parent level. Without this, inputs looked editable
  //: during review and silently dropped keystrokes.
  readonly canEdit: boolean;
  readonly onToggle: () => void;
  readonly marginPercent: number;
  readonly marginOverridden: boolean;
  readonly onMarginChange: (next: number) => void;
  readonly onMarginReset: () => void;
}) {
  const costPerUnit = parseDecimal(row.total_per_unit);
  const orderTotalCost = parseDecimal(row.total_cost);

  const pricePerUnit = useMemo(() => {
    if (costPerUnit === null) return null;
    if (marginPercent < 0 || marginPercent >= 100) return null;
    return costPerUnit / (1 - marginPercent / 100);
  }, [costPerUnit, marginPercent]);

  const orderTotalPrice =
    pricePerUnit !== null ? pricePerUnit * row.quantity : null;

  // Live price-based savings so the column tracks margin edits.
  // The server's ``savings_per_unit_vs_base`` on the row DTO is a
  // cost-only diff — fine as a system-of-record baseline, wrong as
  // a scoreboard once the operator starts dropping tier margins.
  const savingsPerUnit = useMemo(() => {
    if (isBase) return null;
    if (basePricePerUnit === null || pricePerUnit === null) return null;
    const diff = basePricePerUnit - pricePerUnit;
    return diff > 0 ? diff : 0;
  }, [isBase, basePricePerUnit, pricePerUnit]);

  const savingsTotal =
    savingsPerUnit !== null ? savingsPerUnit * row.quantity : null;

  const showSavings = !isBase && savingsPerUnit !== null && savingsPerUnit > 0;

  return (
    <>
      <tr
        className={`cursor-pointer ${isBase ? "bg-emerald-50/40 hover:bg-emerald-50/70" : "hover:bg-ink-50"}`}
        onClick={onToggle}
      >
        <td className="px-2 py-2 text-center text-ink-500">
          {expanded ? (
            <ChevronDown className="inline size-3.5" />
          ) : (
            <ChevronRight className="inline size-3.5" />
          )}
        </td>
        <td className="whitespace-nowrap px-2 py-2">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-900">
              {format.number(row.quantity)}
            </span>
            {isBase ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
                Quoted
              </span>
            ) : (
              <span className="text-[11px] text-ink-500">×{row.multiplier}</span>
            )}
          </div>
        </td>
        <Money
          value={row.ingredients_per_unit}
          currency={currency}
          className="hidden md:table-cell"
        />
        <Money
          value={row.labour_per_unit}
          currency={currency}
          className="hidden md:table-cell"
        />
        <Money value={row.total_per_unit} currency={currency} bold />
        <td
          className="whitespace-nowrap px-2 py-2 text-right"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="inline-flex flex-col items-end gap-0.5">
            <input
              type="number"
              min={0}
              max={99}
              step="0.5"
              value={
                Number.isFinite(marginPercent)
                  ? Number(marginPercent.toFixed(2))
                  : 0
              }
              disabled={!canEdit}
              onChange={(e) =>
                onMarginChange(
                  Math.min(99, Math.max(0, Number(e.target.value) || 0)),
                )
              }
              className="h-7 w-14 rounded-md border border-ink-200 bg-ink-0 px-1.5 text-right font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-500"
            />
            {canEdit && marginOverridden ? (
              <button
                type="button"
                onClick={onMarginReset}
                className="text-[10px] text-ink-500 underline"
                title="Reset to the default margin"
              >
                reset
              </button>
            ) : null}
          </div>
        </td>
        <MoneyNum value={pricePerUnit} currency={currency} bold />
        <Money
          value={row.total_cost}
          currency={currency}
          bold
          className="hidden lg:table-cell"
        />
        <MoneyNum
          value={orderTotalPrice}
          currency={currency}
          bold
          className="hidden lg:table-cell"
        />
        <MoneyNum
          value={showSavings ? savingsPerUnit : null}
          currency={currency}
          positive
          className="hidden lg:table-cell"
        />
      </tr>
      {expanded ? (
        <tr>
          <td
            colSpan={10}
            className="bg-ink-50/60 px-3 py-4 sm:px-6"
          >
            <BreakdownBlock row={row} currency={currency} format={format} />
          </td>
        </tr>
      ) : null}
    </>
  );
}


function BreakdownBlock({
  row,
  currency,
  format,
}: {
  readonly row: ProposalSavingsAtScaleRowDto;
  readonly currency: string;
  readonly format: ReturnType<typeof useFormatter>;
}) {
  // Stacked vertically — ingredients on top, labour below. The two
  // tables are information-dense enough that side-by-side columns
  // only read cleanly on wide desktops, and the row-wise order
  // (ingredients → labour → total) matches how the quote is built.
  return (
    <div className="flex flex-col gap-4">
      <IngredientBreakdown
        ingredientRows={row.ingredient_rows}
        currency={currency}
      />
      <LabourBreakdown
        labourRows={row.labour_rows}
        currency={currency}
        orderQty={row.quantity}
        format={format}
      />
    </div>
  );
}


function IngredientBreakdown({
  ingredientRows,
  currency,
}: {
  readonly ingredientRows: readonly ProposalSavingsIngredientRowDto[];
  readonly currency: string;
}) {
  if (ingredientRows.length === 0) {
    return (
      <div className="rounded-md border border-ink-200 bg-ink-0 p-3 text-xs text-ink-500">
        No ingredient lines on this formulation.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-ink-200 bg-ink-0 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-700">
        Ingredients
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-500">
            <th className="pb-1 pr-2">Item</th>
            <th className="pb-1 pr-2 text-right">Kg needed</th>
            <th className="pb-1 pr-2 text-right">Unit cost</th>
            <th className="pb-1 pr-2">Source</th>
            <th className="pb-1 text-right">Line / pack</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {ingredientRows.map((row, i) => (
            <tr key={`${row.item_name}-${i}`}>
              <td className="py-1.5 pr-2">
                <p className="truncate font-medium text-ink-800">
                  {row.item_name}
                </p>
                {row.item_code ? (
                  <p className="font-mono text-[10px] text-ink-500">
                    {row.item_code}
                  </p>
                ) : null}
              </td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
                {row.kg_needed ? `${Number(row.kg_needed).toFixed(2)} kg` : "—"}
              </td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
                {row.unit_cost
                  ? `${formatMoneyLocal(Number(row.unit_cost), row.currency_code || currency, 4)}/${row.uom_symbol || "kg"}`
                  : "—"}
              </td>
              <td className="py-1.5 pr-2">
                <SourceBadge source={row.source} vendor={row.vendor_name} />
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums text-ink-900">
                {formatMoneyLocal(
                  row.line_cost_per_unit ? Number(row.line_cost_per_unit) : null,
                  row.currency_code || currency,
                  4,
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function LabourBreakdown({
  labourRows,
  currency,
  orderQty,
  format,
}: {
  readonly labourRows: readonly ProposalSavingsLabourRowDto[];
  readonly currency: string;
  readonly orderQty: number;
  readonly format: ReturnType<typeof useFormatter>;
}) {
  if (labourRows.length === 0) {
    return (
      <div className="rounded-md border border-ink-200 bg-ink-0 p-3 text-xs text-ink-500">
        No routing stages on this formulation.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-ink-200 bg-ink-0 p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-700">
        Labour / overhead
      </h3>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-ink-500">
            <th className="pb-1 pr-2">Stage</th>
            <th className="pb-1 pr-2">Basis</th>
            <th className="pb-1 pr-2 text-right">Time</th>
            <th className="pb-1 pr-2 text-right">Stage total</th>
            <th className="pb-1 text-right">Per unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {labourRows.map((row, i) => (
            <tr key={`${row.stage_name}-${i}`}>
              <td className="py-1.5 pr-2">
                <p className="truncate font-medium text-ink-800">
                  {row.stage_name}
                </p>
                <p className="truncate text-[10px] text-ink-500">
                  {row.workstation_group_name}
                </p>
              </td>
              <td className="py-1.5 pr-2">
                <BasisChip row={row} currency={currency} />
              </td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
                {formatHours(row.labour_hours_total)}
              </td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
                {formatMoneyLocal(
                  row.stage_cost_total ? Number(row.stage_cost_total) : null,
                  currency,
                  2,
                )}
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums text-ink-900">
                {formatMoneyLocal(
                  row.cost_per_unit ? Number(row.cost_per_unit) : null,
                  currency,
                  4,
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-[10px] text-ink-500">
            <td colSpan={5} className="pt-2 italic">
              Projected across {format.number(orderQty)}{" "}
              {orderQty === 1 ? "pack" : "packs"}.
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}


function BasisChip({
  row,
  currency,
}: {
  readonly row: ProposalSavingsLabourRowDto;
  readonly currency: string;
}) {
  const wagePart = row.labour_hourly_rate ? (
    <p className="text-[10px] text-ink-500">
      <span className="font-medium text-ink-700">
        + {formatMoneyLocal(Number(row.labour_hourly_rate), currency)}/hr
      </span>{" "}
      {row.labour_source === "session"
        ? "wage (HR session)"
        : "wage (fallback)"}
    </p>
  ) : null;

  if (row.basis === "routing_fixed") {
    const parts: string[] = [];
    if (row.fixed_cost) {
      parts.push(
        `${formatMoneyLocal(Number(row.fixed_cost), currency)} / batch`,
      );
    }
    if (row.variable_cost) {
      parts.push(
        `${formatMoneyLocal(Number(row.variable_cost), currency)} / unit`,
      );
    }
    return (
      <div className="space-y-0.5">
        <span
          className="inline-block rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-800"
          title="Routing step's own numbers (setup overhead + per-unit cost)."
        >
          Routing
        </span>
        <p className="text-[10px] text-ink-500">{parts.join(" + ") || "—"}</p>
        {wagePart}
      </div>
    );
  }
  if (row.basis === "machine_rate") {
    return (
      <div className="space-y-0.5">
        <span className="inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
          Machine rate
        </span>
        <p className="text-[10px] text-ink-500">
          {row.hourly_rate
            ? `${formatMoneyLocal(Number(row.hourly_rate), currency)}/hr`
            : "—"}
        </p>
        {wagePart}
      </div>
    );
  }
  if (row.basis === "labour_only") {
    return (
      <div className="space-y-0.5">
        <span
          className="inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800"
          title="Only labour wages contribute to this stage's cost."
        >
          Labour only
        </span>
        {wagePart}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <span className="inline-block rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600">
        No signal
      </span>
      <p className="text-[10px] text-ink-500">Not costed</p>
    </div>
  );
}


function SourceBadge({
  source,
  vendor,
}: {
  readonly source: string;
  readonly vendor: string | null;
}) {
  if (source === "po_history") {
    return (
      <div className="space-y-0.5">
        <span className="inline-block rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800">
          PO history
        </span>
        {vendor ? (
          <p className="truncate text-[10px] text-ink-500">{vendor}</p>
        ) : null}
      </div>
    );
  }
  if (source === "purchase_term") {
    return (
      <div className="space-y-0.5">
        <span className="inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800">
          Vendor term
        </span>
        {vendor ? (
          <p className="truncate text-[10px] text-ink-500">{vendor}</p>
        ) : null}
      </div>
    );
  }
  if (source === "bom_rollup" || source === "bom_rollup_partial") {
    const partial = source === "bom_rollup_partial";
    return (
      <span
        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
          partial
            ? "bg-amber-100 text-amber-800"
            : "bg-slate-100 text-slate-700"
        }`}
      >
        {partial ? "BOM rollup (partial)" : "BOM rollup"}
      </span>
    );
  }
  return (
    <span className="inline-block rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600">
      No price data
    </span>
  );
}


function formatHours(hoursStr: string | null): string {
  const n = parseDecimal(hoursStr);
  if (n === null || n <= 0) return "—";
  if (n >= 1) return `${n.toFixed(1)} h`;
  return `${Math.round(n * 60)} min`;
}


function Money({
  value,
  currency,
  bold,
  positive,
  className,
}: {
  readonly value: string | null;
  readonly currency: string;
  readonly bold?: boolean;
  readonly positive?: boolean;
  readonly className?: string;
}) {
  return (
    <td
      className={[
        "whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums",
        bold ? "font-semibold" : "",
        positive ? "text-emerald-700" : "text-ink-800",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {value === null || value === undefined ? (
        <span className="text-ink-400">—</span>
      ) : (
        formatMoneyLocal(Number(value), currency, 4)
      )}
    </td>
  );
}


function MoneyNum({
  value,
  currency,
  bold,
  positive,
  className,
}: {
  readonly value: number | null;
  readonly currency: string;
  readonly bold?: boolean;
  //: Tint the cell emerald when the value represents a positive
  //: outcome (e.g. the "savings vs quoted" column). Mirrors the
  //: ``Money`` component's ``positive`` prop so a swap between
  //: the two doesn't lose the green highlight.
  readonly positive?: boolean;
  readonly className?: string;
}) {
  return (
    <td
      className={[
        "whitespace-nowrap px-2 py-2 text-right font-mono tabular-nums",
        positive ? "text-emerald-700" : "text-ink-800",
        bold ? "font-semibold" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {value === null ? (
        <span className="text-ink-400">—</span>
      ) : (
        formatMoneyLocal(value, currency, 4)
      )}
    </td>
  );
}
