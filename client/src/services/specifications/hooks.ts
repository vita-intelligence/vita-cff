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
  fetchRenderedSpecification,
  fetchSpecification,
  fetchSpecificationsPage,
  transitionSpecificationStatus,
  updateSpecification,
} from "./api";
import type {
  CreateSpecificationRequestDto,
  PaginatedSpecificationsDto,
  RenderedSheetContext,
  SpecificationSheetDto,
  TransitionStatusRequestDto,
  UpdateSpecificationRequestDto,
} from "./types";

export const specificationsQueryKeys = {
  all: [...rootQueryKey, "specifications"] as const,
  infinite: (orgId: string) =>
    [...specificationsQueryKeys.all, orgId, "infinite"] as const,
  detail: (orgId: string, sheetId: string) =>
    [...specificationsQueryKeys.all, orgId, "detail", sheetId] as const,
  render: (orgId: string, sheetId: string) =>
    [...specificationsQueryKeys.all, orgId, "render", sheetId] as const,
} as const;

export function useInfiniteSpecifications(
  orgId: string,
  options: {
    pageSize?: number;
    initialFirstPage?: PaginatedSpecificationsDto | null;
  } = {},
): UseInfiniteQueryResult<
  InfiniteData<PaginatedSpecificationsDto, string | null>,
  ApiError
> {
  const { pageSize, initialFirstPage } = options;
  return useInfiniteQuery<
    PaginatedSpecificationsDto,
    ApiError,
    InfiniteData<PaginatedSpecificationsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: specificationsQueryKeys.infinite(orgId),
    queryFn: ({ pageParam }) =>
      fetchSpecificationsPage(orgId, {
        pageSize,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    initialData: initialFirstPage
      ? { pages: [initialFirstPage], pageParams: [null] }
      : undefined,
  });
}

export function useSpecification(
  orgId: string,
  sheetId: string,
): UseQueryResult<SpecificationSheetDto, ApiError> {
  return useQuery<SpecificationSheetDto, ApiError>({
    queryKey: specificationsQueryKeys.detail(orgId, sheetId),
    queryFn: () => fetchSpecification(orgId, sheetId),
  });
}

export function useRenderedSpecification(
  orgId: string,
  sheetId: string,
): UseQueryResult<RenderedSheetContext, ApiError> {
  return useQuery<RenderedSheetContext, ApiError>({
    queryKey: specificationsQueryKeys.render(orgId, sheetId),
    queryFn: () => fetchRenderedSpecification(orgId, sheetId),
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infinite(orgId),
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
        queryKey: specificationsQueryKeys.infinite(orgId),
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
    onSuccess: async (_, sheetId) => {
      queryClient.removeQueries({
        queryKey: specificationsQueryKeys.detail(orgId, sheetId),
      });
      await queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.infinite(orgId),
      });
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
        queryKey: specificationsQueryKeys.infinite(orgId),
      });
    },
  });
}
