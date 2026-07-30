"use client";

/**
 * Client wrapper for the builder page. Holds the live-lines state
 * that FormulationBuilder emits via ``onLinesChange`` and forwards
 * it to the sibling ``CostCalculator`` so unsaved builder edits
 * reflect in the sticky cost pill without any network round-trip.
 *
 * Kept as a thin shell — everything about the builder itself lives
 * in FormulationBuilder; the calculator lives in CostCalculator;
 * this file just wires the two together via a shared line list.
 */

import { useCallback, useMemo, useState } from "react";

import { FormulationBuilder } from "../formulation-builder";
import type { FormulationDto } from "@/services/formulations";
import {
  CostCalculator,
  type CostCalculatorLine,
} from "../cost-calculator";


//: Narrow projection of BuilderLine — the fields the calculator
//: actually reads. Kept in this file rather than importing BuilderLine
//: itself because BuilderLine is a private type inside the huge
//: formulation-builder.tsx and the calculator only needs the six
//: fields below.
interface EmittedLine {
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly item_psp_source_uuid: string | null;
  readonly label_claim_mg: string;
  readonly source_kind: "active" | "band_pick" | "manual";
  readonly band_key: string | null;
}


export function BuilderShell({
  orgId,
  formulation,
  canWrite,
  hasTrialBatches,
}: {
  readonly orgId: string;
  readonly formulation: FormulationDto;
  readonly canWrite: boolean;
  readonly hasTrialBatches: boolean;
}) {
  const [liveLines, setLiveLines] = useState<readonly CostCalculatorLine[]>(
    [],
  );

  //: PSP uuids that *this* project produces itself — the finished
  //: product plus every non-terminal stage's semi-finished output.
  //: Lines pointing at any of these are already priced inside their
  //: own stage BOM, so counting them again on the finished total
  //: would double-book. Passed to CostCalculator, which flags the
  //: matching rows as ``own_project_stage`` and zeros their cost.
  const ownProjectPspUuids = useMemo(() => {
    const set = new Set<string>();
    if (formulation.psp_finished_product_uuid) {
      set.add(formulation.psp_finished_product_uuid);
    }
    for (const stage of formulation.stages) {
      if (stage.psp_semi_finished_uuid) {
        set.add(stage.psp_semi_finished_uuid);
      }
    }
    return set;
  }, [formulation.psp_finished_product_uuid, formulation.stages]);

  // Stable identity — without ``useCallback``, the FormulationBuilder
  // effect that depends on this handler would re-run on every render,
  // setLiveLines would push a new array, forcing another render, and
  // the two would ping-pong until React tripped the max-update-depth
  // guard. The handler has no dependencies (we only push into
  // ``setLiveLines``, which is itself stable), so the empty deps
  // array is safe and correct.
  const handleLinesChange = useCallback(
    (lines: readonly unknown[]) => {
      const projected: CostCalculatorLine[] = (
        lines as readonly EmittedLine[]
      ).map((line) => ({
        key: line.key,
        item_id: line.item_id,
        item_name: line.item_name,
        item_internal_code: line.item_internal_code,
        item_psp_source_uuid: line.item_psp_source_uuid,
        label_claim_mg: line.label_claim_mg,
        source_kind: line.source_kind,
        band_key: line.band_key,
      }));
      setLiveLines(projected);
    },
    [],
  );

  return (
    <>
      <FormulationBuilder
        orgId={orgId}
        initialFormulation={formulation}
        canWrite={canWrite}
        hasTrialBatches={hasTrialBatches}
        onLinesChange={handleLinesChange}
      />

      <CostCalculator
        orgId={orgId}
        formulationId={formulation.id}
        lines={liveLines}
        servingsPerPack={formulation.servings_per_pack ?? 1}
        ownProjectPspUuids={ownProjectPspUuids}
      />
    </>
  );
}
