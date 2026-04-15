/**
 * TanStack Query hooks for the attributes domain.
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
  archiveAttributeDefinition,
  createAttributeDefinition,
  fetchAttributeDefinitions,
  updateAttributeDefinition,
} from "./api";
import type {
  AttributeDefinitionDto,
  CreateAttributeDefinitionRequestDto,
  UpdateAttributeDefinitionRequestDto,
} from "./types";

export const attributesQueryKeys = {
  all: [...rootQueryKey, "attributes"] as const,
  list: (orgId: string, slug: string, includeArchived: boolean) =>
    [
      ...attributesQueryKeys.all,
      orgId,
      slug,
      includeArchived ? "with-archived" : "active",
    ] as const,
} as const;

export function useAttributeDefinitions(
  orgId: string,
  slug: string,
  options: { includeArchived?: boolean } = {},
): UseQueryResult<AttributeDefinitionDto[], ApiError> {
  const includeArchived = options.includeArchived ?? false;
  return useQuery<AttributeDefinitionDto[], ApiError>({
    queryKey: attributesQueryKeys.list(orgId, slug, includeArchived),
    queryFn: () =>
      fetchAttributeDefinitions(orgId, slug, { includeArchived }),
  });
}

export function useCreateAttributeDefinition(
  orgId: string,
  slug: string,
): UseMutationResult<
  AttributeDefinitionDto,
  ApiError,
  CreateAttributeDefinitionRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    AttributeDefinitionDto,
    ApiError,
    CreateAttributeDefinitionRequestDto
  >({
    mutationFn: (payload) => createAttributeDefinition(orgId, slug, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: attributesQueryKeys.all,
      });
    },
  });
}

export function useUpdateAttributeDefinition(
  orgId: string,
  slug: string,
  definitionId: string,
): UseMutationResult<
  AttributeDefinitionDto,
  ApiError,
  UpdateAttributeDefinitionRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    AttributeDefinitionDto,
    ApiError,
    UpdateAttributeDefinitionRequestDto
  >({
    mutationFn: (payload) =>
      updateAttributeDefinition(orgId, slug, definitionId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: attributesQueryKeys.all,
      });
    },
  });
}

export function useArchiveAttributeDefinition(
  orgId: string,
  slug: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (definitionId) =>
      archiveAttributeDefinition(orgId, slug, definitionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: attributesQueryKeys.all,
      });
    },
  });
}
