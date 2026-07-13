/**
 * Raw Axios calls for the CFF submissions domain.
 *
 * Functions here are thin wrappers around ``apiClient`` — they
 * only know how to send a request and unwrap the response.
 * Caching, retries, and error mapping live in the corresponding
 * TanStack Query hooks.
 */

import { apiClient } from "@/lib/api";

import { cffEndpoints } from "./endpoints";
import type {
  CFFFieldLabelsDto,
  CFFSubmissionDto,
  CFFSyncStatusDto,
  CreateProjectFromCFFRequestDto,
  CreateProjectFromCFFResponseDto,
  PaginatedCFFSubmissionsDto,
  SaveWixCFFConfigRequestDto,
  WixCFFConfigDto,
} from "./types";


/** Triage filter states. ``unassigned`` is the default lens; the
 *  Rejected tab is separate so denied CFFs don't pile up alongside
 *  the ones triage still owes a decision on. */
export type CFFTriageState = "unassigned" | "assigned" | "rejected" | "all";


export interface FetchCFFSubmissionsPageOptions {
  readonly cursorUrl?: string;
  /** Four-way triage lens. Preferred over the legacy ``assigned``
   *  boolean below because the boolean can't express "rejected". */
  readonly state?: CFFTriageState;
  /** @deprecated — use ``state`` instead. Kept for callers that
   *  haven't migrated. When both are supplied, ``state`` wins. */
  readonly assigned?: boolean;
  readonly search?: string;
  readonly projectId?: string;
  readonly pageSize?: number;
}


export async function fetchCFFSubmissionsPage(
  orgId: string,
  options: FetchCFFSubmissionsPageOptions = {},
): Promise<PaginatedCFFSubmissionsDto> {
  // When walking the cursor, the URL from ``next`` already carries
  // every query param the first call used — we just hand it to the
  // client verbatim. Otherwise build the first-page URL from the
  // filter options.
  const url = options.cursorUrl ?? buildListUrl(orgId, options);
  const { data } = await apiClient.get<PaginatedCFFSubmissionsDto>(url);
  return data;
}


function buildListUrl(
  orgId: string,
  options: FetchCFFSubmissionsPageOptions,
): string {
  const params = new URLSearchParams();
  // ``state`` wins over the legacy ``assigned`` boolean so callers
  // can migrate incrementally. The backend also accepts either.
  if (options.state) {
    params.set("state", options.state);
  } else if (options.assigned !== undefined) {
    params.set("assigned", options.assigned ? "true" : "false");
  }
  if (options.search?.trim()) {
    params.set("search", options.search.trim());
  }
  if (options.projectId) {
    params.set("project_id", options.projectId);
  }
  if (options.pageSize) {
    params.set("page_size", String(options.pageSize));
  }
  const qs = params.toString();
  return qs
    ? `${cffEndpoints.list(orgId)}?${qs}`
    : cffEndpoints.list(orgId);
}


export async function fetchCFFSubmission(
  orgId: string,
  submissionId: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.get<CFFSubmissionDto>(
    cffEndpoints.detail(orgId, submissionId),
  );
  return data;
}


export async function assignCFFToProject(
  orgId: string,
  submissionId: string,
  projectId: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.post<CFFSubmissionDto>(
    cffEndpoints.assign(orgId, submissionId),
    { project_id: projectId },
  );
  return data;
}


/**
 * Detach a CFF from one (or every) linked project.
 *
 * ``projectId`` is the per-row "remove from this project" action on
 * the detail modal. Omitted, the call falls back to the legacy
 * single-FK behaviour and detaches every link the CFF holds — used
 * by the inbox-row "send back to triage" button.
 */
export async function unassignCFF(
  orgId: string,
  submissionId: string,
  projectId?: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.post<CFFSubmissionDto>(
    cffEndpoints.unassign(orgId, submissionId),
    projectId ? { project_id: projectId } : {},
  );
  return data;
}


/** Reject a CFF with a required reason. */
export async function rejectCFF(
  orgId: string,
  submissionId: string,
  reason: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.post<CFFSubmissionDto>(
    cffEndpoints.reject(orgId, submissionId),
    { reason },
  );
  return data;
}


/** Un-reject a previously-rejected CFF, sending it back to triage. */
export async function unrejectCFF(
  orgId: string,
  submissionId: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.post<CFFSubmissionDto>(
    cffEndpoints.unreject(orgId, submissionId),
    {},
  );
  return data;
}


export async function createProjectFromCFF(
  orgId: string,
  submissionId: string,
  payload: CreateProjectFromCFFRequestDto,
): Promise<CreateProjectFromCFFResponseDto> {
  const { data } = await apiClient.post<CreateProjectFromCFFResponseDto>(
    cffEndpoints.createProject(orgId, submissionId),
    payload,
  );
  return data;
}


export async function fetchCFFFieldLabels(
  orgId: string,
): Promise<CFFFieldLabelsDto> {
  const { data } = await apiClient.get<CFFFieldLabelsDto>(
    cffEndpoints.fieldLabels(orgId),
  );
  return data;
}


export async function fetchCFFSyncStatus(
  orgId: string,
): Promise<CFFSyncStatusDto> {
  const { data } = await apiClient.get<CFFSyncStatusDto>(
    cffEndpoints.syncStatus(orgId),
  );
  return data;
}


// ---------------------------------------------------------------------------
// Integration settings
// ---------------------------------------------------------------------------


export async function fetchWixCFFConfig(
  orgId: string,
): Promise<WixCFFConfigDto> {
  const { data } = await apiClient.get<WixCFFConfigDto>(
    cffEndpoints.integration(orgId),
  );
  return data;
}


export async function saveWixCFFConfig(
  orgId: string,
  payload: SaveWixCFFConfigRequestDto,
): Promise<WixCFFConfigDto> {
  const { data } = await apiClient.put<WixCFFConfigDto>(
    cffEndpoints.integration(orgId),
    payload,
  );
  return data;
}


export async function clearWixCFFConfig(
  orgId: string,
): Promise<WixCFFConfigDto> {
  const { data } = await apiClient.delete<WixCFFConfigDto>(
    cffEndpoints.integration(orgId),
  );
  return data;
}


export async function testWixCFFConnection(
  orgId: string,
): Promise<WixCFFConfigDto> {
  const { data } = await apiClient.post<WixCFFConfigDto>(
    cffEndpoints.integrationTest(orgId),
  );
  return data;
}
