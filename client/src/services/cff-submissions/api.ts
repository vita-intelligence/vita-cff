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


export interface FetchCFFSubmissionsPageOptions {
  readonly cursorUrl?: string;
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
  if (options.assigned !== undefined) {
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


export async function unassignCFF(
  orgId: string,
  submissionId: string,
): Promise<CFFSubmissionDto> {
  const { data } = await apiClient.post<CFFSubmissionDto>(
    cffEndpoints.unassign(orgId, submissionId),
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
