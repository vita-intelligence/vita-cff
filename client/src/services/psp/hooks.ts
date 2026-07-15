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
  fetchPspConfig,
  fetchPspItemDetail,
  fetchPspItems,
  fetchPspWorkstationGroups,
  fetchPspWorkstationUsers,
  mirrorPspItem,
  savePspConfig,
  testPspConnection,
} from "./api";
import type {
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
  workstationGroups: (orgId: string) =>
    ["psp", orgId, "workstation-groups"] as const,
  workstationUsers: (orgId: string) =>
    ["psp", orgId, "workstation-users"] as const,
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
