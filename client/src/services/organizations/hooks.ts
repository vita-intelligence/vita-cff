/**
 * TanStack Query hooks for the organizations domain.
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
  createOrganization,
  fetchOrganizations,
  updateOrganization,
  type UpdateOrganizationRequestDto,
} from "./api";
import type {
  CreateOrganizationRequestDto,
  CreateOrganizationResponseDto,
  OrganizationDto,
} from "./types";

export const organizationsQueryKeys = {
  all: [...rootQueryKey, "organizations"] as const,
  list: () => [...organizationsQueryKeys.all, "list"] as const,
} as const;

export function useOrganizations(
  options: { enabled?: boolean } = {},
): UseQueryResult<OrganizationDto[], ApiError> {
  return useQuery<OrganizationDto[], ApiError>({
    queryKey: organizationsQueryKeys.list(),
    queryFn: fetchOrganizations,
    enabled: options.enabled ?? true,
  });
}

/**
 * Pick one organization out of the cached list by id.
 *
 * Reads from the same query cache key as :func:`useOrganizations`
 * so a page that's already loaded the org list never fires a
 * second request — the SSR seed primes the cache. Returns
 * ``undefined`` while the list is still loading; the caller is
 * expected to treat the undefined window the same way it would
 * treat a missing flag (default to safe-off behaviour).
 *
 * Use this to read org-level booleans (``dynamics_customers_managed``,
 * ``is_owner``, …) from deeply-nested client components without
 * threading the org prop through every layer.
 */
export function useOrganization(
  orgId: string,
): OrganizationDto | undefined {
  const list = useOrganizations();
  return list.data?.find((org) => org.id === orgId);
}

export function useCreateOrganization(): UseMutationResult<
  CreateOrganizationResponseDto,
  ApiError,
  CreateOrganizationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    CreateOrganizationResponseDto,
    ApiError,
    CreateOrganizationRequestDto
  >({
    mutationFn: createOrganization,
    onSuccess: (organization) => {
      // Prime the cache with the new row and invalidate the list query so
      // the home page picks up the change on the next render.
      queryClient.setQueryData<OrganizationDto[]>(
        organizationsQueryKeys.list(),
        (prev) => (prev ? [...prev, organization] : [organization]),
      );
      queryClient.invalidateQueries({
        queryKey: organizationsQueryKeys.list(),
      });
    },
  });
}


export function useUpdateOrganization(
  orgId: string,
): UseMutationResult<OrganizationDto, ApiError, UpdateOrganizationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<OrganizationDto, ApiError, UpdateOrganizationRequestDto>({
    mutationFn: (payload) => updateOrganization(orgId, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: organizationsQueryKeys.list(),
      }),
  });
}
