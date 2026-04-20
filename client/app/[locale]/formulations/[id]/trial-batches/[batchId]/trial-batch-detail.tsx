"use client";

import { ArrowLeft, Download, FileJson } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

import { Link } from "@/i18n/navigation";
import type {
  BOMEntry,
  BOMResult,
  TrialBatchDto,
} from "@/services/trial_batches";
import {
  trialBatchesEndpoints,
  useTrialBatch,
  useTrialBatchRender,
} from "@/services/trial_batches";

import { ValidationLink } from "./validation-link";


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

  // Fill weight only — matches the Excel workbook's ``BOM Actives
  // Calculation`` denominator (``SUM(mg/serving)`` across active +
  // excipient rows, shell excluded). Weight rows divide by this to
  // produce grams-per-kg-of-fill (so the column sums to 1 000 g),
  // and the shell count divides the same denominator into 1 kg to
  // report how many shells that much fill will fit into.
  const totalFillMg = useMemo(() => {
    const parsed = Number.parseFloat(bom.total_mg_per_unit);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [bom.total_mg_per_unit]);

  return (
    <div className="mt-8 flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {bom.formulation_name} · v{bom.version_number}
            {bom.version_label ? ` — ${bom.version_label}` : ""}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {batch.label || tBatches("detail.untitled")}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {tBatches("detail.scale_equation", {
              packs: formatInteger(bom.batch_size_units),
              perPack: formatInteger(bom.units_per_pack),
              total: formatInteger(bom.total_units_in_batch),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/formulations/${formulationId}/trial-batches`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <ArrowLeft className="h-4 w-4" />
            {tBatches("detail.back")}
          </Link>
          <a
            href={trialBatchesEndpoints.bom(orgId, initialBatch.id, "csv")}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <Download className="h-4 w-4" />
            {tBatches("detail.export_csv")}
          </a>
          <a
            href={trialBatchesEndpoints.bom(orgId, initialBatch.id, "json")}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <FileJson className="h-4 w-4" />
            {tBatches("detail.export_json")}
          </a>
          <ValidationLink
            orgId={orgId}
            formulationId={formulationId}
            batchId={initialBatch.id}
          />
        </div>
      </header>

      {batch.notes ? (
        <section className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-orange-800 ring-1 ring-inset ring-orange-200">
          {batch.notes}
        </section>
      ) : null}

      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
        <h2 className="text-base font-semibold text-ink-1000">
          {tBatches("detail.bom_title")}
        </h2>

        <div className="mt-6 overflow-hidden rounded-xl ring-1 ring-ink-200">
          <table className="w-full border-collapse">
            <colgroup>
              <col className="w-28" />
              <col />
              <col className="w-28" />
              <col className="w-28" />
              <col className="w-32" />
              <col className="w-36" />
            </colgroup>
            <thead className="bg-ink-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                  {tBatches("detail.column.code")}
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                  {tBatches("detail.column.material")}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                  {tBatches("detail.column.mg_per_unit")}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                  {tBatches("detail.column.g_per_pack")}
                </th>
                <th className="bg-orange-50 px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-orange-800 ring-1 ring-inset ring-orange-200">
                  {tBatches("detail.column.bom")}
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                  {tBatches("detail.column.kg_per_batch")}
                </th>
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.flatMap((category) => {
                const rows = grouped.get(category) ?? [];
                if (rows.length === 0) return [];
                return [
                  <tr key={`header-${category}`} className="bg-ink-50/50">
                    <td
                      colSpan={6}
                      className="border-t border-ink-200 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500"
                    >
                      {tBatches(
                        `detail.section.${category}` as "detail.section.active",
                      )}
                    </td>
                  </tr>,
                  ...rows.map((entry, idx) => (
                    <tr
                      key={`${entry.category}-${entry.label}-${entry.internal_code}`}
                      className={
                        idx < rows.length - 1
                          ? "border-b border-ink-100"
                          : ""
                      }
                    >
                      <td className="px-3 py-2.5 text-xs text-ink-500">
                        {entry.internal_code || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-1000">
                        {entry.label}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ink-700">
                        {formatNumber(entry.mg_per_unit, 4)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs tabular-nums text-ink-700">
                        {formatNumber(entry.g_per_pack, 4)}
                      </td>
                      <td className="bg-orange-50 px-3 py-2.5 text-right text-sm font-medium tabular-nums text-orange-900 ring-1 ring-inset ring-orange-200">
                        {formatBomPerKg(entry, totalFillMg, tBatches)}
                      </td>
                      <td className="px-3 py-2.5 text-right text-sm font-medium tabular-nums text-ink-1000">
                        {entry.uom === "count"
                          ? `${formatInteger(entry.count_per_batch)} ${tBatches("detail.each")}`
                          : `${formatNumber(entry.kg_per_batch, 4)} kg`}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
          <TotalTile
            label={tBatches("detail.fill_per_unit")}
            value={`${formatNumber(bom.total_mg_per_unit, 4)} mg`}
          />
          <TotalTile
            label={tBatches("detail.fill_per_pack")}
            value={`${formatNumber(bom.total_g_per_pack, 4)} g`}
          />
          <TotalTile
            emphasis
            label={tBatches("detail.fill_per_batch")}
            value={`${formatNumber(bom.total_kg_per_batch, 4)} kg`}
          />
          {bom.total_count_per_batch > 0 ? (
            <TotalTile
              emphasis
              label={tBatches("detail.shells_per_batch")}
              value={`${formatInteger(bom.total_count_per_batch)} ${tBatches("detail.each")}`}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}


function TotalTile({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        emphasis
          ? "flex items-center justify-between gap-3 rounded-xl bg-ink-1000 px-4 py-3 text-ink-0"
          : "flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 ring-1 ring-inset ring-ink-200"
      }
    >
      <span
        className={
          emphasis
            ? "text-xs font-medium uppercase tracking-wide text-ink-200"
            : "text-xs font-medium uppercase tracking-wide text-ink-500"
        }
      >
        {label}
      </span>
      <span
        className={
          emphasis
            ? "text-right text-base font-semibold tabular-nums"
            : "text-right text-base font-semibold tabular-nums text-ink-1000"
        }
      >
        {value}
      </span>
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
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${grouped}.${trimmed}` : grouped;
}


/** Render the BOM-per-kg cell for a single entry.
 *
 * Matches the Valley workbook's ``BOM Actives Calculation`` column
 * ``BOM``: ``(mg_per_serving × 1000) / SUM(mg_per_serving)`` where
 * the sum runs over the blended fill (actives + excipients), so the
 * weight rows sum to exactly 1 000 g by construction. Capsule
 * shells live outside that fill sum; for them we still scale 1 kg
 * of fill into a count of units using the same denominator, which
 * tells procurement how many empty shells to buy alongside each kg
 * of blended powder.
 */
function formatBomPerKg(
  entry: BOMEntry,
  totalFillMg: number,
  tBatches: ReturnType<typeof useTranslations<"trial_batches">>,
): string {
  if (!(totalFillMg > 0)) return "—";

  if (entry.uom === "count") {
    // One shell per capsule, so 1 kg of fill corresponds to
    // ``1_000_000 / fill_mg_per_unit`` shells. Round to the nearest
    // whole shell — half a shell is not a procurable thing.
    const pieces = Math.round(1_000_000 / totalFillMg);
    return `${pieces.toLocaleString("en-US").replace(/,/g, "\u202F")} ${tBatches("detail.each")}`;
  }

  const mgPerUnit = Number.parseFloat(entry.mg_per_unit);
  if (!Number.isFinite(mgPerUnit)) return "—";
  const grams = (mgPerUnit * 1000) / totalFillMg;
  return `${formatNumber(grams.toFixed(4), 4)} g`;
}
