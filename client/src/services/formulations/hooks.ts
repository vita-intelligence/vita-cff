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
  assignFormulationSalesPerson,
  cloneFormulation,
  computeFormulationTotals,
  createFormulation,
  deleteFormulation,
  fetchFormulation,
  fetchFormulationVersions,
  fetchFormulations,
  fetchFormulationsPage,
  fetchProjectOverview,
  replaceFormulationLines,
  rollbackFormulation,
  saveFormulationVersion,
  setApprovedVersion,
  updateFormulation,
} from "./api";
import type {
  AssignSalesPersonRequestDto,
  CloneFormulationRequestDto,
  CreateFormulationRequestDto,
  FormulationDto,
  FormulationTotalsDto,
  FormulationVersionDto,
  PaginatedFormulationsDto,
  ProjectOverviewDto,
  ReplaceLinesRequestDto,
  RollbackRequestDto,
  SaveVersionRequestDto,
  UpdateFormulationRequestDto,
} from "./types";

export const formulationsQueryKeys = {
  all: [...rootQueryKey, "formulations"] as const,
  list: (orgId: string) =>
    [...formulationsQueryKeys.all, orgId, "list"] as const,
  infinite: (
    orgId: string,
    opts: {
      ordering: string;
      search?: string;
      hasOpenProposal?: boolean;
    },
  ) =>
    [
      ...formulationsQueryKeys.all,
      orgId,
      "infinite",
      opts.ordering,
      opts.search ?? "",
      // Encode the tri-state explicitly so ``undefined`` (no filter)
      // and ``false`` (filter applied, only eligible projects) live
      // in different cache slots.
      opts.hasOpenProposal === undefined
        ? "any"
        : opts.hasOpenProposal
          ? "open"
          : "free",
    ] as const,
  detail: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "detail", formulationId] as const,
  totals: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "totals", formulationId] as const,
  versions: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "versions", formulationId] as const,
  overview: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "overview", formulationId] as const,
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
    search?: string;
    /** When set, the backend filters on whether the formulation has
     *  at least one non-terminal proposal attached. ``false`` =
     *  "only formulations free of open proposals" (used by the new-
     *  proposal modal); ``true`` = the inverse; omitted = no
     *  filter. */
    hasOpenProposal?: boolean;
    initialFirstPage?: PaginatedFormulationsDto | null;
  },
): UseInfiniteQueryResult<
  InfiniteData<PaginatedFormulationsDto, string | null>,
  ApiError
> {
  const { ordering, pageSize, search, hasOpenProposal, initialFirstPage } =
    options;
  const normalisedSearch = search?.trim() ?? "";
  return useInfiniteQuery<
    PaginatedFormulationsDto,
    ApiError,
    InfiniteData<PaginatedFormulationsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    // ``hasOpenProposal`` is part of the cache key so switching
    // filters (e.g. opening the proposal modal vs. the projects list)
    // doesn't reuse the wrong cached page.
    queryKey: formulationsQueryKeys.infinite(orgId, {
      ordering,
      search: normalisedSearch,
      hasOpenProposal,
    }),
    queryFn: ({ pageParam }) =>
      fetchFormulationsPage(orgId, {
        ordering,
        pageSize,
        search: normalisedSearch || undefined,
        hasOpenProposal,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    // SSR hydration is unfiltered, so only seed the cache when no
    // search term is active — otherwise the first page would echo
    // every project, then snap to the filtered set after the
    // client-side fetch resolves.
    initialData:
      initialFirstPage && !normalisedSearch
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

export function useProjectOverview(
  orgId: string,
  formulationId: string,
  options: { initialData?: ProjectOverviewDto } = {},
): UseQueryResult<ProjectOverviewDto, ApiError> {
  return useQuery<ProjectOverviewDto, ApiError>({
    queryKey: formulationsQueryKeys.overview(orgId, formulationId),
    queryFn: () => fetchProjectOverview(orgId, formulationId),
    initialData: options.initialData,
    // Overview aggregates many child tables — refetch on mount so a
    // freshly-saved batch / version lands immediately on the
    // dashboard without waiting for a tab switch.
    refetchOnMount: "always",
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
      // The project-overview card reads ``code`` / ``name`` /
      // ``description`` off a separate query, so an edit through
      // this mutation must kick it too — otherwise the header
      // keeps printing the stale code until a full refetch.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
    },
  });
}

export function useAssignSalesPerson(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, AssignSalesPersonRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, AssignSalesPersonRequestDto>({
    mutationFn: (payload) =>
      assignFormulationSalesPerson(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      // The overview card shows the sales person too, so kick that
      // cache as well. Totals are unaffected — leave them alone.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
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

/**
 * Duplicate a formulation's recipe — either into a brand-new project
 * or onto an existing one. The mutation invalidates the list (so a
 * "new" mode result appears in /formulations) and, for a "replace"
 * result, also kicks the target's detail / overview / totals /
 * versions caches so the builder repaints with the cloned recipe
 * without a hard refresh.
 */
export function useCloneFormulation(
  orgId: string,
  sourceFormulationId: string,
): UseMutationResult<FormulationDto, ApiError, CloneFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, CloneFormulationRequestDto>({
    mutationFn: (payload) =>
      cloneFormulation(orgId, sourceFormulationId, payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
      // ``result`` is the new (mode=new) or updated (mode=replace)
      // formulation. Either way, kicking its caches ensures the
      // builder we redirect to renders the fresh recipe rather than
      // any stale per-id cache.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.detail(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, result.id),
      });
    },
  });
}

/** Mark a specific version as the current approved recipe, or
 *  clear the pointer by passing ``null``. The backend requires the
 *  ``formulations.approve`` capability — the button surfaces a
 *  friendly ``forbidden`` message when that's missing. */
export function useSetApprovedVersion(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, number | null> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, number | null>({
    mutationFn: (versionNumber) =>
      setApprovedVersion(orgId, formulationId, versionNumber),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
    },
  });
}
