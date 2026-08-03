/**
 * TanStack Query hooks for the PSP integration domain.
 *
 * Follows the same key + mutation pattern as ``services/mrpeasy/hooks.ts``
 * so the settings card that renders both integrations can reuse the
 * same UI patterns (isPending, isError, invalidation on save).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { type ApiError } from "@/lib/api";

import {
  clearPspConfig,
  createPspFinishedProduct,
  fetchPspAccessTokens,
  fetchPspConfig,
  fetchPspItemBom,
  fetchPspItemDetail,
  fetchPspItems,
  fetchPspAllergens,
  fetchPspProductFamilies,
  fetchPspRndWarehouses,
  fetchPspStorageTags,
  fetchPspUnitsOfMeasurement,
  fetchPspWorkstationGroups,
  fetchPspWorkstationUsers,
  mintPspAccessToken,
  mirrorPspItem,
  revokePspAccessToken,
  savePspConfig,
  testPspConnection,
  type CreatePspFinishedProductRequestDto,
  type CreatePspFinishedProductResponseDto,
  type PspAllergensListResponseDto,
  type PspItemBomResponseDto,
  type PspProductFamiliesListResponseDto,
  type PspRndWarehousesListResponseDto,
  type PspStorageTagsListResponseDto,
  type PspUnitsOfMeasurementListResponseDto,
} from "./api";
import type {
  PspAccessTokenDto,
  PspAccessTokenListDto,
  PspAccessTokenMintResponseDto,
  PspConfigDto,
  PspItemListResponseDto,
  PspItemLookupResultDto,
  PspItemMirrorResponseDto,
  PspWorkstationGroupListResponseDto,
  PspWorkstationUserListResponseDto,
  SavePspConfigRequestDto,
} from "./types";


export const pspQueryKeys = {
  root: (orgId: string) => ["psp", orgId] as const,
  config: (orgId: string) =>
    ["psp", orgId, "config"] as const,
  items: (
    orgId: string,
    args: {
      search?: string;
      itemTypes?: readonly string[];
      useAs?: string;
    } = {},
  ) =>
    [
      "psp",
      orgId,
      "items",
      (args.search ?? "").trim(),
      [...(args.itemTypes ?? [])].sort().join(","),
      (args.useAs ?? "").trim(),
    ] as const,
  itemDetail: (orgId: string, uuid: string) =>
    ["psp", orgId, "items", uuid] as const,
  itemBom: (orgId: string, uuid: string) =>
    ["psp", orgId, "items", uuid, "bom"] as const,
  workstationGroups: (orgId: string) =>
    ["psp", orgId, "workstation-groups"] as const,
  workstationUsers: (orgId: string) =>
    ["psp", orgId, "workstation-users"] as const,
  unitsOfMeasurement: (orgId: string) =>
    ["psp", orgId, "units-of-measurement"] as const,
  productFamilies: (orgId: string) =>
    ["psp", orgId, "product-families"] as const,
  allergens: (orgId: string) => ["psp", orgId, "allergens"] as const,
  storageTags: (orgId: string) => ["psp", orgId, "storage-tags"] as const,
  rndWarehouses: (orgId: string) =>
    ["psp", orgId, "rnd-warehouses"] as const,
};


export function usePspConfig(
  orgId: string,
): UseQueryResult<PspConfigDto, ApiError> {
  return useQuery<PspConfigDto, ApiError>({
    queryKey: pspQueryKeys.config(orgId),
    queryFn: () => fetchPspConfig(orgId),
    enabled: Boolean(orgId),
  });
}


export function useSavePspConfig(
  orgId: string,
): UseMutationResult<PspConfigDto, ApiError, SavePspConfigRequestDto> {
  const qc = useQueryClient();
  return useMutation<PspConfigDto, ApiError, SavePspConfigRequestDto>({
    mutationFn: (payload) => savePspConfig(orgId, payload),
    onSuccess: (data) => {
      qc.setQueryData(pspQueryKeys.config(orgId), data);
      // Enabling PSP flips ``psp_live`` on the organization AND
      // clears MRPEasy (server-side mutual exclusion) — bust both
      // caches so the settings page re-reads the fresh state.
      qc.invalidateQueries({ queryKey: ["organizations"] });
      qc.invalidateQueries({ queryKey: ["mrpeasy", orgId] });
    },
  });
}


export function useClearPspConfig(
  orgId: string,
): UseMutationResult<PspConfigDto, ApiError, void> {
  const qc = useQueryClient();
  return useMutation<PspConfigDto, ApiError, void>({
    mutationFn: () => clearPspConfig(orgId),
    onSuccess: (data) => {
      qc.setQueryData(pspQueryKeys.config(orgId), data);
      qc.invalidateQueries({ queryKey: ["organizations"] });
    },
  });
}


export function useTestPspConnection(
  orgId: string,
): UseMutationResult<PspConfigDto, ApiError, void> {
  const qc = useQueryClient();
  return useMutation<PspConfigDto, ApiError, void>({
    mutationFn: () => testPspConnection(orgId),
    onSuccess: (data) => {
      qc.setQueryData(pspQueryKeys.config(orgId), data);
    },
  });
}


/** Picker-facing. Only fires when ``enabled`` is true so the
 *  settings surface + gated pickers can control when the fetch
 *  actually runs (typeahead, on-demand, …). */
export function usePspItems(
  orgId: string,
  args: {
    enabled?: boolean;
    search?: string;
    itemTypes?: readonly string[];
    useAs?: string;
  } = {},
): UseQueryResult<PspItemListResponseDto, ApiError> {
  const { enabled = true, ...filters } = args;
  return useQuery<PspItemListResponseDto, ApiError>({
    queryKey: pspQueryKeys.items(orgId, filters),
    queryFn: () => fetchPspItems(orgId, filters),
    enabled: Boolean(orgId) && enabled,
  });
}


export function usePspItemDetail(
  orgId: string,
  itemUuid: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspItemLookupResultDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspItemLookupResultDto, ApiError>({
    queryKey: pspQueryKeys.itemDetail(orgId, itemUuid),
    queryFn: () => fetchPspItemDetail(orgId, itemUuid),
    enabled: Boolean(orgId) && Boolean(itemUuid) && enabled,
  });
}


/** Mutation hook for the mirror-on-pick flow. Invalidates the
 *  local catalogues cache on success so any concurrent picker on
 *  the same page sees the new mirror row without a manual refetch.
 *  The builder's active-ingredient picker consumes this to
 *  materialise a PSP pick as a local Item before handing it to
 *  ``addIngredient``. */
/** Picker for the stage builder's "run on" dropdown. Fires only
 *  when ``enabled`` — the builder only needs it when the operator
 *  opens the stage strip's picker, not on every builder mount. */
export function usePspWorkstationGroups(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspWorkstationGroupListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspWorkstationGroupListResponseDto, ApiError>({
    queryKey: pspQueryKeys.workstationGroups(orgId),
    queryFn: () => fetchPspWorkstationGroups(orgId),
    enabled: Boolean(orgId) && enabled,
    // Groups change rarely and the operator won't refresh mid-build.
    staleTime: 5 * 60 * 1000,
  });
}


/** Picker for the stage builder's workers multi-picker. Fires only
 *  when ``enabled`` — matches the workstation-groups hook so we
 *  don't burn PSP round-trips on every builder mount. */
export function usePspWorkstationUsers(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspWorkstationUserListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspWorkstationUserListResponseDto, ApiError>({
    queryKey: pspQueryKeys.workstationUsers(orgId),
    queryFn: () => fetchPspWorkstationUsers(orgId),
    enabled: Boolean(orgId) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}


/** Stage form's ``Stock UOM`` picker. Same lazy pattern as the
 *  workstation hooks — only fires when the stage strip mounts. */
export function usePspUnitsOfMeasurement(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspUnitsOfMeasurementListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspUnitsOfMeasurementListResponseDto, ApiError>({
    queryKey: pspQueryKeys.unitsOfMeasurement(orgId),
    queryFn: () => fetchPspUnitsOfMeasurement(orgId),
    enabled: Boolean(orgId) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}


/** Stage form's ``Product family`` picker. */
export function usePspProductFamilies(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspProductFamiliesListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspProductFamiliesListResponseDto, ApiError>({
    queryKey: pspQueryKeys.productFamilies(orgId),
    queryFn: () => fetchPspProductFamilies(orgId),
    enabled: Boolean(orgId) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}


/** Per-stage live BOM read. The stage strip fires one of these per
 *  stage that has a PSP item uuid — silent-degrade so a missing /
 *  unpushed item shows the "not on PSP yet" empty state. Cached for
 *  60s so quick tab-switches don't refetch on every mount. */
export function usePspItemBom(
  orgId: string,
  itemUuid: string | null | undefined,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspItemBomResponseDto, ApiError> {
  const { enabled = true } = args;
  const cleaned = (itemUuid ?? "").trim();
  return useQuery<PspItemBomResponseDto, ApiError>({
    queryKey: pspQueryKeys.itemBom(orgId, cleaned),
    queryFn: () => fetchPspItemBom(orgId, cleaned),
    enabled: Boolean(orgId) && Boolean(cleaned) && enabled,
    staleTime: 60 * 1000,
  });
}


/** Setup form's Allergens checkboxes. */
export function usePspAllergens(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspAllergensListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspAllergensListResponseDto, ApiError>({
    queryKey: pspQueryKeys.allergens(orgId),
    queryFn: () => fetchPspAllergens(orgId),
    enabled: Boolean(orgId) && enabled,
    staleTime: 10 * 60 * 1000,
  });
}


/** Setup form's Storage tags multi-picker. */
export function usePspStorageTags(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspStorageTagsListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspStorageTagsListResponseDto, ApiError>({
    queryKey: pspQueryKeys.storageTags(orgId),
    queryFn: () => fetchPspStorageTags(orgId),
    enabled: Boolean(orgId) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}


/** R&D warehouse picker for the Create-MO-on-PSP modal. PSP
 *  filters to warehouses with ≥1 R&D-tagged cell so the scientist
 *  can only route trial batches to warehouses actually set up for
 *  R&D. Only fires when ``enabled`` — no reason to hit PSP until
 *  the modal is actually open. */
export function usePspRndWarehouses(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<PspRndWarehousesListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<PspRndWarehousesListResponseDto, ApiError>({
    queryKey: pspQueryKeys.rndWarehouses(orgId),
    queryFn: () => fetchPspRndWarehouses(orgId),
    enabled: Boolean(orgId) && enabled,
    // Warehouses + their R&D tagging change rarely, and the picker
    // is a one-shot per modal open — safe to cache aggressively.
    staleTime: 5 * 60 * 1000,
  });
}


export function useMirrorPspItem(
  orgId: string,
): UseMutationResult<PspItemMirrorResponseDto, ApiError, string> {
  const qc = useQueryClient();
  return useMutation<PspItemMirrorResponseDto, ApiError, string>({
    mutationFn: (pspItemUuid: string) => mirrorPspItem(orgId, pspItemUuid),
    onSuccess: () => {
      // The mirror row lands in the org's ``psp_mirror`` catalogue —
      // any hook listing local catalogues on the same page must
      // refetch to see it. Broad invalidation keeps the FE simple;
      // per-catalogue-slug scoping is an optimisation for later.
      qc.invalidateQueries({ queryKey: ["catalogues"] });
    },
  });
}


/**
 * Create a brand-new PSP finished-product item so the New-formulation
 * dialog can link it as ``psp_finished_product_uuid`` on the
 * subsequent ``create_formulation`` call — no context switch to PSP
 * required. Invalidates the PSP items list caches so a follow-up
 * search inside the picker on the same page sees the new row.
 */
export function useCreatePspFinishedProduct(
  orgId: string,
): UseMutationResult<
  CreatePspFinishedProductResponseDto,
  ApiError,
  CreatePspFinishedProductRequestDto
> {
  const qc = useQueryClient();
  return useMutation<
    CreatePspFinishedProductResponseDto,
    ApiError,
    CreatePspFinishedProductRequestDto
  >({
    mutationFn: (payload) => createPspFinishedProduct(orgId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["psp", orgId, "items"] });
    },
  });
}


//: Query key for the PSP-facing access-token list — same
//: ``["psp", orgId, ...]`` root as the other PSP hooks so a global
//: PSP invalidate reaches everything.
export function pspAccessTokensQueryKey(orgId: string) {
  return ["psp", orgId, "access-tokens"] as const;
}


export function usePspAccessTokens(
  orgId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<PspAccessTokenListDto, ApiError> {
  return useQuery<PspAccessTokenListDto, ApiError>({
    queryKey: pspAccessTokensQueryKey(orgId),
    queryFn: () => fetchPspAccessTokens(orgId),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}


export function useMintPspAccessToken(
  orgId: string,
): UseMutationResult<
  PspAccessTokenMintResponseDto,
  ApiError,
  { name: string }
> {
  const qc = useQueryClient();
  return useMutation<
    PspAccessTokenMintResponseDto,
    ApiError,
    { name: string }
  >({
    mutationFn: (input) => mintPspAccessToken(orgId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pspAccessTokensQueryKey(orgId) });
    },
  });
}


export function useRevokePspAccessToken(
  orgId: string,
): UseMutationResult<
  { record: PspAccessTokenDto },
  ApiError,
  { tokenId: string; reason?: string }
> {
  const qc = useQueryClient();
  return useMutation<
    { record: PspAccessTokenDto },
    ApiError,
    { tokenId: string; reason?: string }
  >({
    mutationFn: ({ tokenId, reason }) =>
      revokePspAccessToken(orgId, tokenId, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pspAccessTokensQueryKey(orgId) });
    },
  });
}
