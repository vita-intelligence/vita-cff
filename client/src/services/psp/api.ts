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
  PspItemMirrorResponseDto,
  PspWorkstationGroupListResponseDto,
  PspWorkstationUserListResponseDto,
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


/** Mirror-on-pick: hand off a picked PSP item UUID and get back a
 *  local ``catalogues.Item`` DTO. The mirror is upsert-idempotent —
 *  re-picking the same PSP item returns the same local Item, no
 *  duplication. Requires ``formulations.edit``. */
export async function mirrorPspItem(
  orgId: string,
  pspItemUuid: string,
): Promise<PspItemMirrorResponseDto> {
  const { data } = await apiClient.post<PspItemMirrorResponseDto>(
    pspEndpoints.itemMirror(orgId, pspItemUuid),
  );
  return data;
}


/** Picker-facing. Feeds the stage builder's "run on" dropdown with
 *  PSP's workstation groups. Silent-degrade — empty list on any
 *  soft failure (integration off, PSP outage). */
export async function fetchPspWorkstationGroups(
  orgId: string,
): Promise<PspWorkstationGroupListResponseDto> {
  const { data } =
    await apiClient.get<PspWorkstationGroupListResponseDto>(
      pspEndpoints.workstationGroups(orgId),
    );
  return data;
}


/** Picker-facing. Feeds the stage builder's workers multi-picker
 *  with PSP's operator list. Silent-degrade — empty list on any
 *  soft failure (integration off, PSP outage). */
export async function fetchPspWorkstationUsers(
  orgId: string,
): Promise<PspWorkstationUserListResponseDto> {
  const { data } =
    await apiClient.get<PspWorkstationUserListResponseDto>(
      pspEndpoints.workstationUsers(orgId),
    );
  return data;
}


/** Stage form's ``Stock UOM`` picker. */
export interface PspUnitOfMeasurementDto {
  uuid: string;
  name: string;
  symbol: string;
  dimension: string;
}
export interface PspUnitsOfMeasurementListResponseDto {
  items: readonly PspUnitOfMeasurementDto[];
}
export async function fetchPspUnitsOfMeasurement(
  orgId: string,
): Promise<PspUnitsOfMeasurementListResponseDto> {
  const { data } =
    await apiClient.get<PspUnitsOfMeasurementListResponseDto>(
      pspEndpoints.unitsOfMeasurement(orgId),
    );
  return data;
}


/** Setup form's ``Allergens`` checkboxes. Global read-only catalog
 *  seeded on PSP; the finished-product PSP item M:N's these rows. */
export interface PspAllergenDto {
  uuid: string;
  key: string;
  label: string;
  source: string;
}
export interface PspAllergensListResponseDto {
  items: readonly PspAllergenDto[];
}
export async function fetchPspAllergens(
  orgId: string,
): Promise<PspAllergensListResponseDto> {
  const { data } = await apiClient.get<PspAllergensListResponseDto>(
    pspEndpoints.allergens(orgId),
  );
  return data;
}


/** Setup form's ``Storage tags`` multi-picker. Company-scoped on PSP. */
export interface PspStorageTagDto {
  uuid: string;
  name: string;
  color: string | null;
}
export interface PspStorageTagsListResponseDto {
  items: readonly PspStorageTagDto[];
}
export async function fetchPspStorageTags(
  orgId: string,
): Promise<PspStorageTagsListResponseDto> {
  const { data } = await apiClient.get<PspStorageTagsListResponseDto>(
    pspEndpoints.storageTags(orgId),
  );
  return data;
}


/** Stage form's ``Product family`` picker. */
export interface PspProductFamilyDto {
  uuid: string;
  name: string;
  description: string | null;
}
export interface PspProductFamiliesListResponseDto {
  items: readonly PspProductFamilyDto[];
}
export async function fetchPspProductFamilies(
  orgId: string,
): Promise<PspProductFamiliesListResponseDto> {
  const { data } =
    await apiClient.get<PspProductFamiliesListResponseDto>(
      pspEndpoints.productFamilies(orgId),
    );
  return data;
}


/** Live per-stage BOM read. Each stage card on the strip fetches
 *  its own item's active primary BOM so the display mirrors PSP —
 *  no local synthesis. ``bom: null`` = the item has no primary BOM
 *  (never pushed, or PSP off / mis-configured / round-trip failed);
 *  the FE renders "not on PSP yet" for every one of those cases. */
export interface PspBomLinePartDto {
  readonly uuid: string;
  readonly name: string;
  readonly internal_code: string;
  readonly item_type: string;
}
export interface PspBomLineDto {
  readonly sort_order: number;
  readonly qty: string | number;
  readonly is_fixed: boolean;
  readonly notes: string;
  readonly uom_uuid: string | null;
  readonly uom_symbol: string;
  readonly part: PspBomLinePartDto;
}
export interface PspBomDto {
  readonly uuid: string;
  readonly name: string;
  readonly notes: string;
  readonly item_uuid: string;
  readonly lines: readonly PspBomLineDto[];
}
export interface PspItemBomResponseDto {
  readonly bom: PspBomDto | null;
}
export async function fetchPspItemBom(
  orgId: string,
  itemUuid: string,
): Promise<PspItemBomResponseDto> {
  const { data } = await apiClient.get<PspItemBomResponseDto>(
    pspEndpoints.itemBom(orgId, itemUuid),
  );
  return data;
}


/** New-formulation dialog: create a brand-new PSP finished-product
 *  item so the scientist doesn't have to switch UIs when a CFF lands
 *  with a genuinely new SKU. Server locks ``item_type`` to
 *  ``finished_product``. Blank ``external_sku`` auto-generates
 *  server-side. */
export interface CreatePspFinishedProductRequestDto {
  readonly name: string;
  readonly external_sku?: string;
  readonly description?: string;
  readonly barcode?: string;
}

export interface CreatePspFinishedProductResponseDto {
  readonly uuid: string;
  readonly name: string;
  readonly item_type: string;
  readonly external_sku: string;
  /** PSP's system-generated numbering-format code (``MA00295`` etc.).
   *  This is the value the scientist sees on the PSP UI and what NPD
   *  should render as the project "Code" — not the idempotency-key
   *  ``external_sku``. Null on old PSP builds that predate the field
   *  being on the create response. */
  readonly code?: string | null;
  readonly description?: string;
  readonly is_active?: boolean;
  readonly created: boolean;
}

export async function createPspFinishedProduct(
  orgId: string,
  payload: CreatePspFinishedProductRequestDto,
): Promise<CreatePspFinishedProductResponseDto> {
  const { data } = await apiClient.post<CreatePspFinishedProductResponseDto>(
    pspEndpoints.createFinishedProduct(orgId),
    payload,
  );
  return data;
}
