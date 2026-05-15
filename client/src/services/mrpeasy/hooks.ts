/**
 * TanStack Query hooks for the MRPEasy integration.
 *
 * Every component that needs MRPEasy data consumes these hooks —
 * never the raw API functions — so caching, invalidation, and
 * loading states stay consistent across the app.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  clearMrpeasyConfig,
  fetchMrpeasyConfig,
  fetchMrpeasyItems,
  lookupMrpeasyPrice,
  saveMrpeasyConfig,
  testMrpeasyConnection,
} from "./api";
import type {
  MrpeasyConfigDto,
  MrpeasyItemListResponseDto,
  MrpeasyLookupResultDto,
  SaveMrpeasyConfigRequestDto,
} from "./types";

export const mrpeasyQueryKeys = {
  all: [...rootQueryKey, "mrpeasy"] as const,
  config: (orgId: string) =>
    [...mrpeasyQueryKeys.all, "config", orgId] as const,
  lookup: (orgId: string, code: string) =>
    [...mrpeasyQueryKeys.all, "lookup", orgId, code] as const,
  items: (orgId: string, search: string = "") =>
    [...mrpeasyQueryKeys.all, "items", orgId, search] as const,
} as const;

export function useMrpeasyConfig(
  orgId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<MrpeasyConfigDto, ApiError> {
  return useQuery<MrpeasyConfigDto, ApiError>({
    queryKey: mrpeasyQueryKeys.config(orgId),
    queryFn: () => fetchMrpeasyConfig(orgId),
    enabled: options.enabled ?? true,
  });
}

export function useSaveMrpeasyConfig(
  orgId: string,
): UseMutationResult<
  MrpeasyConfigDto,
  ApiError,
  SaveMrpeasyConfigRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    MrpeasyConfigDto,
    ApiError,
    SaveMrpeasyConfigRequestDto
  >({
    mutationFn: (payload) => saveMrpeasyConfig(orgId, payload),
    onSuccess: (config) => {
      // Prime the config cache + invalidate any price lookups so
      // a credential change doesn't silently keep serving cached
      // prices from the old tenant. The backend also drops its
      // own cache on save; this is the frontend mirror.
      queryClient.setQueryData<MrpeasyConfigDto>(
        mrpeasyQueryKeys.config(orgId),
        config,
      );
      queryClient.invalidateQueries({
        queryKey: [...mrpeasyQueryKeys.all, "lookup", orgId],
      });
      // The org's ``mrpeasy_live`` flag may have flipped — refresh
      // the org list so every other consumer (the price-hint
      // render gate) picks up the change.
      queryClient.invalidateQueries({
        queryKey: [...rootQueryKey, "organizations", "list"],
      });
    },
  });
}

export function useClearMrpeasyConfig(
  orgId: string,
): UseMutationResult<MrpeasyConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<MrpeasyConfigDto, ApiError, void>({
    mutationFn: () => clearMrpeasyConfig(orgId),
    onSuccess: (config) => {
      queryClient.setQueryData<MrpeasyConfigDto>(
        mrpeasyQueryKeys.config(orgId),
        config,
      );
      queryClient.invalidateQueries({
        queryKey: [...mrpeasyQueryKeys.all, "lookup", orgId],
      });
      queryClient.invalidateQueries({
        queryKey: [...rootQueryKey, "organizations", "list"],
      });
    },
  });
}

export function useTestMrpeasyConnection(
  orgId: string,
): UseMutationResult<MrpeasyConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<MrpeasyConfigDto, ApiError, void>({
    mutationFn: () => testMrpeasyConnection(orgId),
    onSuccess: (config) => {
      queryClient.setQueryData<MrpeasyConfigDto>(
        mrpeasyQueryKeys.config(orgId),
        config,
      );
    },
  });
}

/**
 * Price-hint lookup. Long stale-time because the backend already
 * caches per ``(org, code)`` for 5 minutes — re-fetching every
 * mount would just bypass the backend cache. ``enabled`` lets
 * callers gate on the org's ``mrpeasy_live`` flag so we never
 * fire the lookup when the integration is off (saves a no-op
 * round-trip).
 */
export function useMrpeasyPrice(
  orgId: string,
  code: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<MrpeasyLookupResultDto, ApiError> {
  return useQuery<MrpeasyLookupResultDto, ApiError>({
    queryKey: mrpeasyQueryKeys.lookup(orgId, code),
    queryFn: () => lookupMrpeasyPrice(orgId, code),
    enabled: (options.enabled ?? true) && Boolean(code),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * Fetch the org's MRPEasy item list for typeahead filtering.
 * Cached 60s client-side to match the backend window — opening
 * the new-project modal twice in a minute hits the cache, not
 * MRPEasy. ``enabled`` is bound by the caller (typically the
 * org's ``mrpeasy_live`` flag) so we don't fire on orgs that
 * haven't connected the integration.
 */
export function useMrpeasyItems(
  orgId: string,
  options: { enabled?: boolean; search?: string } = {},
): UseQueryResult<MrpeasyItemListResponseDto, ApiError> {
  const search = (options.search ?? "").trim();
  return useQuery<MrpeasyItemListResponseDto, ApiError>({
    queryKey: mrpeasyQueryKeys.items(orgId, search),
    queryFn: () => fetchMrpeasyItems(orgId, search || undefined),
    enabled: options.enabled ?? true,
    staleTime: 60 * 1000,
    retry: false,
  });
}
