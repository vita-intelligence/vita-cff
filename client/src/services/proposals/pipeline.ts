/**
 * REST wrappers + types for the CRM-style proposals pipeline board.
 *
 * The pipeline endpoints live alongside :module:`./api` but are
 * shaped enough differently (per-column cursor pagination, bundled
 * board payload, opaque cursor strings) that lumping them in with
 * the existing cursor-paginated list helpers would be noise. Kept
 * in their own module so the import surface ``import { ... } from
 * "@/services/proposals/pipeline"`` stays focused.
 */

import { apiClient } from "@/lib/api";


/** One card on the kanban board. Wire shape mirrors
 *  ``apps.proposals.api.pipeline_views._card_payload`` 1:1.
 *
 *  Money fields are strings on the wire (``Decimal`` doesn't survive
 *  JSON without precision loss); the FE renders them via
 *  ``Intl.NumberFormat`` so they format per locale. */
export interface PipelineCardDto {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly status: string;
  readonly customer_name: string;
  readonly customer_company: string;
  readonly sales_person_id: string | null;
  readonly sales_person_name: string;
  /** ISO ``YYYY-MM-DD`` — proposal expiry. Sales surfaces this so
   *  reps can chase deals before they lapse. */
  readonly valid_until: string | null;
  readonly updated_at: string;
  readonly currency: string;
  readonly quantity: number;
  readonly unit_price: string | null;
  readonly freight_amount: string | null;
  /** ``quantity * unit_price + freight``. ``null`` when the proposal
   *  hasn't been priced. The proposal detail page renders the
   *  precise number (which can include per-line totals); this is the
   *  kanban headline. */
  readonly deal_total: string | null;
}


export interface PipelineColumnDto {
  /** Machine string — one of ``ProposalStatus.values``. */
  readonly status: string;
  /** Localised human label as the backend resolved it. The FE can
   *  override via its own i18n if the customer-facing copy diverges
   *  from the staff-facing copy. */
  readonly label: string;
  readonly total: number;
  /** Sum of ``deal_total`` across EVERY row in the column (not just
   *  loaded cards). ``null`` on empty columns or all-unpriced rows. */
  readonly total_value: string | null;
  /** Dominant currency code (e.g. ``"GBP"``). Empty on empty
   *  columns. */
  readonly currency: string;
  /** ``true`` when the column has more than one currency code —
   *  the FE renders a "*" badge so the operator knows the headline
   *  total is an approximation. */
  readonly mixed_currency: boolean;
  readonly cards: readonly PipelineCardDto[];
  /** Opaque cursor — echo back verbatim to fetch the next page. */
  readonly next_cursor: string | null;
}


export type PipelineScope = "mine" | "all";


export interface PipelineBoardDto {
  readonly scope: PipelineScope;
  /** Capability hints so the FE can hide UI it cannot use. Sent on
   *  the same payload so the page doesn't make a second round-trip
   *  just to ask "may I see the toggle". */
  readonly scope_capabilities: {
    readonly can_view_all: boolean;
  };
  readonly columns: readonly PipelineColumnDto[];
}


export interface PipelineColumnPageDto {
  readonly status: string;
  readonly total: number;
  readonly total_value: string | null;
  readonly currency: string;
  readonly mixed_currency: boolean;
  readonly cards: readonly PipelineCardDto[];
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
export async function fetchPipelineBoard(
  orgId: string,
  scope: PipelineScope = "mine",
): Promise<PipelineBoardDto> {
  const { data } = await apiClient.get<PipelineBoardDto>(
    `/api/organizations/${orgId}/proposals/pipeline/${_qs({ scope })}`,
  );
  return data;
}


/** Fetch the next page of one column — used by the per-column
 *  "Load more" affordance. */
export async function fetchPipelineColumnPage(
  orgId: string,
  columnStatus: string,
  options: { scope?: PipelineScope; cursor?: string | null } = {},
): Promise<PipelineColumnPageDto> {
  const { scope = "mine", cursor = null } = options;
  const { data } = await apiClient.get<PipelineColumnPageDto>(
    `/api/organizations/${orgId}/proposals/pipeline/${columnStatus}/${_qs({ scope, cursor })}`,
  );
  return data;
}
