/**
 * TanStack Query hooks for the formulations domain.
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
  computeFormulationTotals,
  createFormulation,
  deleteFormulation,
  fetchFormulation,
  fetchFormulationVersions,
  fetchFormulations,
  fetchFormulationsPage,
  replaceFormulationLines,
  rollbackFormulation,
  saveFormulationVersion,
  updateFormulation,
} from "./api";
import type {
  CreateFormulationRequestDto,
  FormulationDto,
  FormulationTotalsDto,
  FormulationVersionDto,
  PaginatedFormulationsDto,
  ReplaceLinesRequestDto,
  RollbackRequestDto,
  SaveVersionRequestDto,
  UpdateFormulationRequestDto,
} from "./types";

export const formulationsQueryKeys = {
  all: [...rootQueryKey, "formulations"] as const,
  list: (orgId: string) =>
    [...formulationsQueryKeys.all, orgId, "list"] as const,
  infinite: (orgId: string, opts: { ordering: string }) =>
    [
      ...formulationsQueryKeys.all,
      orgId,
      "infinite",
      opts.ordering,
    ] as const,
  detail: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "detail", formulationId] as const,
  totals: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "totals", formulationId] as const,
  versions: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "versions", formulationId] as const,
} as const;

export function useFormulations(
  orgId: string,
): UseQueryResult<FormulationDto[], ApiError> {
  return useQuery<FormulationDto[], ApiError>({
    queryKey: formulationsQueryKeys.list(orgId),
    queryFn: () => fetchFormulations(orgId),
  });
}

/**
 * Cursor-paginated infinite-scroll fetch for the formulations list.
 *
 * Mirrors :func:`useInfiniteItems` on the catalogues service: the
 * caller passes ordering + page size, and the hook re-keys on those
 * so switching filters starts a clean paged cache. ``initialFirstPage``
 * lets the server render hydrate the first page without an extra
 * round-trip after hydration.
 */
export function useInfiniteFormulations(
  orgId: string,
  options: {
    ordering: string;
    pageSize?: number;
    initialFirstPage?: PaginatedFormulationsDto | null;
  },
): UseInfiniteQueryResult<
  InfiniteData<PaginatedFormulationsDto, string | null>,
  ApiError
> {
  const { ordering, pageSize, initialFirstPage } = options;
  return useInfiniteQuery<
    PaginatedFormulationsDto,
    ApiError,
    InfiniteData<PaginatedFormulationsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: formulationsQueryKeys.infinite(orgId, { ordering }),
    queryFn: ({ pageParam }) =>
      fetchFormulationsPage(orgId, {
        ordering,
        pageSize,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    initialData: initialFirstPage
      ? {
          pages: [initialFirstPage],
          pageParams: [null],
        }
      : undefined,
  });
}

export function useFormulation(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationDto, ApiError> {
  return useQuery<FormulationDto, ApiError>({
    queryKey: formulationsQueryKeys.detail(orgId, formulationId),
    queryFn: () => fetchFormulation(orgId, formulationId),
  });
}

export function useFormulationTotals(
  orgId: string,
  formulationId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<FormulationTotalsDto, ApiError> {
  return useQuery<FormulationTotalsDto, ApiError>({
    queryKey: formulationsQueryKeys.totals(orgId, formulationId),
    queryFn: () => computeFormulationTotals(orgId, formulationId),
    enabled: options.enabled ?? true,
  });
}

export function useFormulationVersions(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationVersionDto[], ApiError> {
  return useQuery<FormulationVersionDto[], ApiError>({
    queryKey: formulationsQueryKeys.versions(orgId, formulationId),
    queryFn: () => fetchFormulationVersions(orgId, formulationId),
  });
}

export function useCreateFormulation(
  orgId: string,
): UseMutationResult<FormulationDto, ApiError, CreateFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, CreateFormulationRequestDto>({
    mutationFn: (payload) => createFormulation(orgId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}

export function useUpdateFormulation(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, UpdateFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, UpdateFormulationRequestDto>({
    mutationFn: (payload) => updateFormulation(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
    },
  });
}

export function useDeleteFormulation(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (formulationId) => deleteFormulation(orgId, formulationId),
    onSuccess: async (_, formulationId) => {
      queryClient.removeQueries({
        queryKey: formulationsQueryKeys.detail(orgId, formulationId),
      });
      await queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}

export function useReplaceLines(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, ReplaceLinesRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, ReplaceLinesRequestDto>({
    mutationFn: (payload) =>
      replaceFormulationLines(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
    },
  });
}

export function useSaveVersion(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  FormulationVersionDto,
  ApiError,
  SaveVersionRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<FormulationVersionDto, ApiError, SaveVersionRequestDto>({
    mutationFn: (payload) =>
      saveFormulationVersion(orgId, formulationId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, formulationId),
      });
    },
  });
}

export function useRollbackFormulation(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, RollbackRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, RollbackRequestDto>({
    mutationFn: (payload) =>
      rollbackFormulation(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, formulationId),
      });
    },
  });
}
