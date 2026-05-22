/**
 * REST wrappers + types for the R&D kanban board.
 *
 * Mirrors :module:`@/services/proposals/pipeline` structurally: same
 * bundled-board read, same per-column cursor pagination, same
 * scope-with-capability-hint contract. The two boards stay in
 * lock-step so the FE primitives (cards, columns, load-more
 * affordances) can be lifted between them if we factor a shared
 * "kanban board" component later.
 */

import { apiClient } from "@/lib/api";


/** Funnel stages in board order. Strings match the backend's
 *  ``STAGE_*`` constants; the FE never reasons about them as enums
 *  beyond translating each into a column label. */
export const RD_PIPELINE_STAGES = [
  "builder",
  "spec_drafting",
  "spec_approved",
  "proposal",
  "closed",
] as const;

export type RDPipelineStage = (typeof RD_PIPELINE_STAGES)[number];


/** One card on the R&D kanban. Wire shape mirrors
 *  ``apps.formulations.api.rd_pipeline_views._card_payload`` 1:1. */
export interface RDPipelineCardDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** Machine string — one of ``DosageForm`` values (capsule, tablet,
   *  powder, gummy, liquid). FE translates for display. */
  readonly dosage_form: string;
  /** Machine string — one of ``ProjectStatus`` values. Rendered as
   *  a small chip on the card so the manual lifecycle status is
   *  visible alongside the derived stage. */
  readonly project_status: string;
  readonly lead_scientist_id: string | null;
  readonly lead_scientist_name: string;
  readonly updated_at: string;
}


export interface RDPipelineColumnDto {
  readonly stage: RDPipelineStage;
  readonly total: number;
  readonly cards: readonly RDPipelineCardDto[];
  /** Opaque cursor — echo back verbatim to fetch the next page. */
  readonly next_cursor: string | null;
}


export type RDPipelineScope = "mine" | "all";


export interface RDPipelineBoardDto {
  readonly scope: RDPipelineScope;
  /** Capability hint so the FE can hide the "All" toggle on callers
   *  that don't hold ``formulations.view_all_rd_pipeline``. */
  readonly scope_capabilities: {
    readonly can_view_all: boolean;
  };
  readonly columns: readonly RDPipelineColumnDto[];
}


export interface RDPipelineColumnPageDto {
  readonly stage: RDPipelineStage;
  readonly total: number;
  readonly cards: readonly RDPipelineCardDto[];
  readonly next_cursor: string | null;
}


function _qs(params: Record<string, string | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") out.set(k, v);
  }
  const q = out.toString();
  return q ? `?${q}` : "";
}


/** Fetch the bundled board: every column with its first page. */
export async function fetchRDPipelineBoard(
  orgId: string,
  scope: RDPipelineScope = "mine",
): Promise<RDPipelineBoardDto> {
  const { data } = await apiClient.get<RDPipelineBoardDto>(
    `/api/organizations/${orgId}/formulations/rd-pipeline/${_qs({ scope })}`,
  );
  return data;
}


/** Fetch the next page of one column — used by the per-column
 *  "Load more" affordance. */
export async function fetchRDPipelineColumnPage(
  orgId: string,
  stage: RDPipelineStage,
  options: { scope?: RDPipelineScope; cursor?: string | null } = {},
): Promise<RDPipelineColumnPageDto> {
  const { scope = "mine", cursor = null } = options;
  const { data } = await apiClient.get<RDPipelineColumnPageDto>(
    `/api/organizations/${orgId}/formulations/rd-pipeline/${stage}/${_qs({ scope, cursor })}`,
  );
  return data;
}
