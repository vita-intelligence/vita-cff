/**
 * TanStack Query hooks for the specifications domain.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  createSpecification,
  deleteSpecification,
  fetchPackagingOptions,
  fetchRenderedSpecification,
  fetchSpecification,
  fetchSpecificationsPage,
  refreshSpecificationPricing,
  regenerateSpecification,
  revokeSpecificationPublicLink,
  rotateSpecificationPublicLink,
  setSpecificationPackaging,
  setSpecificationVisibility,
  transitionSpecificationStatus,
  updateSpecification,
  type RefreshPricingResponseDto,
  type RegenerateSpecificationRequestDto,
} from "./api";
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

export const specificationsQueryKeys = {
  all: [...rootQueryKey, "specifications"] as const,
  // Stable prefix for every paginated list cache in the org —
  // ``invalidateQueries({ queryKey: infiniteAll(orgId) })`` blows
  // the cache for both the unfiltered list and any per-status
  // queue (e.g. the director's approvals inbox) in one call.
  infiniteAll: (orgId: string) =>
    [...specificationsQueryKeys.all, orgId, "infinite"] as const,
  infinite: (
    orgId: string,
    status?: string,
    search?: string,
    formulationId?: string,
  ) =>
    [
      ...specificationsQueryKeys.all,
      orgId,
      "infinite",
      status ?? "__any__",
      //: ``search`` becomes part of the cache key so different
      //: substrings each get their own paginated result set. Empty
      //: string is the "no filter" bucket.
      search ?? "",
      //: ``formulationId`` keys the per-project spec-sheets tab so it
      //: doesn't collide with the org-wide list cache.
      formulationId ?? "",
    ] as const,
  detail: (orgId: string, sheetId: string) =>
    [...specificationsQueryKeys.all, orgId, "detail", sheetId] as const,
  render: (orgId: string, sheetId: string) =>
    [...specificationsQueryKeys.all, orgId, "render", sheetId] as const,
  packagingOptions: (orgId: string, slot: string, search: string) =>
    [
      ...specificationsQueryKeys.all,
      orgId,
      "packaging-options",
      slot,
      search,
    ] as const,
} as const;

export function useInfiniteSpecifications(
  orgId: string,
  options: {
    pageSize?: number;
    initialFirstPage?: PaginatedSpecificationsDto | null;
    status?: string;
    search?: string;
    /** Optional per-project scope — drives the workspace Spec Sheets
     *  tab so it lists only sheets built against this project's
     *  versions. Wraps the same ``?formulation_id=`` filter the SSR
     *  seed uses so client-side pagination stays in lock-step. */
    formulationId?: string;
  } = {},
): UseInfiniteQueryResult<
  InfiniteData<PaginatedSpecificationsDto, string | null>,
  ApiError
> {
  const { pageSize, initialFirstPage, status, search, formulationId } =
    options;
  return useInfiniteQuery<
    PaginatedSpecificationsDto,
    ApiError,
    InfiniteData<PaginatedSpecificationsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: specificationsQueryKeys.infinite(
      orgId,
      status,
      search,
      formulationId,
    ),
    queryFn: ({ pageParam }) =>
      fetchSpecificationsPage(orgId, {
        pageSize,
        status,
        search,
        formulationId,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    initialData: initialFirstPage
      ? { pages: [initialFirstPage], pageParams: [null] }
      : undefined,
    // Skip the fetch when the caller has no org id — used by surfaces
    // (e.g. the approvals inbox) that gate the read on a capability
    // and pass an empty string when the member can't see this tab.
    enabled: Boolean(orgId),
  });
}

export function useSpecification(
  orgId: string,
  sheetId: string,
  options: { readonly initialData?: SpecificationSheetDto } = {},
): UseQueryResult<SpecificationSheetDto, ApiError> {
  return useQuery<SpecificationSheetDto, ApiError>({
    queryKey: specificationsQueryKeys.detail(orgId, sheetId),
    queryFn: () => fetchSpecification(orgId, sheetId),
    initialData: options.initialData,
  });
}

export function useRenderedSpecification(
  orgId: string,
  sheetId: string,
  options: { readonly initialData?: RenderedSheetContext } = {},
): UseQueryResult<RenderedSheetContext, ApiError> {
  return useQuery<RenderedSheetContext, ApiError>({
    queryKey: specificationsQueryKeys.render(orgId, sheetId),
    queryFn: () => fetchRenderedSpecification(orgId, sheetId),
    initialData: options.initialData,
  });
}

export function useCreateSpecification(
  orgId: string,
): UseMutationResult<
  SpecificationSheetDto,
  ApiError,
  CreateSpecificationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    SpecificationSheetDto,
    ApiError,
    CreateSpecificationRequestDto
  >({
    mutationFn: (payload) => createSpecification(orgId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
    },
  });
}

export function useUpdateSpecification(
  orgId: string,
  sheetId: string,
): UseMutationResult<
  SpecificationSheetDto,
  ApiError,
  UpdateSpecificationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    SpecificationSheetDto,
    ApiError,
    UpdateSpecificationRequestDto
  >({
    mutationFn: (payload) => updateSpecification(orgId, sheetId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
      // The rendered preview pulls a separate payload whose watermark
      // + body copy derive from mutable sheet fields (document_kind,
      // code, client info). Without this invalidation a Draft → Final
      // flip would leave the in-page preview watermarked until a
      // manual refresh.
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.render(orgId, sheetId),
      });
    },
  });
}

export function useRegenerateSpecification(
  orgId: string,
  sheetId: string,
): UseMutationResult<
  SpecificationSheetDto,
  ApiError,
  RegenerateSpecificationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    SpecificationSheetDto,
    ApiError,
    RegenerateSpecificationRequestDto
  >({
    mutationFn: (payload) =>
      regenerateSpecification(orgId, sheetId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        updated,
      );
      // Every derived section (actives, nutrition, allergens,
      // ingredients declaration, weight) re-derives against the
      // newly-pinned FormulationVersion, so the render cache has
      // to go too.
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.render(orgId, sheetId),
      });
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
    },
  });
}

/**
 * Recompute the sheet's ``unit_cost`` from the pinned version's
 * snapshot lines + current PSP prices. Rescue mutation for sheets
 * that landed with empty pricing (usually a PSP outage at create
 * time). Doesn't rebind the version, so scientist-typed overrides
 * on packaging / notes stay put.
 */
export function useRefreshSpecificationPricing(
  orgId: string,
  sheetId: string,
): UseMutationResult<RefreshPricingResponseDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<RefreshPricingResponseDto, ApiError, void>({
    mutationFn: () => refreshSpecificationPricing(orgId, sheetId),
    onSuccess: (result) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        result.sheet,
      );
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.render(orgId, sheetId),
      });
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
    },
  });
}

export function useDeleteSpecification(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (sheetId) => deleteSpecification(orgId, sheetId),
    onSuccess: (_, sheetId) => {
      queryClient.removeQueries({
        queryKey: specificationsQueryKeys.detail(orgId, sheetId),
      });
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
    },
  });
}

export interface UsePackagingOptionsArgs {
  readonly orgId: string;
  readonly slot: PackagingSlot;
  readonly search: string;
  readonly enabled?: boolean;
  readonly limit?: number;
}

/**
 * Server-side search against the packaging catalogue for a single
 * slot. Designed for the spec-sheet picker ComboBox: the caller
 * debounces ``search`` keystrokes and we round-trip for each stable
 * query. Results are cached per (slot, search) so arrow-key
 * re-hydration after a close/open feels instant, but the cache
 * goes stale fast (10s) so a catalogue edit on another tab
 * surfaces quickly.
 */
export function usePackagingOptions({
  orgId,
  slot,
  search,
  enabled = true,
  limit,
}: UsePackagingOptionsArgs): UseQueryResult<
  PackagingOptionsPageDto,
  ApiError
> {
  return useQuery<PackagingOptionsPageDto, ApiError>({
    queryKey: specificationsQueryKeys.packagingOptions(orgId, slot, search),
    queryFn: () => fetchPackagingOptions(orgId, { slot, search, limit }),
    enabled,
    staleTime: 10_000,
    // Keep the previous page's results in view while a new query
    // resolves so the ComboBox does not flash to "no options"
    // between keystrokes.
    placeholderData: (prev) => prev,
  });
}

export function useSetSpecificationPackaging(
  orgId: string,
  sheetId: string,
): UseMutationResult<
  SpecificationSheetDto,
  ApiError,
  SetPackagingRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<SpecificationSheetDto, ApiError, SetPackagingRequestDto>({
    mutationFn: (payload) =>
      setSpecificationPackaging(orgId, sheetId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.render(orgId, sheetId),
      });
    },
  });
}

export function useRotateSpecificationPublicLink(
  orgId: string,
  sheetId: string,
): UseMutationResult<SpecificationSheetDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<SpecificationSheetDto, ApiError, void>({
    mutationFn: () => rotateSpecificationPublicLink(orgId, sheetId),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        updated,
      );
    },
  });
}

export function useRevokeSpecificationPublicLink(
  orgId: string,
  sheetId: string,
): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () => revokeSpecificationPublicLink(orgId, sheetId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.detail(orgId, sheetId),
      });
    },
  });
}

export function useSetSpecificationVisibility(
  orgId: string,
  sheetId: string,
): UseMutationResult<
  RenderedSheetContext,
  ApiError,
  UpdateVisibilityRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    RenderedSheetContext,
    ApiError,
    UpdateVisibilityRequestDto
  >({
    mutationFn: (payload) =>
      setSpecificationVisibility(orgId, sheetId, payload),
    onSuccess: (rendered) => {
      queryClient.setQueryData(
        specificationsQueryKeys.render(orgId, sheetId),
        rendered,
      );
    },
  });
}


export function useTransitionSpecificationStatus(
  orgId: string,
  sheetId: string,
): UseMutationResult<
  SpecificationSheetDto,
  ApiError,
  TransitionStatusRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    SpecificationSheetDto,
    ApiError,
    TransitionStatusRequestDto
  >({
    mutationFn: (payload) =>
      transitionSpecificationStatus(orgId, sheetId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        specificationsQueryKeys.detail(orgId, sheetId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.render(orgId, sheetId),
      });
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infiniteAll(orgId),
      });
    },
  });
}
