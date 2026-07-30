/**
 * Raw Axios calls for the formulations domain.
 */

import { apiClient } from "@/lib/api";

import { formulationsEndpoints } from "./endpoints";
import type {
  AssignLeadScientistRequestDto,
  AssignSalesPersonRequestDto,
  CFFCandidatesResponseDto,
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
  const { data } = await apiClient.get<PaginatedFormulationsDto>(
    formulationsEndpoints.list(orgId),
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


// ---- Photos + files ------------------------------------------------

export interface FormulationPhotoDto {
  readonly id: string;
  readonly url: string | null;
  readonly caption: string;
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
): Promise<FormulationPhotosListDto> {
  const { data } = await apiClient.get<FormulationPhotosListDto>(
    formulationsEndpoints.photos(orgId, formulationId),
  );
  return data;
}

export async function uploadFormulationPhoto(
  orgId: string,
  formulationId: string,
  args: { file: File; caption?: string; is_primary?: boolean },
): Promise<{ photo: FormulationPhotoDto }> {
  const form = new FormData();
  form.append("file", args.file);
  if (args.caption) form.append("caption", args.caption);
  if (args.is_primary) form.append("is_primary", "true");
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
  patch: { caption?: string; is_primary?: boolean },
): Promise<{ photo: FormulationPhotoDto }> {
  const { data } = await apiClient.patch<{ photo: FormulationPhotoDto }>(
    formulationsEndpoints.photoDetail(orgId, formulationId, photoId),
    patch,
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
