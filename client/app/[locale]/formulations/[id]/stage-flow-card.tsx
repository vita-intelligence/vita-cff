"use client";

import { ArrowDown, Layers, Package, PackageOpen } from "lucide-react";

import type { FormulationStageDto } from "@/services/formulations/types";
import type { PspUnitOfMeasurementDto } from "@/services/psp/api";


/**
 * Header card on the Stages tab that visualises the automatic stage-
 * to-stage cascade that runs at PSP push time.
 *
 * Every stage's output is auto-injected as the first BOM line of the
 * next stage (see ``_push_staged_cascade`` in ``apps/psp/services.py``
 * line 6413 for the BE side). Scientists don't route those flows by
 * hand — the ``suggestServingsPerOutputUnit`` derivation + the
 * ``servings_per_output_unit`` field on each stage give the push
 * cascade all it needs to compute prior-stage consumption qty.
 *
 * Before this card the cascade was invisible in the UI. Scientists
 * would read the green "Stages flow automatically" banner and still
 * wonder "OK but what actually gets consumed by what?". This surface
 * makes it concrete: per stage we show
 *
 *   * total output per pack (``servings_per_pack ÷ SPOU``), so
 *     "0.360 kg of blend per pack" and "1 pcs pack" both read
 *     directly.
 *   * arrow to the downstream stage carrying the exact consumption
 *     qty per 1 unit of the downstream output
 *     (``next.SPOU ÷ this.SPOU``), so "consumes 0.360 kg per 1 pcs
 *     pack" reads directly.
 *
 * Read-only — every input source (stage SPOU / stock UoM / servings
 * per pack) is edited elsewhere on this page. If the numbers here
 * look wrong the fix is upstream (Setup → servings_per_pack, or the
 * stage form → stock UoM / SPOU auto-derives on save).
 */
export function StageFlowCard({
  stages,
  uomOptions,
  servingsPerPack,
}: {
  stages: readonly FormulationStageDto[];
  uomOptions: readonly PspUnitOfMeasurementDto[];
  servingsPerPack: number;
}) {
  if (stages.length === 0) return null;
  if (!(servingsPerPack > 0)) return null;

  const sortedStages = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const uomSymbolByUuid = new Map(
    uomOptions.map((u) => [u.uuid, u.symbol]),
  );

  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-ink-200">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-1000">
            Stage flow
          </h3>
          <p className="mt-0.5 text-xs text-ink-600">
            How much each stage produces per pack, and what it feeds
            downstream. All values auto-derive from{" "}
            <span className="font-mono text-[11px]">
              servings_per_output_unit
            </span>{" "}
            + Setup — no manual routing needed.
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          Auto-cascade
        </span>
      </div>

      <ol className="mt-4 space-y-2">
        {sortedStages.map((stage, index) => {
          const spou = safePositiveFloat(stage.servings_per_output_unit, 1);
          const uomSymbol =
            uomSymbolByUuid.get(stage.psp_item_stock_uom_uuid ?? "") ?? "?";
          const outputPerPack = servingsPerPack / spou;

          const isTerminal = index === sortedStages.length - 1;
          const nextStage = !isTerminal ? sortedStages[index + 1] : null;
          const nextSpou = nextStage
            ? safePositiveFloat(nextStage.servings_per_output_unit, 1)
            : null;
          const nextUomSymbol = nextStage
            ? uomSymbolByUuid.get(nextStage.psp_item_stock_uom_uuid ?? "") ?? "?"
            : null;
          // Consumption per 1 output-unit of the downstream stage.
          // Same math the BE push cascade uses at line 6420.
          const consumedPerNextUnit =
            nextSpou !== null && spou > 0 ? nextSpou / spou : null;

          const isFinished = stage.psp_item_type === "finished_product";

          return (
            <li key={stage.id} className="list-none">
              <div
                className={
                  "flex flex-col gap-1 rounded-xl p-3 ring-1 " +
                  (isFinished
                    ? "bg-orange-50/60 ring-orange-200"
                    : "bg-ink-50 ring-ink-200")
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  {isFinished ? (
                    <Package className="size-4 shrink-0 text-orange-700" />
                  ) : (
                    <Layers className="size-4 shrink-0 text-ink-600" />
                  )}
                  <span className="text-sm font-semibold text-ink-1000">
                    {stage.name || `Stage ${index + 1}`}
                  </span>
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 " +
                      (isFinished
                        ? "bg-orange-100 text-orange-800 ring-orange-200"
                        : "bg-ink-100 text-ink-700 ring-ink-200")
                    }
                  >
                    {isFinished ? "Finished" : "Semi"}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-600">
                    SPOU {formatQty(spou)}
                  </span>
                </div>
                <p className="text-xs text-ink-700">
                  <PackageOpen className="mr-1 inline size-3 text-ink-500" />
                  Produces{" "}
                  <span className="font-mono font-semibold text-ink-1000">
                    {formatQty(outputPerPack)} {uomSymbol}
                  </span>{" "}
                  per pack{" "}
                  <span className="text-ink-500">
                    ({servingsPerPack} servings ÷ SPOU {formatQty(spou)})
                  </span>
                </p>
              </div>

              {!isTerminal && nextStage && consumedPerNextUnit !== null ? (
                <div className="my-1 flex items-center gap-2 pl-4 text-[11px] text-ink-600">
                  <ArrowDown className="size-3 shrink-0 text-emerald-600" />
                  <span>
                    <span className="font-mono font-semibold text-ink-1000">
                      {formatQty(consumedPerNextUnit)} {uomSymbol}
                    </span>{" "}
                    consumed per 1 {nextUomSymbol} of{" "}
                    <span className="font-medium text-ink-800">
                      {nextStage.name || `Stage ${index + 2}`}
                    </span>{" "}
                    <span className="text-ink-500">
                      (next.SPOU {formatQty(nextSpou ?? 0)} ÷ this.SPOU{" "}
                      {formatQty(spou)})
                    </span>
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}


/** Parse the string SPOU from ``FormulationStageDto`` into a positive
 *  float. Falls back to ``fallback`` for non-finite / non-positive
 *  values so the divisor never blows up the layout. */
function safePositiveFloat(raw: string | null | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}


/** Trim trailing zeros so ``0.3600`` reads ``0.36`` and ``1.0000``
 *  reads ``1``. Caps at 4 decimals — anything finer doesn't move the
 *  physical qty meaningfully at pharma precision. */
function formatQty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, "") || "0";
}
