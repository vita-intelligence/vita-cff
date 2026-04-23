"use client";

import { ArrowLeft, Download, FileJson, Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

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

  // Columns actually relevant to this batch's size mode. ``pack``
  // mode exposes every BOM column; ``unit`` mode drops the pack
  // derivative — a 10-capsule bench run has no "per pack" quantity
  // to reference, and showing the number would invite confusion.
  const availableColumns = useMemo<readonly ColumnKey[]>(
    () =>
      bom.batch_size_mode === "unit"
        ? COLUMN_KEYS.filter((k) => !PACK_ONLY_COLUMNS.has(k))
        : COLUMN_KEYS,
    [bom.batch_size_mode],
  );

  // Column-visibility state for the print view. Default: every
  // available column on. Scientists untick columns they don't want
  // to print. Re-seeded when the mode changes so switching to unit
  // mode doesn't leave a stale g/pack toggle on.
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(
    () => Object.fromEntries(COLUMN_KEYS.map((k) => [k, true])) as Record<ColumnKey, boolean>,
  );
  const toggleColumn = (key: ColumnKey) =>
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));

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

  // Dynamic print rules — hide the columns the scientist ticked off.
  // Rendered into a <style> tag and scoped via the ``bom-print-root``
  // marker class so these @media print rules never leak out to other
  // pages that happen to render BOM data.
  const hiddenColumnSelectors = COLUMN_KEYS.filter((k) => !visibleColumns[k])
    .map((k) => `.bom-print-root [data-col="${k}"]`)
    .join(",\n");
  const printCss = `
    @media print {
      html, body { background: #fff !important; }
      .bom-print-hide { display: none !important; }
      .bom-print-root { padding: 0 !important; margin: 0 !important; }
      ${hiddenColumnSelectors ? `${hiddenColumnSelectors} { display: none !important; }` : ""}
    }
  `;

  return (
    <div className="bom-print-root mt-8 flex flex-col gap-6 print:mt-0 print:gap-3">
      <style dangerouslySetInnerHTML={{ __html: printCss }} />
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
            {bom.batch_size_mode === "unit"
              ? tBatches("detail.scale_equation_unit", {
                  units: formatInteger(bom.total_units_in_batch),
                })
              : tBatches("detail.scale_equation", {
                  packs: formatInteger(bom.batch_size_units),
                  perPack: formatInteger(bom.units_per_pack),
                  total: formatInteger(bom.total_units_in_batch),
                })}
          </p>
        </div>
        <div className="bom-print-hide flex flex-wrap items-center gap-2">
          <Link
            href={`/formulations/${formulationId}/trial-batches`}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <ArrowLeft className="h-4 w-4" />
            {tBatches("detail.back")}
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-1000 px-3 py-2 text-sm font-medium text-ink-0 transition-colors hover:bg-ink-800"
          >
            <Printer className="h-4 w-4" />
            {tBatches("detail.print")}
          </button>
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

      {/* Column-visibility toolbar. Only visible on-screen — scientists
          tick off which BOM columns to include on the printed page.
          The code + material columns stay on-by-default but can be
          disabled if they only need a grams-per-pack sheet. */}
      <div className="bom-print-hide flex flex-wrap items-center gap-2 rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tBatches("detail.print_columns")}
        </span>
        {availableColumns.map((key) => (
          <label
            key={key}
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset transition-colors ${
              visibleColumns[key]
                ? "bg-orange-500 text-ink-0 ring-orange-500"
                : "bg-ink-0 text-ink-600 ring-ink-200 hover:bg-ink-100"
            }`}
          >
            <input
              type="checkbox"
              checked={visibleColumns[key]}
              onChange={() => toggleColumn(key)}
              className="sr-only"
            />
            {tBatches(
              `detail.column_label.${key}` as "detail.column_label.code",
            )}
          </label>
        ))}
      </div>

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
              {availableColumns.includes("g_per_pack") ? (
                <col className="w-28" />
              ) : null}
              <col className="w-32" />
              <col className="w-36" />
            </colgroup>
            <thead className="bg-ink-50">
              <tr>
                <th
                  data-col="code"
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500"
                >
                  {tBatches("detail.column.code")}
                </th>
                <th
                  data-col="material"
                  className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500"
                >
                  {tBatches("detail.column.material")}
                </th>
                <th
                  data-col="mg_per_unit"
                  className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500"
                >
                  {tBatches("detail.column.mg_per_unit")}
                </th>
                {availableColumns.includes("g_per_pack") ? (
                  <th
                    data-col="g_per_pack"
                    className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500"
                  >
                    {tBatches("detail.column.g_per_pack")}
                  </th>
                ) : null}
                <th
                  data-col="bom"
                  className="bg-orange-50 px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-orange-800 ring-1 ring-inset ring-orange-200"
                >
                  {tBatches("detail.column.bom")}
                </th>
                <th
                  data-col="totals"
                  className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500"
                >
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
                      colSpan={availableColumns.length}
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
                      <td
                        data-col="code"
                        className="px-3 py-2.5 text-xs text-ink-500"
                      >
                        {entry.internal_code || "—"}
                      </td>
                      <td
                        data-col="material"
                        className="px-3 py-2.5 text-sm text-ink-1000"
                      >
                        {entry.label}
                      </td>
                      <td
                        data-col="mg_per_unit"
                        className="px-3 py-2.5 text-right text-xs tabular-nums text-ink-700"
                      >
                        {formatNumber(entry.mg_per_unit, 4)}
                      </td>
                      {availableColumns.includes("g_per_pack") ? (
                        <td
                          data-col="g_per_pack"
                          className="px-3 py-2.5 text-right text-xs tabular-nums text-ink-700"
                        >
                          {formatNumber(entry.g_per_pack, 4)}
                        </td>
                      ) : null}
                      <td
                        data-col="bom"
                        className="bg-orange-50 px-3 py-2.5 text-right text-sm font-medium tabular-nums text-orange-900 ring-1 ring-inset ring-orange-200"
                      >
                        {formatBomPerKg(entry, totalFillMg, tBatches)}
                      </td>
                      <td
                        data-col="totals"
                        className="px-3 py-2.5 text-right text-sm font-medium tabular-nums text-ink-1000"
                      >
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

        <div className="bom-print-hide mt-8 grid grid-cols-1 gap-3 md:grid-cols-2">
          <TotalTile
            label={tBatches("detail.fill_per_unit")}
            value={`${formatNumber(bom.total_mg_per_unit, 4)} mg`}
          />
          {bom.batch_size_mode === "pack" ? (
            <TotalTile
              label={tBatches("detail.fill_per_pack")}
              value={`${formatNumber(bom.total_g_per_pack, 4)} g`}
            />
          ) : null}
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

/** Every data column the BOM table can show. The scientist can
 *  toggle any subset for printing. ``code`` and ``material`` stay
 *  on-by-default (the BOM is useless without them) but remain
 *  togglable so a kg-only-column print stays compact. */
const COLUMN_KEYS = [
  "code",
  "material",
  "mg_per_unit",
  "g_per_pack",
  "bom",
  "totals",
] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];

/** Columns that only make sense in "pack" mode — when the run
 *  produces finished packs to ship. In "unit" mode (bench-scale
 *  testing) there's no pack concept and the column shows a
 *  multiplier that means nothing to the scientist. */
const PACK_ONLY_COLUMNS: ReadonlySet<ColumnKey> = new Set(["g_per_pack"]);


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
  // Weight rows in kg so the column values agree with the "per kg"
  // header. The numbers sum to exactly 1.000 kg across the blended
  // fill by construction, so scaling to any batch size is just
  // ``(row value × batch kg)``.
  const kg = mgPerUnit / totalFillMg;
  return `${formatNumber(kg.toFixed(6), 6)} kg`;
}
