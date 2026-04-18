/**
 * Raw Axios calls for the organizations domain.
 *
 * Functions here are thin wrappers around ``apiClient`` — only the
 * minimum needed to send a request and unwrap the response. Caching and
 * error mapping live in the interceptors and hooks layer.
 */

import { apiClient } from "@/lib/api";

import { organizationsEndpoints } from "./endpoints";
import type {
  CreateOrganizationRequestDto,
  CreateOrganizationResponseDto,
  OrganizationDto,
} from "./types";

export async function fetchOrganizations(): Promise<OrganizationDto[]> {
  const { data } = await apiClient.get<OrganizationDto[]>(
    organizationsEndpoints.list,
  );
  return data;
}

export async function createOrganization(
  payload: CreateOrganizationRequestDto,
): Promise<CreateOrganizationResponseDto> {
  const { data } = await apiClient.post<CreateOrganizationResponseDto>(
    organizationsEndpoints.list,
    payload,
  );
  return data;
}


export interface UpdateOrganizationRequestDto {
  readonly name?: string;
}


export async function updateOrganization(
  orgId: string,
  payload: UpdateOrganizationRequestDto,
): Promise<OrganizationDto> {
  const { data } = await apiClient.patch<OrganizationDto>(
    organizationsEndpoints.detail(orgId),
    payload,
  );
  return data;
}
