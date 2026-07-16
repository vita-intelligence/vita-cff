/**
 * Stage BOMs preview — the "here's what's about to land on PSP"
 * card that replaces the legacy MRPeasy BOM block at the bottom of
 * the formulation builder.
 *
 * Renders one collapsible section per stage. Each section shows
 * exactly what NPD's push cascade (``push_bom_to_psp`` on the
 * server) will send to PSP on the next ``save_version``:
 *
 * * A header row with the stage's routing target — workstation
 *   group + operation description + setup / cycle time + costs.
 * * The BOM's own line list — ingredients assigned to this stage
 *   (via :attr:`FormulationLine.stage_id`) plus, on non-first
 *   stages, the auto-injected ``Prior stage semi-finished (qty=1)``
 *   line the cascade prepends.
 * * On the terminal stage, any ``stage_id=null`` lines are folded
 *   in the same way the server-side push does.
 *
 * Print scope: browser-print at page break per stage so a scientist
 * can hand each stage's BOM sheet to the shop-floor lead. Prints
 * only the preview card via a scoped ``bom-preview-print-*``
 * class family, so triggering a print doesn't drag the whole
 * builder onto paper.
 */

"use client";

import { Printer } from "lucide-react";
import { useMemo } from "react";

import type {
  FormulationStageDto,
  StageKey,
} from "@/services/formulations/types";


export interface StageBomsPreviewLine {
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly label_claim_mg: string;
  readonly stage_id: string | null;
}


export interface StageBomsPreviewProps {
  readonly formulationCode: string;
  readonly formulationName: string;
  readonly stages: readonly FormulationStageDto[];
  readonly lines: readonly StageBomsPreviewLine[];
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


interface StageBom {
  readonly stage: FormulationStageDto;
  readonly index: number;
  readonly isTerminal: boolean;
  /** Ingredient lines assigned to this stage. */
  readonly ownLines: readonly StageBomsPreviewLine[];
  /** Terminal stage picks up unassigned (``stage_id === null``) rows too. */
  readonly nullStageLines: readonly StageBomsPreviewLine[];
  /** Prior stage's name — only present when the cascade prepends
   *  the "Prior stage semi-finished" auto-line. */
  readonly priorSemiName: string | null;
}


function buildStageBoms(
  stages: readonly FormulationStageDto[],
  lines: readonly StageBomsPreviewLine[],
): StageBom[] {
  if (stages.length === 0) return [];
  const ordered = [...stages].sort((a, b) => a.sort_order - b.sort_order);
  const nullStageLines = lines.filter((l) => l.stage_id === null);
  return ordered.map((stage, index) => {
    const isTerminal = index === ordered.length - 1;
    const ownLines = lines.filter((l) => l.stage_id === stage.id);
    const prior = index > 0 ? ordered[index - 1] : null;
    return {
      stage,
      index,
      isTerminal,
      ownLines,
      nullStageLines: isTerminal ? nullStageLines : [],
      priorSemiName: prior?.name ?? null,
    };
  });
}


function printOnly(stageId: string) {
  if (typeof document === "undefined") return;
  // Toggle a body-level class scoped to this stage so the print
  // stylesheet can hide every other stage + everything outside the
  // preview card. Cleared on afterprint so the UI restores.
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
  lines,
}: StageBomsPreviewProps) {
  const stageBoms = useMemo(
    () => buildStageBoms(stages, lines),
    [stages, lines],
  );

  if (stageBoms.length === 0) {
    return (
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          Stage BOMs preview
        </p>
        <p className="mt-3 text-sm text-ink-700">
          No production stages defined yet — the push cascade will
          fall back to a single flat BOM against the linked finished
          product. Add stages on the Production stages card above to
          model the per-stage BOM + routing that PSP receives.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      {/* Scoped print styles: on ``bom-preview-print-active`` we hide
          everything, then re-show only the target stage card. */}
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
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          Stage graph preview
        </p>
        <p className="text-sm text-ink-700">
          Multi-stage routing snapshot — one BOM + routing per stage
          lands on PSP on the next save. Non-terminal stages spawn a
          semi-finished item that the next stage consumes at
          qty&nbsp;1. Ingredient weights here are label claims;
          the authoritative per-1kg breakdown (with excipient bands
          + extract-ratio adjustments) is on the Bill of Materials
          card above.
        </p>
      </header>

      <ol className="bom-preview-card mt-4 flex flex-col gap-3">
        {stageBoms.map((bom) => {
          const stage = bom.stage;
          const label = STAGE_KEY_LABELS[stage.stage_key] ?? "Custom";
          const workstation =
            stage.workstation_group_name || "(no workstation picked)";
          const combinedLines = [...bom.ownLines, ...bom.nullStageLines];
          return (
            <li
              key={stage.id}
              data-stage-id={stage.id}
              data-print-target="true"
              className="rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200"
              // The print stylesheet targets the currently-active
              // print target only. This class stays on the outer
              // <li> at all times; the ``bom-preview-print-only-*``
              // body class narrows the visible one at print time.
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                    Stage {bom.index + 1} · {label}
                    {bom.isTerminal ? " · terminal" : ""}
                  </p>
                  <h4 className="mt-0.5 text-base font-semibold text-ink-1000">
                    {stage.name}
                  </h4>
                  <p className="mt-1 text-xs text-ink-700">
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
                    {stage.capacity ? (
                      <>
                        {" · "}
                        <span className="font-medium">Capacity:</span>{" "}
                        {stage.capacity}
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
                  Bill of materials —{" "}
                  {formulationCode} · {formulationName}
                </p>
                <table className="mt-2 w-full text-sm">
                  <thead>
                    <tr className="border-b border-ink-100 text-left text-[11px] uppercase tracking-wide text-ink-500">
                      <th className="py-1.5 pr-2 font-medium">Part</th>
                      <th className="py-1.5 pr-2 font-medium">Code</th>
                      <th className="py-1.5 text-right font-medium">Qty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {bom.index > 0 && bom.priorSemiName ? (
                      <tr className="bg-orange-50/50">
                        <td className="py-2 pr-2 text-ink-900">
                          {bom.priorSemiName}
                          <span className="ml-2 text-[11px] italic text-orange-700">
                            (auto — prior stage semi)
                          </span>
                        </td>
                        <td className="py-2 pr-2 text-xs text-ink-500">
                          semi-finished
                        </td>
                        <td className="py-2 text-right tabular-nums text-ink-900">
                          1
                        </td>
                      </tr>
                    ) : null}
                    {combinedLines.length === 0 &&
                    !(bom.index > 0 && bom.priorSemiName) ? (
                      <tr>
                        <td
                          colSpan={3}
                          className="py-3 text-center text-xs text-ink-500"
                        >
                          No ingredients assigned yet.
                        </td>
                      </tr>
                    ) : (
                      combinedLines.map((line) => {
                        const isNullStage =
                          bom.isTerminal &&
                          bom.nullStageLines.some(
                            (n) => n.key === line.key,
                          );
                        return (
                          <tr key={line.key}>
                            <td className="py-2 pr-2 text-ink-900">
                              {line.item_name}
                              {isNullStage ? (
                                <span className="ml-2 text-[11px] italic text-ink-500">
                                  (unassigned — folds in on push)
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 pr-2 text-xs text-ink-500">
                              {line.item_internal_code || "—"}
                            </td>
                            <td className="py-2 text-right tabular-nums text-ink-900">
                              {line.label_claim_mg || "0"} mg
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                {stage.psp_semi_finished_uuid ? (
                  <p className="mt-2 text-[11px] text-ink-500">
                    PSP semi-finished item:{" "}
                    <span className="font-mono">
                      {stage.psp_semi_finished_uuid.slice(0, 8)}…
                    </span>{" "}
                    · already exists on PSP; the next push updates
                    its BOM + Routing rather than creating a new
                    item.
                  </p>
                ) : bom.isTerminal ? (
                  <p className="mt-2 text-[11px] text-ink-500">
                    Terminal stage — pushes to the linked
                    finished-product item.
                  </p>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-500">
                    First push will create the PSP semi-finished
                    item (external_sku ={" "}
                    <span className="font-mono">
                      NPD-STAGE-…-{stage.sort_order}
                    </span>
                    ).
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
