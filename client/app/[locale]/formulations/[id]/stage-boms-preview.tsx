/**
 * Stage BOMs preview — the "here's what's about to land on PSP"
 * card. Renders one section per stage with the correct per-stage
 * ingredient allocation (routing draft aware), quantities scaled to
 * the finished-units preview, and PSP deep-links per item + per
 * stage title.
 *
 * Every row that resolves to a mirrored PSP item exposes an
 * "Open on PSP" chip. Each stage header links to its own PSP item
 * (semi-finished item for non-terminal stages, finished-product
 * item for the terminal). Non-terminal stages also emit a synthesised
 * "Consumes 1 × <prior stage semi>" row so the multi-stage flow is
 * legible at a glance.
 */

"use client";

import { ExternalLink, Printer } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import type {
  FormulationStageDto,
  StageKey,
} from "@/services/formulations/types";


/** One BOM row on a stage. Matches the ``BomLine`` shape the parent
 *  compute emits so we can consume it directly. */
export interface StageBomsPreviewRow {
  readonly key: string;
  readonly label: string;
  readonly code: string;
  /** mg per finished serving. Preview scales it to the per-pack /
   *  per-batch total using ``servingsPerPack`` × ``finishedUnits``. */
  readonly mg: number;
  readonly itemId: string | null;
  /** PSP item uuid on the row's SKU when mirrored — powers the
   *  per-row "Open on PSP" link. */
  readonly pspSourceUuid: string | null;
}

/** Per-stage bucket the parent passes in. Own rows are the
 *  ingredients routed to this stage (unassigned rows fold into the
 *  terminal bucket, matching the push cascade). ``priorStage`` is
 *  set on every non-first stage so we can render the synthesised
 *  "Consumes 1 × <prior semi>" row with a PSP link. */
export interface StageBomsPreviewStage {
  readonly stage: FormulationStageDto;
  readonly index: number;
  readonly isTerminal: boolean;
  readonly ownRows: readonly StageBomsPreviewRow[];
  readonly priorStage: FormulationStageDto | null;
}


export interface StageBomsPreviewProps {
  readonly formulationCode: string;
  readonly formulationName: string;
  readonly stages: readonly StageBomsPreviewStage[];
  readonly servingsPerPack: number;
  readonly pspBaseUrl: string | null;
  /** UUID of the finished-product PSP item the terminal stage's
   *  card should link to. ``null`` until the first push cascade
   *  creates it. */
  readonly finishedProductPspUuid: string | null;
}


const STAGE_KEY_LABELS: Record<StageKey, string> = {
  blend: "Blend",
  encapsulate: "Encapsulate",
  bottle: "Bottle",
  label: "Label",
  fill: "Fill",
  cook: "Cook",
  deposit: "Deposit",
  cure: "Cure",
  coat: "Coat",
  package: "Package",
  custom: "Custom",
};


function pspItemHref(
  baseUrl: string | null,
  uuid: string | null | undefined,
): string | null {
  if (!baseUrl || !uuid) return null;
  return `${baseUrl}/production/items/${uuid}`;
}


function formatQty(mg: number): string {
  if (mg >= 1_000_000) return `${(mg / 1_000_000).toFixed(3)} kg`;
  if (mg >= 1000) return `${(mg / 1000).toFixed(2)} g`;
  return `${mg.toFixed(2)} mg`;
}


function OpenOnPspChip({
  href,
  label = "Open on PSP",
}: {
  href: string | null;
  label?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800 ring-1 ring-inset ring-orange-200 hover:bg-orange-100"
      title="Opens this item on PSP in a new tab"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  );
}


function printOnly(stageId: string) {
  if (typeof document === "undefined") return;
  const cls = `bom-preview-print-only-${stageId}`;
  document.body.classList.add("bom-preview-print-active", cls);
  const cleanup = () => {
    document.body.classList.remove("bom-preview-print-active", cls);
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}


export function StageBomsPreview({
  formulationCode,
  formulationName,
  stages,
  servingsPerPack,
  pspBaseUrl,
  finishedProductPspUuid,
}: StageBomsPreviewProps) {
  // Preview-only "finished units to make" input — same idea as the
  // Routing tab's scaling input. Multiplies every row's per-serving
  // mg by ``servingsPerPack × finishedUnits`` so the table shows
  // batch quantities. Nothing is persisted.
  const [finishedUnitsInput, setFinishedUnitsInput] = useState("1");
  const finishedUnits = Math.max(
    1,
    Number.parseInt(finishedUnitsInput || "1", 10) || 1,
  );
  const batchScale = servingsPerPack * finishedUnits;

  if (stages.length === 0) {
    return (
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          Stage BOMs preview
        </p>
        <p className="mt-3 text-sm text-ink-700">
          No production stages defined yet — the push cascade will
          fall back to a single flat BOM against the linked finished
          product. Add stages on the Stages tab to model the per-stage
          BOM + routing that PSP receives.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <style
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
@media print {
  body.bom-preview-print-active > * { visibility: hidden !important; }
  body.bom-preview-print-active .bom-preview-card { visibility: hidden !important; }
  body.bom-preview-print-active .bom-preview-card [data-print-target="true"] {
    visibility: visible !important;
    position: absolute; left: 0; top: 0; width: 100%;
  }
  body.bom-preview-print-active .bom-preview-card [data-print-target="true"] * {
    visibility: visible !important;
  }
}
          `,
        }}
      />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Stage BOMs preview
          </p>
          <p className="mt-1 text-sm text-ink-700">
            What lands on PSP on the next save — one BOM + routing per
            stage. Non-terminal stages spawn a semi-finished item that
            the next stage consumes at qty&nbsp;1. Every mirrored SKU +
            stage carries an <strong>Open on PSP</strong> chip so you
            can jump into PSP&apos;s BOM page for cross-checking.
          </p>
        </div>
        <div className="shrink-0 rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200">
          <label className="block text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Finished units to make
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              value={finishedUnitsInput}
              onChange={(e) => setFinishedUnitsInput(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(
                  finishedUnitsInput || "1",
                  10,
                );
                setFinishedUnitsInput(
                  Number.isFinite(parsed) && parsed >= 1
                    ? String(parsed)
                    : "1",
                );
              }}
              className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
            />
            <span className="text-[11px] text-ink-500">
              × {servingsPerPack} servings
            </span>
          </div>
          <p className="mt-1 max-w-[240px] text-[10px] leading-tight text-ink-500">
            Preview only — scales the per-stage quantities below.
            Nothing is saved.
          </p>
        </div>
      </header>

      <ol className="bom-preview-card mt-4 flex flex-col gap-3">
        {stages.map((stageBom) => {
          const stage = stageBom.stage;
          const label = STAGE_KEY_LABELS[stage.stage_key] ?? "Custom";
          const workstation =
            stage.workstation_group_name || "(no workstation picked)";
          const stagePspUuid = stageBom.isTerminal
            ? finishedProductPspUuid
            : stage.psp_semi_finished_uuid;
          const stagePspHref = pspItemHref(pspBaseUrl, stagePspUuid);
          // Sum of own rows scaled to the current preview. Excludes
          // the synthesised prior-semi row (it's qty=1, dimensionless
          // on the BOM math side — treated the same way PSP does).
          const totalMg = stageBom.ownRows.reduce(
            (acc, r) => acc + r.mg,
            0,
          );
          const totalBatchMg = totalMg * batchScale;
          return (
            <li
              key={stage.id}
              data-stage-id={stage.id}
              data-print-target="true"
              className={`rounded-xl p-4 ring-1 ring-inset ${
                stageBom.isTerminal
                  ? "bg-orange-50/40 ring-orange-200"
                  : "bg-ink-50 ring-ink-200"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                    Stage {stageBom.index + 1} · {label}
                    {stageBom.isTerminal
                      ? " · finished product"
                      : " · semi-finished"}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold text-ink-1000">
                      {stage.name}
                    </h4>
                    <OpenOnPspChip href={stagePspHref} />
                  </div>
                  <p className="mt-1 text-xs text-ink-700">
                    <span className="font-medium">Produces:</span>{" "}
                    {stage.psp_item_name ||
                      (stageBom.isTerminal ? "Finished product" : "Semi output")}
                    {" · "}
                    <span className="font-medium">Runs on:</span>{" "}
                    {workstation}
                    {stage.setup_time_min || stage.cycle_time_min ? (
                      <>
                        {" · "}
                        <span className="font-medium">Setup / cycle:</span>{" "}
                        {stage.setup_time_min ?? "—"} /{" "}
                        {stage.cycle_time_min ?? "—"} min
                      </>
                    ) : null}
                  </p>
                  {stage.operation_description ? (
                    <p className="mt-1 text-xs italic text-ink-700">
                      {stage.operation_description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => printOnly(stage.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 print:hidden"
                  title="Print this stage's BOM only"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </div>

              <div className="mt-3 rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
                  Bill of materials — {formulationCode} · {formulationName}
                </p>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wide text-ink-500">
                      <th className="py-1.5 pr-2 font-medium">Part</th>
                      <th className="py-1.5 pr-2 font-medium">Code</th>
                      <th className="py-1.5 pr-2 text-right font-medium">
                        Per finished unit
                      </th>
                      <th className="py-1.5 text-right font-medium">
                        For {finishedUnits} unit
                        {finishedUnits === 1 ? "" : "s"}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {stageBom.priorStage ? (
                      <tr className="bg-orange-50/40">
                        <td className="py-2 pr-2">
                          <div className="flex flex-wrap items-center gap-2 text-ink-900">
                            <span>
                              {stageBom.priorStage.psp_item_name ||
                                stageBom.priorStage.name ||
                                `Stage ${stageBom.priorStage.sort_order + 1}`}
                            </span>
                            <span className="text-[11px] italic text-orange-700">
                              (auto — prior stage semi)
                            </span>
                            <OpenOnPspChip
                              href={pspItemHref(
                                pspBaseUrl,
                                stageBom.priorStage.psp_semi_finished_uuid,
                              )}
                            />
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-xs text-ink-500">
                          semi-finished
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-ink-900">
                          1
                        </td>
                        <td className="py-2 text-right tabular-nums text-ink-900">
                          {finishedUnits}
                        </td>
                      </tr>
                    ) : null}
                    {stageBom.ownRows.length === 0 && !stageBom.priorStage ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="py-3 text-center text-xs text-ink-500"
                        >
                          No ingredients routed to this stage yet.
                        </td>
                      </tr>
                    ) : (
                      stageBom.ownRows.map((row) => {
                        const perUnit = row.mg;
                        const perBatch = row.mg * batchScale;
                        return (
                          <tr key={row.key}>
                            <td className="py-2 pr-2">
                              <div className="flex flex-wrap items-center gap-2 text-ink-900">
                                <span>{row.label}</span>
                                <OpenOnPspChip
                                  href={pspItemHref(
                                    pspBaseUrl,
                                    row.pspSourceUuid,
                                  )}
                                />
                              </div>
                            </td>
                            <td className="py-2 pr-2 text-xs text-ink-500">
                              {row.code || "—"}
                            </td>
                            <td className="py-2 pr-2 text-right tabular-nums text-ink-900">
                              {formatQty(perUnit)}
                            </td>
                            <td className="py-2 text-right tabular-nums text-ink-900">
                              {formatQty(perBatch)}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  {stageBom.ownRows.length > 0 ? (
                    <tfoot>
                      <tr className="border-t border-ink-200 text-[11px] font-medium uppercase tracking-wide text-ink-500">
                        <td className="py-2 pr-2" colSpan={2}>
                          Stage own-ingredients total
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums text-ink-900">
                          {formatQty(totalMg)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-ink-900">
                          {formatQty(totalBatchMg)}
                        </td>
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
                {!stagePspHref ? (
                  <p className="mt-2 text-[11px] text-ink-500">
                    {stageBom.isTerminal
                      ? "Terminal stage — first push creates the linked finished-product item."
                      : `First push will create the PSP semi-finished item (external_sku = NPD-STAGE-…-${stage.sort_order}).`}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}


// Re-exported for the parent's type-only use so it can shape the
// props without importing the internal StageBom type twice.
export type { ReactNode as _StageBomsPreviewReactNode };
