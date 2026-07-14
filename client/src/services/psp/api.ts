/**
 * Fetch helpers for the PSP integration domain.
 *
 * Mirrors the ``services/mrpeasy/api.ts`` shape verbatim so the
 * settings-page card that renders both integrations can reuse the
 * same request pattern (fetch config → save → test → clear).
 */

import { apiClient } from "@/lib/api";

import { pspEndpoints } from "./endpoints";
import type {
  PspConfigDto,
  PspItemListResponseDto,
  PspItemLookupResultDto,
  SavePspConfigRequestDto,
} from "./types";


/** Owner-only. Fetch the current PSP integration config for the
 *  org. Plaintext token is never on the response — ``has_token`` is
 *  the boolean stand-in the form checks. */
export async function fetchPspConfig(orgId: string): Promise<PspConfigDto> {
  const { data } = await apiClient.get<PspConfigDto>(
    pspEndpoints.config(orgId),
  );
  return data;
}


/** Owner-only. Persist the org's PSP integration config. Enabling
 *  PSP clears any live MRPEasy config on the same org (mutual
 *  exclusion enforced server-side). Empty / null
 *  ``integration_token`` preserves the stored ciphertext so an
 *  operator can change the URL without re-pasting the token. */
export async function savePspConfig(
  orgId: string,
  payload: SavePspConfigRequestDto,
): Promise<PspConfigDto> {
  const { data } = await apiClient.put<PspConfigDto>(
    pspEndpoints.config(orgId),
    payload,
  );
  return data;
}


/** Owner-only. Wipe the org's PSP integration config. Returns the
 *  fresh (empty) config so the form re-renders in the disconnected
 *  state without a follow-up fetch. */
export async function clearPspConfig(orgId: string): Promise<PspConfigDto> {
  const { data } = await apiClient.delete<PspConfigDto>(
    pspEndpoints.config(orgId),
  );
  return data;
}


/** Owner-only. Round-trip PSP's health endpoint to verify stored
 *  credentials. Stamps ``last_tested_at`` on success. Failures
 *  surface as typed 400 / 429 / 502 errors the settings card maps
 *  onto specific chip states. */
export async function testPspConnection(
  orgId: string,
): Promise<PspConfigDto> {
  const { data } = await apiClient.post<PspConfigDto>(
    pspEndpoints.test(orgId),
  );
  return data;
}


/** Picker-facing. Lists PSP items filtered server-side. Empty
 *  ``items`` array on any degrade case (integration off, network
 *  outage, PSP-side error) so the caller renders "no matches"
 *  identically for every source. */
export async function fetchPspItems(
  orgId: string,
  args: {
    search?: string;
    itemTypes?: readonly string[];
    useAs?: string;
  } = {},
): Promise<PspItemListResponseDto> {
  const { data } = await apiClient.get<PspItemListResponseDto>(
    pspEndpoints.items(orgId, args),
  );
  return data;
}


/** Picker-facing. Single-item lookup by UUID. Returns the
 *  discriminated ``PspItemLookupResultDto`` so the caller branches
 *  on ``matched`` for the "found" vs "no PSP match" render. */
export async function fetchPspItemDetail(
  orgId: string,
  itemUuid: string,
): Promise<PspItemLookupResultDto> {
  const { data } = await apiClient.get<PspItemLookupResultDto>(
    pspEndpoints.itemDetail(orgId, itemUuid),
  );
  return data;
}
