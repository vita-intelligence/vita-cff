/**
 * TanStack Query hooks for the CFF submissions domain.
 *
 * Every component consumes these hooks — never the raw API
 * functions — so caching, invalidation, and loading states stay
 * consistent across the app.
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
  assignCFFToProject,
  clearWixCFFConfig,
  createProjectFromCFF,
  fetchCFFFieldLabels,
  fetchCFFSubmissionsPage,
  fetchCFFSyncStatus,
  fetchWixCFFConfig,
  saveWixCFFConfig,
  testWixCFFConnection,
  unassignCFF,
  type FetchCFFSubmissionsPageOptions,
} from "./api";
import type {
  CFFFieldLabelsDto,
  CFFSubmissionDto,
  CFFSyncStatusDto,
  CreateProjectFromCFFRequestDto,
  CreateProjectFromCFFResponseDto,
  PaginatedCFFSubmissionsDto,
  SaveWixCFFConfigRequestDto,
  WixCFFConfigDto,
} from "./types";


export const cffQueryKeys = {
  all: [...rootQueryKey, "cff"] as const,
  list: (
    orgId: string,
    filters: Pick<
      FetchCFFSubmissionsPageOptions,
      "assigned" | "search" | "projectId" | "pageSize"
    >,
  ) =>
    [
      ...cffQueryKeys.all,
      orgId,
      "list",
      {
        assigned: filters.assigned ?? null,
        search: filters.search ?? "",
        projectId: filters.projectId ?? null,
        pageSize: filters.pageSize ?? null,
      },
    ] as const,
  fieldLabels: (orgId: string) =>
    [...cffQueryKeys.all, orgId, "field-labels"] as const,
  config: (orgId: string) =>
    [...cffQueryKeys.all, orgId, "integration"] as const,
  syncStatus: (orgId: string) =>
    [...cffQueryKeys.all, orgId, "sync-status"] as const,
} as const;


// ---------------------------------------------------------------------------
// List (infinite query)
// ---------------------------------------------------------------------------


export interface UseInfiniteCFFArgs {
  readonly orgId: string;
  readonly assigned?: boolean;
  readonly search?: string;
  readonly projectId?: string;
  readonly pageSize?: number;
  readonly enabled?: boolean;
}


export function useInfiniteCFFSubmissions(
  args: UseInfiniteCFFArgs,
): UseInfiniteQueryResult<
  InfiniteData<PaginatedCFFSubmissionsDto, string | null>,
  ApiError
> {
  const queryClient = useQueryClient();
  return useInfiniteQuery<
    PaginatedCFFSubmissionsDto,
    ApiError,
    InfiniteData<PaginatedCFFSubmissionsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: cffQueryKeys.list(args.orgId, {
      assigned: args.assigned,
      search: args.search,
      projectId: args.projectId,
      pageSize: args.pageSize,
    }),
    queryFn: async ({ pageParam }) => {
      const page = await fetchCFFSubmissionsPage(args.orgId, {
        cursorUrl: pageParam ?? undefined,
        assigned: args.assigned,
        search: args.search,
        projectId: args.projectId,
        pageSize: args.pageSize,
      });
      // The list endpoint embeds the just-completed lazy-poll
      // timestamp so the banner stays coherent with the rows.
      // Hydrate the sync-status cache directly so the banner
      // re-renders without a follow-up HTTP roundtrip; the
      // 1-minute interval refetch on ``useCFFSyncStatus`` would
      // otherwise leave the banner stale for up to a minute.
      if (page.sync) {
        queryClient.setQueryData<CFFSyncStatusDto>(
          cffQueryKeys.syncStatus(args.orgId),
          page.sync,
        );
      }
      return page;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    enabled: args.enabled ?? true,
    refetchOnWindowFocus: true,
  });
}


export function useCFFFieldLabels(
  orgId: string,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<CFFFieldLabelsDto, ApiError> {
  return useQuery<CFFFieldLabelsDto, ApiError>({
    queryKey: cffQueryKeys.fieldLabels(orgId),
    queryFn: () => fetchCFFFieldLabels(orgId),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}


/** Sync-status hook backing the inbox "last sync: X ago" banner.
 *  Auto-refetches every minute so the relative-time copy stays
 *  honest while the user has the inbox open. */
export function useCFFSyncStatus(
  orgId: string,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<CFFSyncStatusDto, ApiError> {
  return useQuery<CFFSyncStatusDto, ApiError>({
    queryKey: cffQueryKeys.syncStatus(orgId),
    queryFn: () => fetchCFFSyncStatus(orgId),
    enabled: options.enabled ?? true,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}


// ---------------------------------------------------------------------------
// Assign / unassign mutations
// ---------------------------------------------------------------------------


interface AssignVars {
  readonly submissionId: string;
  readonly projectId: string;
}


export function useAssignCFFToProject(
  orgId: string,
): UseMutationResult<CFFSubmissionDto, ApiError, AssignVars> {
  const queryClient = useQueryClient();
  return useMutation<CFFSubmissionDto, ApiError, AssignVars>({
    mutationFn: ({ submissionId, projectId }) =>
      assignCFFToProject(orgId, submissionId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...cffQueryKeys.all, orgId, "list"],
      });
    },
  });
}


interface UnassignVars {
  readonly submissionId: string;
}


export function useUnassignCFF(
  orgId: string,
): UseMutationResult<CFFSubmissionDto, ApiError, UnassignVars> {
  const queryClient = useQueryClient();
  return useMutation<CFFSubmissionDto, ApiError, UnassignVars>({
    mutationFn: ({ submissionId }) => unassignCFF(orgId, submissionId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...cffQueryKeys.all, orgId, "list"],
      });
    },
  });
}


interface CreateProjectVars {
  readonly submissionId: string;
  readonly payload: CreateProjectFromCFFRequestDto;
}


export function useCreateProjectFromCFF(
  orgId: string,
): UseMutationResult<
  CreateProjectFromCFFResponseDto,
  ApiError,
  CreateProjectVars
> {
  const queryClient = useQueryClient();
  return useMutation<
    CreateProjectFromCFFResponseDto,
    ApiError,
    CreateProjectVars
  >({
    mutationFn: ({ submissionId, payload }) =>
      createProjectFromCFF(orgId, submissionId, payload),
    onSuccess: () => {
      // Invalidate the CFF list (so the row now shows as assigned)
      // AND the formulations list (so the new project shows up
      // there too). The proposals queue inherits the sales person
      // from the project at render-time, no separate invalidate.
      queryClient.invalidateQueries({
        queryKey: [...cffQueryKeys.all, orgId, "list"],
      });
      queryClient.invalidateQueries({
        queryKey: ["formulations", orgId],
        exact: false,
      });
    },
  });
}


// ---------------------------------------------------------------------------
// Integration settings
// ---------------------------------------------------------------------------


export function useWixCFFConfig(
  orgId: string,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<WixCFFConfigDto, ApiError> {
  return useQuery<WixCFFConfigDto, ApiError>({
    queryKey: cffQueryKeys.config(orgId),
    queryFn: () => fetchWixCFFConfig(orgId),
    enabled: options.enabled ?? true,
  });
}


export function useSaveWixCFFConfig(
  orgId: string,
): UseMutationResult<
  WixCFFConfigDto,
  ApiError,
  SaveWixCFFConfigRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    WixCFFConfigDto,
    ApiError,
    SaveWixCFFConfigRequestDto
  >({
    mutationFn: (payload) => saveWixCFFConfig(orgId, payload),
    onSuccess: (config) => {
      queryClient.setQueryData<WixCFFConfigDto>(
        cffQueryKeys.config(orgId),
        config,
      );
    },
  });
}


export function useClearWixCFFConfig(
  orgId: string,
): UseMutationResult<WixCFFConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<WixCFFConfigDto, ApiError, void>({
    mutationFn: () => clearWixCFFConfig(orgId),
    onSuccess: (config) => {
      queryClient.setQueryData<WixCFFConfigDto>(
        cffQueryKeys.config(orgId),
        config,
      );
    },
  });
}


export function useTestWixCFFConnection(
  orgId: string,
): UseMutationResult<WixCFFConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<WixCFFConfigDto, ApiError, void>({
    mutationFn: () => testWixCFFConnection(orgId),
    onSuccess: (config) => {
      queryClient.setQueryData<WixCFFConfigDto>(
        cffQueryKeys.config(orgId),
        config,
      );
    },
  });
}
