/**
 * Raw Axios calls for the specifications domain.
 */

import { apiClient } from "@/lib/api";

import { specificationsEndpoints } from "./endpoints";
import type {
  CreateSpecificationRequestDto,
  PackagingOptionsPageDto,
  PackagingSlot,
  PaginatedSpecificationsDto,
  RenderedSheetContext,
  SetPackagingRequestDto,
  SpecificationSheetDto,
  TransitionStatusRequestDto,
  UpdateSpecificationRequestDto,
  UpdateVisibilityRequestDto,
} from "./types";

export interface FetchSpecificationsPageArgs {
  readonly cursorUrl?: string | null;
  readonly pageSize?: number;
  /** Optional project scope — drives the Spec Sheets tab so it
   * surfaces only sheets built against this project's versions. */
  readonly formulationId?: string;
  /** Optional lifecycle filter, e.g. ``"in_review"`` for the
   *  director's approval inbox. */
  readonly status?: string;
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
  if (args.formulationId) params.formulation_id = args.formulationId;
  if (args.status) params.status = args.status;
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

export interface FetchPackagingOptionsArgs {
  readonly slot: PackagingSlot;
  readonly search?: string;
  readonly limit?: number;
}

export async function fetchPackagingOptions(
  orgId: string,
  args: FetchPackagingOptionsArgs,
): Promise<PackagingOptionsPageDto> {
  const { data } = await apiClient.get<PackagingOptionsPageDto>(
    specificationsEndpoints.packagingOptions(orgId, args),
  );
  return data;
}

export async function setSpecificationPackaging(
  orgId: string,
  sheetId: string,
  payload: SetPackagingRequestDto,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.post<SpecificationSheetDto>(
    specificationsEndpoints.packaging(orgId, sheetId),
    payload,
  );
  return data;
}

/**
 * Write per-section visibility flags. Returns the full render-context
 * so the UI can repaint in place; the response mirrors what
 * ``GET /render/`` would produce after the write.
 */
export async function setSpecificationVisibility(
  orgId: string,
  sheetId: string,
  payload: UpdateVisibilityRequestDto,
): Promise<RenderedSheetContext> {
  const { data } = await apiClient.put<RenderedSheetContext>(
    specificationsEndpoints.visibility(orgId, sheetId),
    payload,
  );
  return data;
}

export async function rotateSpecificationPublicLink(
  orgId: string,
  sheetId: string,
): Promise<SpecificationSheetDto> {
  const { data } = await apiClient.post<SpecificationSheetDto>(
    specificationsEndpoints.publicLink(orgId, sheetId),
  );
  return data;
}

export async function revokeSpecificationPublicLink(
  orgId: string,
  sheetId: string,
): Promise<void> {
  await apiClient.delete(specificationsEndpoints.publicLink(orgId, sheetId));
}

export async function fetchPublicRenderedSpecification(
  token: string,
): Promise<RenderedSheetContext> {
  // Bypasses the shared Axios client to avoid the auth interceptors —
  // the public endpoint intentionally rejects credentials so we hit
  // it with plain ``fetch`` instead.
  const res = await fetch(specificationsEndpoints.publicRender(token), {
    method: "GET",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`public_render_failed_${res.status}`);
  }
  return (await res.json()) as RenderedSheetContext;
}
