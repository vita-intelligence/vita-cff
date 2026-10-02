"use client";

import { AlertTriangle, Loader2 } from "lucide-react";

import {
  useSpecCostBreakdown,
  type SpecCostIngredientRowDto,
  type SpecCostLabourRowDto,
} from "@/services/specifications";

/** Convert a decimal-as-string into a currency-formatted display.
 *  Mirrors the proposal panel's helper so numbers render the same
 *  way on both surfaces.
 *
 *  Very small positive values (sub-pennies in £ terms) collapse to
 *  the display zero at 2-4 decimal places — a 6 mg × £1/kg
 *  ingredient contributes £0.000006 per pack, which rounds to
 *  £0.00 and reads as "no price" even though the pipeline is
 *  working. For positive values that would round to zero we render
 *  "<£0.0001" so the operator sees "yes it's priced, it's just
 *  negligible per unit". */
function fmtMoney(
  value: string | number | null | undefined,
  currency: string,
  maxFractionDigits = 4,
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const threshold = Math.pow(10, -maxFractionDigits) / 2;
  if (n > 0 && n < threshold) {
    try {
      const tiny = new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: currency || "GBP",
        maximumFractionDigits: maxFractionDigits,
        minimumFractionDigits: maxFractionDigits,
      }).format(threshold * 2);
      return `<${tiny}`;
    } catch {
      return `<${(threshold * 2).toFixed(maxFractionDigits)} ${currency}`.trim();
    }
  }
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      maximumFractionDigits: maxFractionDigits,
      minimumFractionDigits: Math.min(2, maxFractionDigits),
    }).format(n);
  } catch {
    return `${n.toFixed(maxFractionDigits)} ${currency}`.trim();
  }
}


/** Inline ingredient + labour breakdown for the spec-sheet modals.
 *  Director sees this before committing a price. Fetches on open
 *  (via ``enabled`` prop) so a closed modal doesn't ping PSP. */
export function SpecCostBreakdownBlock({
  orgId,
  sheetId,
  enabled = true,
  sheetCurrency,
}: {
  readonly orgId: string;
  readonly sheetId: string;
  readonly enabled?: boolean;
  readonly sheetCurrency: string;
}) {
  const query = useSpecCostBreakdown(orgId, sheetId, { enabled });
  const data = query.data;
  const currency = data?.currency_code || sheetCurrency || "GBP";

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-ink-200 bg-ink-50 px-3 py-4 text-xs text-ink-500">
        <Loader2 className="size-3.5 animate-spin" />
        Computing cost breakdown…
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
        <AlertTriangle className="mt-0.5 size-3.5" />
        <div>
          <p className="font-medium">Couldn&apos;t load the breakdown.</p>
          <p>
            {query.error instanceof Error
              ? query.error.message
              : "Unknown error."}
          </p>
        </div>
      </div>
    );
  }

  if (!data || !data.psp_configured) {
    return (
      <p className="rounded-md border border-dashed border-ink-200 bg-ink-0 px-3 py-4 text-center text-xs text-ink-500">
        PSP isn&apos;t configured — cost breakdown relies on live
        vendor + routing data.
      </p>
    );
  }

  const emptyIngredients = data.ingredient_rows.length === 0;
  const emptyLabour = data.labour_rows.length === 0;

  return (
    <div className="space-y-4">
      {/* Totals strip — the headline numbers so the director sees
          the answer before diving into the data behind it. */}
      <div className="grid grid-cols-1 gap-2 rounded-md border border-ink-200 bg-ink-50 p-3 text-xs sm:grid-cols-3">
        <SummaryStat
          label="Ingredients / unit"
          value={fmtMoney(data.ingredients_per_unit, currency, 4)}
        />
        <SummaryStat
          label="Labour / unit"
          value={fmtMoney(data.labour_per_unit, currency, 4)}
        />
        <SummaryStat
          label="Total cost / unit"
          value={fmtMoney(data.total_per_unit, currency, 4)}
          bold
        />
      </div>

      {/* Ingredients table */}
      {emptyIngredients ? (
        <div className="rounded-md border border-ink-200 bg-ink-0 p-3 text-xs text-ink-500">
          No ingredient lines on this formulation.
        </div>
      ) : (
        <div className="rounded-md border border-ink-200 bg-ink-0 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-700">
            Ingredients
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="pb-1 pr-2">Item</th>
                  <th className="pb-1 pr-2 text-right">
                    <span className="hidden sm:inline">Mg / pack</span>
                    <span className="sm:hidden">mg</span>
                  </th>
                  <th className="pb-1 pr-2 text-right">Unit cost</th>
                  <th className="hidden pb-1 pr-2 md:table-cell">Source</th>
                  <th className="pb-1 text-right">Line / unit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.ingredient_rows.map((row, i) => (
                  <IngredientRow
                    key={`${row.item_name}-${i}`}
                    row={row}
                    currency={currency}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Labour table */}
      {emptyLabour ? (
        <div className="rounded-md border border-ink-200 bg-ink-0 p-3 text-xs text-ink-500">
          No routing stages on this formulation.
        </div>
      ) : (
        <div className="rounded-md border border-ink-200 bg-ink-0 p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-700">
            Labour / overhead
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="pb-1 pr-2">Stage</th>
                  <th className="pb-1 pr-2">Basis</th>
                  <th className="hidden pb-1 pr-2 text-right md:table-cell">
                    Time
                  </th>
                  <th className="pb-1 text-right">Per unit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.labour_rows.map((row, i) => (
                  <LabourRow
                    key={`${row.stage_name}-${i}`}
                    row={row}
                    currency={currency}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


function SummaryStat({
  label,
  value,
  bold,
}: {
  readonly label: string;
  readonly value: string;
  readonly bold?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-500">
        {label}
      </p>
      <p
        className={`font-mono tabular-nums text-ink-900 ${bold ? "text-sm font-semibold" : "text-sm"}`}
      >
        {value}
      </p>
    </div>
  );
}


function IngredientRow({
  row,
  currency,
}: {
  readonly row: SpecCostIngredientRowDto;
  readonly currency: string;
}) {
  return (
    <tr>
      <td className="py-1.5 pr-2">
        <p className="truncate font-medium text-ink-800">{row.item_name}</p>
        {row.item_code ? (
          <p className="font-mono text-[10px] text-ink-500">{row.item_code}</p>
        ) : null}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
        {row.mg_per_pack ? `${Number(row.mg_per_pack).toFixed(1)}` : "—"}
      </td>
      <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700">
        {row.unit_cost
          ? `${fmtMoney(row.unit_cost, row.currency_code || currency, 4)}/${row.uom_symbol || "kg"}`
          : "—"}
      </td>
      <td className="hidden py-1.5 pr-2 md:table-cell">
        <SourceBadge source={row.source} vendor={row.vendor_name} />
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums text-ink-900">
        {fmtMoney(row.line_cost_per_unit, row.currency_code || currency, 4)}
      </td>
    </tr>
  );
}


function LabourRow({
  row,
  currency,
}: {
  readonly row: SpecCostLabourRowDto;
  readonly currency: string;
}) {
  return (
    <tr>
      <td className="py-1.5 pr-2">
        <p className="truncate font-medium text-ink-800">{row.stage_name}</p>
        <p className="truncate text-[10px] text-ink-500">
          {row.workstation_group_name}
        </p>
      </td>
      <td className="py-1.5 pr-2">
        <BasisChip row={row} currency={currency} />
      </td>
      <td className="hidden py-1.5 pr-2 text-right font-mono tabular-nums text-ink-700 md:table-cell">
        {formatHours(row.labour_hours_total)}
      </td>
      <td className="py-1.5 text-right font-mono tabular-nums text-ink-900">
        {fmtMoney(row.cost_per_unit, currency, 4)}
      </td>
    </tr>
  );
}


function formatHours(hoursStr: string | null): string {
  if (!hoursStr) return "—";
  const n = Number(hoursStr);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return `${n.toFixed(1)} h`;
  return `${Math.round(n * 60)} min`;
}


function BasisChip({
  row,
  currency,
}: {
  readonly row: SpecCostLabourRowDto;
  readonly currency: string;
}) {
  const wagePart = row.labour_hourly_rate ? (
    <p className="text-[10px] text-ink-500">
      <span className="font-medium text-ink-700">
        + {fmtMoney(row.labour_hourly_rate, currency, 2)}/hr
      </span>{" "}
      {row.labour_source === "session"
        ? "wage (HR session)"
        : "wage (fallback)"}
    </p>
  ) : null;

  if (row.basis === "routing_fixed") {
    const parts: string[] = [];
    if (row.fixed_cost) {
      parts.push(`${fmtMoney(row.fixed_cost, currency, 2)} / batch`);
    }
    if (row.variable_cost) {
      parts.push(`${fmtMoney(row.variable_cost, currency, 2)} / unit`);
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
          {row.hourly_rate ? `${fmtMoney(row.hourly_rate, currency, 2)}/hr` : "—"}
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
