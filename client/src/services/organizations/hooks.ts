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

import { createOrganization, fetchOrganizations } from "./api";
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
    onSuccess: async (organization) => {
      // Prime the cache with the new row and invalidate the list query so
      // the home page picks up the change on the next render.
      queryClient.setQueryData<OrganizationDto[]>(
        organizationsQueryKeys.list(),
        (prev) => (prev ? [...prev, organization] : [organization]),
      );
      await queryClient.invalidateQueries({
        queryKey: organizationsQueryKeys.list(),
      });
    },
  });
}
