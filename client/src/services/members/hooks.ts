/**
 * TanStack Query hooks for the members-administration domain.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";

import {
  listMemberships,
  listModules,
  removeMembership,
  updateMembershipPermissions,
} from "./api";
import type {
  MembershipDto,
  ModuleDefinitionDto,
  UpdateMembershipPermissionsRequestDto,
} from "./types";


export const membersQueryKeys = {
  all: ["members"] as const,
  list: (orgId: string) => [...membersQueryKeys.all, "list", orgId] as const,
  modules: () => ["module-registry"] as const,
};


export function useMemberships(
  orgId: string,
  options: { readonly initialData?: readonly MembershipDto[] } = {},
): UseQueryResult<readonly MembershipDto[], ApiError> {
  return useQuery<readonly MembershipDto[], ApiError>({
    queryKey: membersQueryKeys.list(orgId),
    queryFn: () => listMemberships(orgId),
    initialData: options.initialData,
    staleTime: 10_000,
  });
}


export function useModules(
  options: { readonly initialData?: readonly ModuleDefinitionDto[] } = {},
): UseQueryResult<readonly ModuleDefinitionDto[], ApiError> {
  return useQuery<readonly ModuleDefinitionDto[], ApiError>({
    queryKey: membersQueryKeys.modules(),
    queryFn: listModules,
    initialData: options.initialData,
    // The registry is effectively static between deploys — cache
    // aggressively and let the SSR initial-data feed the first paint.
    staleTime: 5 * 60 * 1000,
  });
}


export function useUpdateMembershipPermissions(
  orgId: string,
): UseMutationResult<
  MembershipDto,
  ApiError,
  { membershipId: string; payload: UpdateMembershipPermissionsRequestDto }
> {
  const queryClient = useQueryClient();
  return useMutation<
    MembershipDto,
    ApiError,
    { membershipId: string; payload: UpdateMembershipPermissionsRequestDto }
  >({
    mutationFn: ({ membershipId, payload }) =>
      updateMembershipPermissions(orgId, membershipId, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: membersQueryKeys.list(orgId),
      }),
  });
}


export function useRemoveMembership(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (membershipId) => removeMembership(orgId, membershipId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: membersQueryKeys.list(orgId),
      }),
  });
}
