/**
 * Raw Axios calls for the MRPEasy integration.
 *
 * Functions here are thin wrappers around ``apiClient`` — they
 * only know how to send a request and unwrap the response.
 * Caching, retries, and error mapping live in the corresponding
 * TanStack Query hooks.
 */

import { apiClient } from "@/lib/api";

import { mrpeasyEndpoints } from "./endpoints";
import type {
  MrpeasyConfigDto,
  MrpeasyItemListResponseDto,
  MrpeasyLookupResultDto,
  SaveMrpeasyConfigRequestDto,
} from "./types";

export async function fetchMrpeasyConfig(
  orgId: string,
): Promise<MrpeasyConfigDto> {
  const { data } = await apiClient.get<MrpeasyConfigDto>(
    mrpeasyEndpoints.config(orgId),
  );
  return data;
}

export async function saveMrpeasyConfig(
  orgId: string,
  payload: SaveMrpeasyConfigRequestDto,
): Promise<MrpeasyConfigDto> {
  const { data } = await apiClient.put<MrpeasyConfigDto>(
    mrpeasyEndpoints.config(orgId),
    payload,
  );
  return data;
}

export async function clearMrpeasyConfig(
  orgId: string,
): Promise<MrpeasyConfigDto> {
  const { data } = await apiClient.delete<MrpeasyConfigDto>(
    mrpeasyEndpoints.config(orgId),
  );
  return data;
}

export async function testMrpeasyConnection(
  orgId: string,
): Promise<MrpeasyConfigDto> {
  const { data } = await apiClient.post<MrpeasyConfigDto>(
    mrpeasyEndpoints.test(orgId),
  );
  return data;
}

export async function lookupMrpeasyPrice(
  orgId: string,
  code: string,
): Promise<MrpeasyLookupResultDto> {
  const { data } = await apiClient.get<MrpeasyLookupResultDto>(
    mrpeasyEndpoints.lookup(orgId, code),
  );
  return data;
}

export async function fetchMrpeasyItems(
  orgId: string,
  search?: string,
): Promise<MrpeasyItemListResponseDto> {
  const { data } = await apiClient.get<MrpeasyItemListResponseDto>(
    mrpeasyEndpoints.items(orgId, search),
  );
  return data;
}
