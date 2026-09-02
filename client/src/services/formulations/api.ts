/**
 * Raw Axios calls for the formulations domain.
 */

import { apiClient } from "@/lib/api";

import { formulationsEndpoints } from "./endpoints";
import type {
  AssignLeadScientistRequestDto,
  AssignSalesPersonRequestDto,
  CFFCandidatesResponseDto,
  ItemPricesResponseDto,
  CloneFormulationRequestDto,
  CreateFormulationRequestDto,
  FormulationDto,
  FormulationTotalsDto,
  FormulationVersionDto,
  FormulationsListQuery,
  PaginatedFormulationsDto,
  ProjectOverviewDto,
  ReplaceLinesRequestDto,
  RollbackRequestDto,
  RoutingCostsResponseDto,
  SaveVersionRequestDto,
  UpdateFormulationRequestDto,
  UpsertStagesRequestDto,
} from "./types";

export interface FetchFormulationsPageArgs extends FormulationsListQuery {
  /** Full ``next``/``previous`` URL from a prior cursor response. */
  readonly cursorUrl?: string | null;
}

export async function fetchFormulationsPage(
  orgId: string,
  args: FetchFormulationsPageArgs = {},
): Promise<PaginatedFormulationsDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedFormulationsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }

  // Axios serialises array values as ``key=v1&key=v2&...`` by
  // default, which matches what DRF's ``request.query_params.getlist``
  // expects on the backend. Other scalars go through unchanged.
  const params: Record<string, string | readonly string[]> = {};
  if (args.ordering) params.ordering = args.ordering;
  if (args.pageSize) params.page_size = String(args.pageSize);
  if (args.search && args.search.trim()) params.search = args.search.trim();
  // ``has_open_proposal`` is a tri-state — leaving the param off means
  // "don't filter on it", explicitly sending ``true`` / ``false``
  // narrows the list. Serialise booleans as ``"true"`` / ``"false"``
  // for Django's ``BooleanField`` query lookup.
  if (typeof args.hasOpenProposal === "boolean") {
    params.has_open_proposal = args.hasOpenProposal ? "true" : "false";
  }
  if (args.statuses && args.statuses.length > 0) {
    // Repeated ``?status=a&status=b`` keys.
    params.status = args.statuses;
  }
  if (args.salesPersonId) params.sales_person_id = args.salesPersonId;
  if (args.projectType) params.project_type = args.projectType;
  if (args.includePublishedRtg) params.include_published_rtg = "true";
  if (typeof args.isRtgPublished === "boolean") {
    params.is_rtg_published = args.isRtgPublished ? "true" : "false";
  }
  const { data } = await apiClient.get<PaginatedFormulationsDto>(
    formulationsEndpoints.list(orgId),
    { params },
  );
  return data;
}

export interface PackagingComboItemDto {
  readonly id: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_code: string;
  readonly quantity: number;
  readonly sort_order: number;
}


export interface PackagingComboDto {
  readonly id: string;
  readonly name: string;
  readonly price_delta: string;
  readonly sort_order: number;
  readonly is_default: boolean;
  /** Stage that will assemble this combo's packaging on the
   *  customer's PO. ``null`` until the scientist wires it up on the
   *  Routing tab; RTG Builder readiness refuses to advance while any
   *  combo is still unassigned. */
  readonly stage_id: string | null;
  readonly items: readonly PackagingComboItemDto[];
}


export interface PackagingCombosResponseDto {
  readonly items: readonly PackagingComboDto[];
}


export interface PackagingComboInput {
  readonly name: string;
  readonly price_delta: string;
  readonly is_default: boolean;
  /** Optional stage assignment. Server validates the ID belongs to
   *  this formulation. Send ``null`` (or omit) to leave the combo
   *  unassigned — RTG Builder gate will flag it. */
  readonly stage_id?: string | null;
  readonly items: ReadonlyArray<{
    readonly item_id: string;
    readonly quantity: number;
  }>;
}


export async function fetchPackagingCombos(
  orgId: string,
  formulationId: string,
): Promise<PackagingCombosResponseDto> {
  const { data } = await apiClient.get<PackagingCombosResponseDto>(
    `/api/organizations/${orgId}/formulations/${formulationId}/packaging-combos/`,
  );
  return data;
}


export async function replacePackagingCombos(
  orgId: string,
  formulationId: string,
  combos: ReadonlyArray<PackagingComboInput>,
): Promise<PackagingCombosResponseDto> {
  const { data } = await apiClient.put<PackagingCombosResponseDto>(
    `/api/organizations/${orgId}/formulations/${formulationId}/packaging-combos/`,
    { combos },
  );
  return data;
}


export interface RtgCatalogCountsDto {
  readonly all: number;
  readonly published: number;
  readonly unpublished: number;
}

export async function fetchRtgCatalogCounts(
  orgId: string,
): Promise<RtgCatalogCountsDto> {
  const { data } = await apiClient.get<RtgCatalogCountsDto>(
    `/api/organizations/${orgId}/formulations/rtg-catalog-counts/`,
  );
  return data;
}


/**
 * One row on the staff RTG catalog grid. Trimmed to the card fields
 * the ``CatalogCard`` component actually renders — no recipe lines,
 * no allergen matrix, no M2M excipient echoes. The backend endpoint
 * ``rtg-catalog-list/`` ships exactly this shape via
 * :class:`RTGCatalogListSerializer`, so wire changes stay in lock-step.
 */
export interface RTGCatalogRowDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_rtg_published: boolean;
  readonly rtg_display_name: string;
  readonly rtg_short_description: string;
  readonly rtg_hero_image: string | null;
  readonly rtg_base_price: string | null;
  readonly rtg_moq: number | null;
  readonly rtg_currency_code: string;
  readonly rtg_packaging_options: readonly string[];
  readonly packaging_combos_count: number;
  readonly catalog_photos: readonly {
    readonly id: string;
    readonly url: string | null;
    readonly caption: string;
    readonly is_primary: boolean;
    readonly sort_order: number;
  }[];
  readonly updated_at: string;
}


export interface PaginatedRTGCatalogDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly RTGCatalogRowDto[];
}


export interface FetchRTGCatalogPageArgs {
  readonly pageSize?: number;
  readonly search?: string;
  readonly isRtgPublished?: boolean;
  /** Full ``next``/``previous`` URL from a prior cursor response. */
  readonly cursorUrl?: string | null;
}


/**
 * Fetch one page of the staff RTG catalog grid.
 *
 * Points at the dedicated ``rtg-catalog-list/`` endpoint whose
 * queryset skips the 13 M2M prefetches + the 4 per-row derived checks
 * that the general formulation list serializer emits — so the catalog
 * scales cleanly into the millions of SKUs without dragging the
 * general list endpoint down.
 */
export async function fetchRTGCatalogPage(
  orgId: string,
  args: FetchRTGCatalogPageArgs = {},
): Promise<PaginatedRTGCatalogDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedRTGCatalogDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }

  const params: Record<string, string> = {};
  if (args.pageSize) params.page_size = String(args.pageSize);
  if (args.search && args.search.trim()) params.search = args.search.trim();
  if (typeof args.isRtgPublished === "boolean") {
    params.is_rtg_published = args.isRtgPublished ? "true" : "false";
  }
  const { data } = await apiClient.get<PaginatedRTGCatalogDto>(
    `/api/organizations/${orgId}/formulations/rtg-catalog-list/`,
    { params },
  );
  return data;
}


/**
 * @deprecated Use :func:`fetchFormulationsPage` — the list endpoint
 * is paginated and this helper just flattens the first page.
 */
export async function fetchFormulations(
  orgId: string,
): Promise<FormulationDto[]> {
  const page = await fetchFormulationsPage(orgId);
  return [...page.results];
}

export async function fetchFormulation(
  orgId: string,
  formulationId: string,
): Promise<FormulationDto> {
  const { data } = await apiClient.get<FormulationDto>(
    formulationsEndpoints.detail(orgId, formulationId),
  );
  return data;
}

export async function createFormulation(
  orgId: string,
  payload: CreateFormulationRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateFormulation(
  orgId: string,
  formulationId: string,
  payload: UpdateFormulationRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.patch<FormulationDto>(
    formulationsEndpoints.detail(orgId, formulationId),
    payload,
  );
  return data;
}

export async function deleteFormulation(
  orgId: string,
  formulationId: string,
): Promise<void> {
  await apiClient.delete(formulationsEndpoints.detail(orgId, formulationId));
}

export async function replaceFormulationLines(
  orgId: string,
  formulationId: string,
  payload: ReplaceLinesRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.put<FormulationDto>(
    formulationsEndpoints.lines(orgId, formulationId),
    payload,
  );
  return data;
}

export async function computeFormulationTotals(
  orgId: string,
  formulationId: string,
): Promise<FormulationTotalsDto> {
  const { data } = await apiClient.get<FormulationTotalsDto>(
    formulationsEndpoints.compute(orgId, formulationId),
  );
  return data;
}

export async function fetchFormulationVersions(
  orgId: string,
  formulationId: string,
): Promise<FormulationVersionDto[]> {
  const { data } = await apiClient.get<FormulationVersionDto[]>(
    formulationsEndpoints.versions(orgId, formulationId),
  );
  return data;
}

export async function saveFormulationVersion(
  orgId: string,
  formulationId: string,
  payload: SaveVersionRequestDto,
): Promise<FormulationVersionDto> {
  const { data } = await apiClient.post<FormulationVersionDto>(
    formulationsEndpoints.versions(orgId, formulationId),
    payload,
  );
  return data;
}

/** POST /sync-psp — push the current in-memory BOM cascade to PSP
 *  without cutting a version. Returns whether the sync fired and, if
 *  so, the finished-product uuid (either the pre-existing one or the
 *  one ``_ensure_finished_product`` just auto-created). */
export interface PullPspBomSummaryDto {
  readonly lines_pulled: number;
  readonly items_mirrored: number;
  readonly items_reused: number;
  readonly unconvertible_uom_lines: readonly string[];
  readonly pre_pull_version_number: number | null;
}

export interface PullPspBomResponseDto {
  readonly summary: PullPspBomSummaryDto;
  readonly formulation: FormulationDto;
}

export async function pullPspBomIntoFormulation(
  orgId: string,
  formulationId: string,
): Promise<PullPspBomResponseDto> {
  const { data } = await apiClient.post<PullPspBomResponseDto>(
    formulationsEndpoints.pullPspBom(orgId, formulationId),
  );
  return data;
}

export interface SyncPspResponseDto {
  synced: boolean;
  finished_product_uuid?: string | null;
  reason?: string;
  /** Populated on ``502`` returns when the BOM push bubbled an
   *  unexpected exception — surface verbatim so the operator has
   *  something actionable instead of a generic "sync failed" toast. */
  detail?: string;
}

/** Per-stage snapshot of the compute-derived BOM the FE displays.
 *  Sent to sync-psp so PSP's per-stage BOMs mirror what NPD shows —
 *  otherwise the FE synthesizes excipient rows that never reach PSP
 *  and the two surfaces drift. Keyed by stage uuid. ``item_id`` is
 *  the local ``catalogues.Item.id``; the server resolves it to the
 *  PSP source uuid via the item mirror. */
export interface SyncPspStageBomLineDto {
  /** Local ``catalogues.Item.id``. Server resolves to
   *  ``psp_source_uuid`` via the item mirror. ``null`` when the row
   *  is auto-picked from PSP (no mirror row yet) — in that case
   *  ``psp_item_uuid`` carries the direct PSP identity. */
  readonly item_id: string | null;
  /** Raw PSP item UUID for auto-picked rows (e.g. capsule shell
   *  when nothing was ticked explicitly). Server prefers
   *  ``item_id`` when present; falls back to this uuid otherwise. */
  readonly psp_item_uuid?: string | null;
  readonly mg: number;
  readonly sort_order: number;
}
export type SyncPspStageBomsDto = Readonly<
  Record<string, readonly SyncPspStageBomLineDto[]>
>;

export async function syncFormulationToPsp(
  orgId: string,
  formulationId: string,
  args: { stageBoms?: SyncPspStageBomsDto } = {},
): Promise<SyncPspResponseDto> {
  const { data } = await apiClient.post<SyncPspResponseDto>(
    formulationsEndpoints.syncPsp(orgId, formulationId),
    args.stageBoms ? { stage_boms: args.stageBoms } : {},
  );
  return data;
}


/** Body for POST /formulations/:id/wizard-routing/. Persists the
 *  wizard's per-ingredient stage assignments (both operator-picked
 *  actives and compute-derived band picks). Materialises band picks
 *  as ``FormulationLine`` rows so the PSP push cascade reads each
 *  stage's real BOM from the ORM without a separate override. */
export interface WizardRoutingBandAssignmentDto {
  readonly item_id: string;
  readonly band_key: string;
  readonly mg: number;
  readonly stage_id: string | null;
  /** Explicit "unassign this band" signal. Without it, a payload row
   *  with ``stage_id: null`` is treated as "no routing intent for
   *  this band — keep whatever the DB already has". Prevents the
   *  save chain from wiping baseline stage assignments the FE
   *  re-affirmed for compute reasons. */
  readonly unassign?: boolean;
}
export interface WizardRoutingRequestDto {
  readonly line_assignments?: Readonly<Record<string, string | null>>;
  readonly band_assignments?: readonly WizardRoutingBandAssignmentDto[];
}
export async function saveWizardRouting(
  orgId: string,
  formulationId: string,
  payload: WizardRoutingRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.wizardRouting(orgId, formulationId),
    payload,
  );
  return data;
}

export async function rollbackFormulation(
  orgId: string,
  formulationId: string,
  payload: RollbackRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.rollback(orgId, formulationId),
    payload,
  );
  return data;
}

/** Mark one version as the current approved recipe, or pass
 *  ``version_number: null`` to clear the pointer. Requires the
 *  ``formulations.approve`` capability server-side. */
export async function setApprovedVersion(
  orgId: string,
  formulationId: string,
  versionNumber: number | null,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.approvedVersion(orgId, formulationId),
    { version_number: versionNumber },
  );
  return data;
}

export async function fetchProjectOverview(
  orgId: string,
  formulationId: string,
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.get<ProjectOverviewDto>(
    formulationsEndpoints.overview(orgId, formulationId),
  );
  return data;
}

export async function fetchCFFCandidates(
  orgId: string,
  formulationId: string,
  args: { search?: string; cursor?: string } = {},
): Promise<CFFCandidatesResponseDto> {
  const { data } = await apiClient.get<CFFCandidatesResponseDto>(
    formulationsEndpoints.cffCandidates(orgId, formulationId, args),
  );
  return data;
}

export async function linkCFFToProject(
  orgId: string,
  formulationId: string,
  cffSubmissionId: string,
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.post<ProjectOverviewDto>(
    formulationsEndpoints.linkCff(orgId, formulationId),
    { cff_submission_id: cffSubmissionId },
  );
  return data;
}

export async function fetchItemPrices(
  orgId: string,
  formulationId: string,
  itemUuids: readonly string[],
): Promise<ItemPricesResponseDto> {
  const { data } = await apiClient.post<ItemPricesResponseDto>(
    formulationsEndpoints.itemPrices(orgId, formulationId),
    { item_uuids: itemUuids },
  );
  return data;
}

export async function fetchRoutingCosts(
  orgId: string,
  formulationId: string,
  workstationGroupUuids: readonly string[],
): Promise<RoutingCostsResponseDto> {
  const { data } = await apiClient.post<RoutingCostsResponseDto>(
    formulationsEndpoints.routingCosts(orgId, formulationId),
    { workstation_group_uuids: workstationGroupUuids },
  );
  return data;
}

export async function unlinkCFFFromProject(
  orgId: string,
  formulationId: string,
  cffSubmissionId: string,
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.delete<ProjectOverviewDto>(
    formulationsEndpoints.linkCff(orgId, formulationId),
    {
      data: { cff_submission_id: cffSubmissionId },
    },
  );
  return data;
}


/** Attach a customer to this project (one customer per project —
 *  posting with a customer already set overwrites in place). Fires
 *  a PSP sync in the background so the kanban card + project detail
 *  page swap the "NPD Placeholder" for the real customer name. */
export async function linkCustomerToProject(
  orgId: string,
  formulationId: string,
  customerId: string,
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.post<ProjectOverviewDto>(
    formulationsEndpoints.linkCustomer(orgId, formulationId),
    { customer_id: customerId },
  );
  return data;
}


/** Clear the project's linked customer. No-op when nothing is
 *  currently linked. Fires the same PSP sync as ``link_customer``
 *  so downstream state (project title, R&D team card) reverts. */
export async function unlinkCustomerFromProject(
  orgId: string,
  formulationId: string,
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.delete<ProjectOverviewDto>(
    formulationsEndpoints.linkCustomer(orgId, formulationId),
  );
  return data;
}


/**
 * Explicitly create the FINAL spec for this project, citing the
 * given passed trial batch + formulation version as the evidentiary
 * pair. Called from the "Final spec is available for creation"
 * banner modal on the project workspace.
 *
 * Returns the fresh overview so the caller can drop the banner and
 * re-render spec counts atomically.
 */
export async function createFinalSpecFromTrial(
  orgId: string,
  formulationId: string,
  args: {
    trialBatchId: string;
    formulationVersionId: string;
    /** Optional overrides fed in by the banner modal. Empty / undefined
     *  → backend falls back to source-draft copy or dosage-form
     *  default. Quantity is the load-bearing one — locks the run size
     *  the customer signs against on the FINAL. */
    code?: string;
    quantity?: number;
    coverNotes?: string;
  },
): Promise<ProjectOverviewDto> {
  const { data } = await apiClient.post<ProjectOverviewDto>(
    formulationsEndpoints.createFinalSpec(orgId, formulationId),
    {
      trial_batch_id: args.trialBatchId,
      formulation_version_id: args.formulationVersionId,
      ...(args.code !== undefined ? { code: args.code } : {}),
      ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
      ...(args.coverNotes !== undefined
        ? { cover_notes: args.coverNotes }
        : {}),
    },
  );
  return data;
}

/**
 * Set or clear the project's commercial owner.
 *
 * ``user_id: null`` clears the assignment. The backend validates
 * that the target user is a member of the same organization and
 * returns a 400 with ``sales_person_not_member`` otherwise.
 */
export async function assignFormulationSalesPerson(
  orgId: string,
  formulationId: string,
  payload: AssignSalesPersonRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.put<FormulationDto>(
    formulationsEndpoints.salesPerson(orgId, formulationId),
    payload,
  );
  return data;
}


/**
 * Set or clear the project's R&D lead.
 *
 * ``user_id: null`` clears the assignment. The backend validates
 * that the target user is a member of the same organization and
 * returns a 400 with ``lead_scientist_not_member`` otherwise.
 */
export async function assignFormulationLeadScientist(
  orgId: string,
  formulationId: string,
  payload: AssignLeadScientistRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.put<FormulationDto>(
    formulationsEndpoints.leadScientist(orgId, formulationId),
    payload,
  );
  return data;
}

/**
 * Duplicate a formulation's recipe into either a brand-new project
 * ("new" mode) or an existing project ("replace" mode). The backend
 * snapshots the target into a new version before any overwrite so
 * "replace" stays reversible from the version drawer.
 */
export async function cloneFormulation(
  orgId: string,
  sourceFormulationId: string,
  payload: CloneFormulationRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.clone(orgId, sourceFormulationId),
    payload,
  );
  return data;
}


/**
 * Wholesale-replace the formulation's production-stage graph. The
 * backend upserts every stage in the payload (create when ``id``
 * omitted, update when present) and deletes stages that fell out.
 * Lines FK'd to a departing stage fall back to ``stage=NULL`` via
 * ``SET_NULL`` — the FE renders them in a "no stage" bucket for
 * the operator to reassign. Returns the fresh formulation DTO so
 * the builder can re-hydrate stages + lines from one response.
 */
export async function upsertFormulationStages(
  orgId: string,
  formulationId: string,
  payload: UpsertStagesRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.put<FormulationDto>(
    formulationsEndpoints.stages(orgId, formulationId),
    payload,
  );
  return data;
}


// ---- Stage templates ----------------------------------------------

export interface StageTemplateStageDto {
  readonly sort_order?: number;
  readonly name?: string;
  readonly stage_key?: string;
  readonly psp_item_type?: "semi_finished" | "finished_product";
  readonly workstation_group_uuid?: string | null;
  readonly workstation_group_name?: string;
  readonly operation_description?: string;
  readonly setup_time_min?: string | null;
  readonly cycle_time_min?: string | null;
  readonly fixed_cost?: string | null;
  readonly variable_cost?: string | null;
  readonly capacity?: string | null;
  readonly other_fixed_cost?: string | null;
  readonly other_variable_cost?: string | null;
  readonly other_variable_cost_basis?: string | null;
}

export interface StageTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dosage_form: string;
  readonly is_seeded: boolean;
  readonly stages: readonly StageTemplateStageDto[];
}

export interface StageTemplateListResponseDto {
  readonly items: readonly StageTemplateDto[];
}

export interface ApplyStageTemplateResponseDto {
  readonly summary: {
    readonly template_id: string;
    readonly template_name: string;
    readonly stages_applied: number;
  };
  readonly formulation: FormulationDto;
}

export async function fetchStageTemplates(
  orgId: string,
): Promise<StageTemplateListResponseDto> {
  const { data } = await apiClient.get<StageTemplateListResponseDto>(
    formulationsEndpoints.stageTemplates(orgId),
  );
  return data;
}

export interface UpsertStageTemplateRequestDto {
  readonly name: string;
  readonly description?: string;
  readonly dosage_form?: string;
  readonly stages: readonly StageTemplateStageDto[];
}

export async function createStageTemplate(
  orgId: string,
  payload: UpsertStageTemplateRequestDto,
): Promise<StageTemplateDto> {
  const { data } = await apiClient.post<StageTemplateDto>(
    formulationsEndpoints.stageTemplates(orgId),
    payload,
  );
  return data;
}

export async function updateStageTemplate(
  orgId: string,
  templateId: string,
  patch: Partial<UpsertStageTemplateRequestDto>,
): Promise<StageTemplateDto> {
  const { data } = await apiClient.patch<StageTemplateDto>(
    formulationsEndpoints.stageTemplateDetail(orgId, templateId),
    patch,
  );
  return data;
}

export async function deleteStageTemplate(
  orgId: string,
  templateId: string,
): Promise<void> {
  await apiClient.delete(
    formulationsEndpoints.stageTemplateDetail(orgId, templateId),
  );
}

export async function applyStageTemplate(
  orgId: string,
  formulationId: string,
  templateId: string,
): Promise<ApplyStageTemplateResponseDto> {
  const { data } = await apiClient.post<ApplyStageTemplateResponseDto>(
    formulationsEndpoints.applyStageTemplate(orgId, formulationId),
    { template_id: templateId },
  );
  return data;
}


// ---- Page-builder templates ---------------------------------------

// A Puck document is an opaque JSON blob to us — leave it as
// ``unknown`` so the settings editor + apply flow don't accidentally
// couple to Puck's internal shape (which shifts across versions).
export type PageBuilderTemplateContent = Record<string, unknown>;

export interface PageBuilderTemplateDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly is_default: boolean;
  readonly content: PageBuilderTemplateContent;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PageBuilderTemplateListResponseDto {
  readonly items: readonly PageBuilderTemplateDto[];
}

export interface UpsertPageBuilderTemplateRequestDto {
  readonly name: string;
  readonly description?: string;
  readonly is_default?: boolean;
  readonly content?: PageBuilderTemplateContent;
}

export interface ApplyPageBuilderTemplateResponseDto {
  readonly formulation_id: string;
  readonly rtg_page_content: PageBuilderTemplateContent;
  readonly applied_template: PageBuilderTemplateDto;
}

export async function fetchPageBuilderTemplates(
  orgId: string,
): Promise<PageBuilderTemplateListResponseDto> {
  const { data } = await apiClient.get<PageBuilderTemplateListResponseDto>(
    formulationsEndpoints.pageBuilderTemplates(orgId),
  );
  return data;
}

export async function fetchPageBuilderTemplate(
  orgId: string,
  templateId: string,
): Promise<PageBuilderTemplateDto> {
  const { data } = await apiClient.get<PageBuilderTemplateDto>(
    formulationsEndpoints.pageBuilderTemplateDetail(orgId, templateId),
  );
  return data;
}

export async function createPageBuilderTemplate(
  orgId: string,
  payload: UpsertPageBuilderTemplateRequestDto,
): Promise<PageBuilderTemplateDto> {
  const { data } = await apiClient.post<PageBuilderTemplateDto>(
    formulationsEndpoints.pageBuilderTemplates(orgId),
    payload,
  );
  return data;
}

export async function updatePageBuilderTemplate(
  orgId: string,
  templateId: string,
  patch: Partial<UpsertPageBuilderTemplateRequestDto>,
): Promise<PageBuilderTemplateDto> {
  const { data } = await apiClient.patch<PageBuilderTemplateDto>(
    formulationsEndpoints.pageBuilderTemplateDetail(orgId, templateId),
    patch,
  );
  return data;
}

export async function deletePageBuilderTemplate(
  orgId: string,
  templateId: string,
): Promise<void> {
  await apiClient.delete(
    formulationsEndpoints.pageBuilderTemplateDetail(orgId, templateId),
  );
}

export async function applyPageBuilderTemplate(
  orgId: string,
  formulationId: string,
  templateId: string,
): Promise<ApplyPageBuilderTemplateResponseDto> {
  const { data } = await apiClient.post<ApplyPageBuilderTemplateResponseDto>(
    formulationsEndpoints.applyPageBuilderTemplate(orgId, formulationId),
    { template_id: templateId },
  );
  return data;
}


// ---- Photos + files ------------------------------------------------

export type FormulationPhotoPurpose = "internal" | "catalog";

export interface FormulationPhotoDto {
  readonly id: string;
  readonly url: string | null;
  readonly caption: string;
  readonly purpose: FormulationPhotoPurpose;
  readonly is_primary: boolean;
  readonly sort_order: number;
  readonly original_filename: string;
  readonly content_type: string;
  readonly byte_size: number;
  readonly psp_uuid: string | null;
  readonly uploaded_at: string;
}

export interface FormulationPhotosListDto {
  readonly items: readonly FormulationPhotoDto[];
}

export interface FormulationFileDto {
  readonly id: string;
  readonly url: string | null;
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly psp_uuid: string | null;
  readonly uploaded_at: string;
}

export interface FormulationFilesListDto {
  readonly items: readonly FormulationFileDto[];
}

export async function fetchFormulationPhotos(
  orgId: string,
  formulationId: string,
  purpose?: FormulationPhotoPurpose,
): Promise<FormulationPhotosListDto> {
  const { data } = await apiClient.get<FormulationPhotosListDto>(
    formulationsEndpoints.photos(orgId, formulationId),
    purpose ? { params: { purpose } } : undefined,
  );
  return data;
}

export async function uploadFormulationPhoto(
  orgId: string,
  formulationId: string,
  args: {
    file: File;
    caption?: string;
    is_primary?: boolean;
    purpose?: FormulationPhotoPurpose;
  },
): Promise<{ photo: FormulationPhotoDto }> {
  const form = new FormData();
  form.append("file", args.file);
  if (args.caption) form.append("caption", args.caption);
  if (args.is_primary) form.append("is_primary", "true");
  if (args.purpose) form.append("purpose", args.purpose);
  // Do NOT set Content-Type — axios populates boundary automatically.
  const { data } = await apiClient.post<{ photo: FormulationPhotoDto }>(
    formulationsEndpoints.photos(orgId, formulationId),
    form,
  );
  return data;
}

export async function updateFormulationPhoto(
  orgId: string,
  formulationId: string,
  photoId: string,
  patch: {
    caption?: string;
    is_primary?: boolean;
    sort_order?: number;
  },
): Promise<{ photo: FormulationPhotoDto }> {
  const { data } = await apiClient.patch<{ photo: FormulationPhotoDto }>(
    formulationsEndpoints.photoDetail(orgId, formulationId, photoId),
    patch,
  );
  return data;
}

export async function replaceFormulationPhoto(
  orgId: string,
  formulationId: string,
  photoId: string,
  file: File,
): Promise<{ photo: FormulationPhotoDto }> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await apiClient.patch<{ photo: FormulationPhotoDto }>(
    formulationsEndpoints.photoDetail(orgId, formulationId, photoId),
    form,
  );
  return data;
}

export async function deleteFormulationPhoto(
  orgId: string,
  formulationId: string,
  photoId: string,
): Promise<void> {
  await apiClient.delete(
    formulationsEndpoints.photoDetail(orgId, formulationId, photoId),
  );
}

export async function reorderFormulationPhotos(
  orgId: string,
  formulationId: string,
  args: { purpose: FormulationPhotoPurpose; order: readonly string[] },
): Promise<FormulationPhotosListDto> {
  const { data } = await apiClient.post<FormulationPhotosListDto>(
    formulationsEndpoints.photosReorder(orgId, formulationId),
    { purpose: args.purpose, order: args.order },
  );
  return data;
}

export async function fetchFormulationFiles(
  orgId: string,
  formulationId: string,
): Promise<FormulationFilesListDto> {
  const { data } = await apiClient.get<FormulationFilesListDto>(
    formulationsEndpoints.files(orgId, formulationId),
  );
  return data;
}

export async function uploadFormulationFile(
  orgId: string,
  formulationId: string,
  args: { file: File; kind?: string },
): Promise<{ file: FormulationFileDto }> {
  const form = new FormData();
  form.append("file", args.file);
  form.append("kind", args.kind ?? "other");
  const { data } = await apiClient.post<{ file: FormulationFileDto }>(
    formulationsEndpoints.files(orgId, formulationId),
    form,
  );
  return data;
}

export async function deleteFormulationFile(
  orgId: string,
  formulationId: string,
  fileId: string,
): Promise<void> {
  await apiClient.delete(
    formulationsEndpoints.fileDetail(orgId, formulationId, fileId),
  );
}

// ---------------------------------------------------------------------
// Formulation certificates — mirrors the PSP item-detail Certificates
// section. Catalog endpoint proxies PSP's cert registry so the FE
// renders a picker without touching PSP directly.
// ---------------------------------------------------------------------

export interface FormulationCertificateDto {
  readonly id: string;
  readonly psp_certificate_uuid: string;
  readonly psp_certificate_name: string;
  readonly psp_certificate_type: string;
  readonly psp_issuing_body: string;
  readonly certificate_number: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly psp_attachment_uuid: string | null;
  readonly attached_at: string;
}

export interface FormulationCertificatesListDto {
  readonly items: readonly FormulationCertificateDto[];
}

export interface PspCertificateCatalogEntryDto {
  readonly uuid: string;
  readonly name: string;
  readonly certificate_type?: string | null;
  readonly issuing_body?: string | null;
  readonly default_validity_months?: number | null;
}

export interface PspCertificateCatalogDto {
  readonly items: readonly PspCertificateCatalogEntryDto[];
}

export interface AttachFormulationCertificateRequestDto {
  readonly psp_certificate_uuid: string;
  readonly psp_certificate_name: string;
  readonly psp_certificate_type?: string;
  readonly psp_issuing_body?: string;
  readonly certificate_number?: string;
  readonly valid_from?: string | null;
  readonly valid_until?: string | null;
}

export interface UpdateFormulationCertificateRequestDto {
  readonly certificate_number?: string;
  readonly valid_from?: string | null;
  readonly valid_until?: string | null;
}

export async function fetchFormulationCertificates(
  orgId: string,
  formulationId: string,
): Promise<FormulationCertificatesListDto> {
  const { data } = await apiClient.get<FormulationCertificatesListDto>(
    formulationsEndpoints.certificates(orgId, formulationId),
  );
  return data;
}

export async function fetchFormulationCertificateCatalog(
  orgId: string,
  formulationId: string,
): Promise<PspCertificateCatalogDto> {
  const { data } = await apiClient.get<PspCertificateCatalogDto>(
    formulationsEndpoints.certificateCatalog(orgId, formulationId),
  );
  return data;
}

export async function attachFormulationCertificate(
  orgId: string,
  formulationId: string,
  body: AttachFormulationCertificateRequestDto,
): Promise<{ certificate: FormulationCertificateDto }> {
  const { data } = await apiClient.post<{
    certificate: FormulationCertificateDto;
  }>(
    formulationsEndpoints.certificates(orgId, formulationId),
    body,
  );
  return data;
}

export async function updateFormulationCertificate(
  orgId: string,
  formulationId: string,
  certId: string,
  patch: UpdateFormulationCertificateRequestDto,
): Promise<{ certificate: FormulationCertificateDto }> {
  const { data } = await apiClient.patch<{
    certificate: FormulationCertificateDto;
  }>(
    formulationsEndpoints.certificateDetail(orgId, formulationId, certId),
    patch,
  );
  return data;
}

export async function detachFormulationCertificate(
  orgId: string,
  formulationId: string,
  certId: string,
): Promise<void> {
  await apiClient.delete(
    formulationsEndpoints.certificateDetail(orgId, formulationId, certId),
  );
}
