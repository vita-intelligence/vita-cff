/**
 * Raw Axios calls for the specifications domain.
 */

import { apiClient } from "@/lib/api";

import { specificationsEndpoints } from "./endpoints";
import type {
  CreateSpecificationRequestDto,
  PaginatedSpecificationsDto,
  RenderedSheetContext,
  SpecificationSheetDto,
  TransitionStatusRequestDto,
  UpdateSpecificationRequestDto,
} from "./types";

export interface FetchSpecificationsPageArgs {
  readonly cursorUrl?: string | null;
  readonly pageSize?: number;
}

export async function fetchSpecificationsPage(
  orgId: string,
  args: FetchSpecificationsPageArgs = {},
): Promise<PaginatedSpecificationsDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedSpecificationsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }
  const params: Record<string, string> = {};
  if (args.pageSize) params.page_size = String(args.pageSize);
  const { data } = await apiClient.get<PaginatedSpecificationsDto>(
    specificationsEndpoints.list(orgId),
    { params },
  );
  return data;
}

export async function fetchSpecification(
  orgId: string,
  sheetId: string,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.get<SpecificationSheetDto>(
    specificationsEndpoints.detail(orgId, sheetId),
  );
  return data;
}

export async function fetchRenderedSpecification(
  orgId: string,
  sheetId: string,
): Promise<RenderedSheetContext> {
  const { data } = await apiClient.get<RenderedSheetContext>(
    specificationsEndpoints.render(orgId, sheetId),
  );
  return data;
}

export async function createSpecification(
  orgId: string,
  payload: CreateSpecificationRequestDto,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.post<SpecificationSheetDto>(
    specificationsEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateSpecification(
  orgId: string,
  sheetId: string,
  payload: UpdateSpecificationRequestDto,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.patch<SpecificationSheetDto>(
    specificationsEndpoints.detail(orgId, sheetId),
    payload,
  );
  return data;
}

export async function deleteSpecification(
  orgId: string,
  sheetId: string,
): Promise<void> {
  await apiClient.delete(specificationsEndpoints.detail(orgId, sheetId));
}

export async function transitionSpecificationStatus(
  orgId: string,
  sheetId: string,
  payload: TransitionStatusRequestDto,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.post<SpecificationSheetDto>(
    specificationsEndpoints.status(orgId, sheetId),
    payload,
  );
  return data;
}
