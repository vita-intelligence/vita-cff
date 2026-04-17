"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { Link } from "@/i18n/navigation";
import type {
  BOMEntry,
  BOMResult,
  TrialBatchDto,
} from "@/services/trial_batches";
import {
  useTrialBatch,
  useTrialBatchRender,
} from "@/services/trial_batches";


/**
 * Client-side view for a single trial batch's scaled-up BOM.
 * Hydrates from the server fetch (SSR on the route page) and
 * revalidates via TanStack Query so subsequent edits propagate.
 */
export function TrialBatchDetail({
  orgId,
  formulationId,
  initialBatch,
  initialBom,
  canWrite: _canWrite,
}: {
  orgId: string;
  formulationId: string;
  initialBatch: TrialBatchDto;
  initialBom: BOMResult;
  canWrite: boolean;
}) {
  const tBatches = useTranslations("trial_batches");

  const batchQuery = useTrialBatch(orgId, initialBatch.id);
  const renderQuery = useTrialBatchRender(orgId, initialBatch.id);

  const batch = batchQuery.data ?? initialBatch;
  const bom = renderQuery.data ?? initialBom;

  const grouped = useMemo(() => groupByCategory(bom.entries), [bom.entries]);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-black tracking-tight uppercase md:text-3xl">
            {batch.label || tBatches("detail.untitled")}
          </h1>
          <p className="font-mono text-xs text-ink-600">
            {bom.formulation_name} · v{bom.version_number}
            {bom.version_label ? ` — ${bom.version_label}` : ""} ·{" "}
            {formatInteger(bom.batch_size_units)}{" "}
            {tBatches("detail.packs")}
          </p>
          <p className="mt-1 font-mono text-[10px] tracking-widest uppercase text-ink-500">
            {tBatches("detail.scale_equation", {
              packs: formatInteger(bom.batch_size_units),
              perPack: formatInteger(bom.units_per_pack),
              total: formatInteger(bom.total_units_in_batch),
            })}
          </p>
        </div>
        <Link
          href={`/formulations/${formulationId}`}
          className="inline-flex items-center justify-center rounded-none border-2 border-ink-1000 bg-ink-0 px-4 py-1.5 text-sm font-bold tracking-wider uppercase text-ink-1000 transition-colors hover:bg-ink-100"
        >
          {tBatches("detail.back")}
        </Link>
      </header>

      {batch.notes ? (
        <section className="border-2 border-ink-500 bg-ink-100 px-4 py-3 font-mono text-xs text-ink-700">
          {batch.notes}
        </section>
      ) : null}

      <section className="border-2 border-ink-1000 bg-ink-0 p-6 md:p-8">
        <p className="border-b-2 border-ink-1000 pb-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {tBatches("detail.bom_title")}
        </p>

        {CATEGORIES.map((category) => {
          const rows = grouped.get(category) ?? [];
          if (rows.length === 0) return null;
          return (
            <div key={category} className="mt-6">
              <h3 className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                {tBatches(
                  `detail.section.${category}` as "detail.section.active",
                )}
              </h3>
              <table className="mt-2 w-full border-collapse">
                <thead>
                  <tr className="border-b-2 border-ink-1000 text-left">
                    <th className="py-2 pr-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tBatches("detail.column.code")}
                    </th>
                    <th className="py-2 pr-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tBatches("detail.column.material")}
                    </th>
                    <th className="py-2 px-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tBatches("detail.column.mg_per_unit")}
                    </th>
                    <th className="py-2 px-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tBatches("detail.column.g_per_pack")}
                    </th>
                    <th className="py-2 pl-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tBatches("detail.column.kg_per_batch")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((entry) => (
                    <tr
                      key={`${entry.category}-${entry.label}-${entry.internal_code}`}
                      className="border-b border-ink-200 last:border-b-0"
                    >
                      <td className="py-2 pr-2 font-mono text-xs text-ink-700">
                        {entry.internal_code || "—"}
                      </td>
                      <td className="py-2 pr-2 text-sm">{entry.label}</td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {formatNumber(entry.mg_per_unit, 4)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-xs">
                        {formatNumber(entry.g_per_pack, 4)}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono text-xs font-bold">
                        {entry.uom === "count"
                          ? `${formatInteger(entry.count_per_batch)} ${tBatches("detail.each")}`
                          : `${formatNumber(entry.kg_per_batch, 4)} kg`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}

        <dl className="mt-8 grid grid-cols-1 gap-2 border-t-2 border-ink-1000 pt-4 font-mono text-xs text-ink-1000 md:grid-cols-2">
          <div className="flex items-center justify-between gap-3 border-2 border-ink-500 bg-ink-100 px-3 py-2">
            <dt className="tracking-widest uppercase text-ink-500">
              {tBatches("detail.fill_per_unit")}
            </dt>
            <dd className="text-right font-bold">
              {formatNumber(bom.total_mg_per_unit, 4)} mg
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-2 border-ink-500 bg-ink-100 px-3 py-2">
            <dt className="tracking-widest uppercase text-ink-500">
              {tBatches("detail.fill_per_pack")}
            </dt>
            <dd className="text-right font-bold">
              {formatNumber(bom.total_g_per_pack, 4)} g
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-2 border-ink-1000 bg-ink-1000 px-3 py-2 text-ink-0 md:col-span-2">
            <dt className="tracking-widest uppercase">
              {tBatches("detail.fill_per_batch")}
            </dt>
            <dd className="text-right font-bold">
              {formatNumber(bom.total_kg_per_batch, 4)} kg
            </dd>
          </div>
          {bom.total_count_per_batch > 0 ? (
            <div className="flex items-center justify-between gap-3 border-2 border-ink-1000 bg-ink-1000 px-3 py-2 text-ink-0 md:col-span-2">
              <dt className="tracking-widest uppercase">
                {tBatches("detail.shells_per_batch")}
              </dt>
              <dd className="text-right font-bold">
                {formatInteger(bom.total_count_per_batch)}{" "}
                {tBatches("detail.each")}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
    </div>
  );
}


const CATEGORIES: readonly BOMEntry["category"][] = [
  "active",
  "excipient",
  "shell",
];

function groupByCategory(
  entries: readonly BOMEntry[],
): Map<BOMEntry["category"], BOMEntry[]> {
  const out = new Map<BOMEntry["category"], BOMEntry[]>();
  for (const category of CATEGORIES) out.set(category, []);
  for (const entry of entries) {
    const bucket = out.get(entry.category);
    if (bucket) bucket.push(entry);
  }
  return out;
}


function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(value | 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}


/** Format a decimal string for display with ASCII thousands commas.
 *
 * Deterministic on both server and client — ``toLocaleString`` is
 * deliberately avoided because Node's default locale differs from
 * the browser's (see F3.3 timestamp formatter), and group separator
 * drift would trigger hydration warnings on every BOM cell.
 */
function formatNumber(raw: string, maxDecimals: number): string {
  if (!raw) return "—";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return raw;
  const fixed = parsed.toFixed(maxDecimals);
  // Strip trailing zeros but keep at least two decimals for readability.
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}
