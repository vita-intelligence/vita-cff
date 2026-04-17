/**
 * TanStack Query hooks for the product-validation domain.
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
  createValidation,
  deleteValidation,
  fetchValidation,
  fetchValidationForBatch,
  fetchValidationStats,
  transitionValidationStatus,
  updateValidation,
} from "./api";
import type {
  CreateValidationRequestDto,
  ProductValidationDto,
  TransitionValidationRequestDto,
  UpdateValidationRequestDto,
  ValidationStatsDto,
} from "./types";

export const productValidationQueryKeys = {
  all: [...rootQueryKey, "product-validations"] as const,
  detail: (orgId: string, validationId: string) =>
    [
      ...productValidationQueryKeys.all,
      orgId,
      "detail",
      validationId,
    ] as const,
  stats: (orgId: string, validationId: string) =>
    [...productValidationQueryKeys.all, orgId, "stats", validationId] as const,
  forBatch: (orgId: string, batchId: string) =>
    [
      ...productValidationQueryKeys.all,
      orgId,
      "for-batch",
      batchId,
    ] as const,
} as const;

export function useValidation(
  orgId: string,
  validationId: string,
): UseQueryResult<ProductValidationDto, ApiError> {
  return useQuery<ProductValidationDto, ApiError>({
    queryKey: productValidationQueryKeys.detail(orgId, validationId),
    queryFn: () => fetchValidation(orgId, validationId),
  });
}

export function useValidationStats(
  orgId: string,
  validationId: string,
): UseQueryResult<ValidationStatsDto, ApiError> {
  return useQuery<ValidationStatsDto, ApiError>({
    queryKey: productValidationQueryKeys.stats(orgId, validationId),
    queryFn: () => fetchValidationStats(orgId, validationId),
  });
}

export function useValidationForBatch(
  orgId: string,
  batchId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ProductValidationDto | null, ApiError> {
  return useQuery<ProductValidationDto | null, ApiError>({
    queryKey: productValidationQueryKeys.forBatch(orgId, batchId),
    queryFn: () => fetchValidationForBatch(orgId, batchId),
    enabled: options.enabled ?? true,
  });
}

export function useCreateValidation(
  orgId: string,
): UseMutationResult<
  ProductValidationDto,
  ApiError,
  CreateValidationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProductValidationDto,
    ApiError,
    CreateValidationRequestDto
  >({
    mutationFn: (payload) => createValidation(orgId, payload),
    onSuccess: async (created) => {
      queryClient.setQueryData(
        productValidationQueryKeys.detail(orgId, created.id),
        created,
      );
      await queryClient.invalidateQueries({
        queryKey: productValidationQueryKeys.forBatch(
          orgId,
          created.trial_batch_id,
        ),
      });
    },
  });
}

export function useUpdateValidation(
  orgId: string,
  validationId: string,
): UseMutationResult<
  ProductValidationDto,
  ApiError,
  UpdateValidationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProductValidationDto,
    ApiError,
    UpdateValidationRequestDto
  >({
    mutationFn: (payload) => updateValidation(orgId, validationId, payload),
    onSuccess: async (updated) => {
      queryClient.setQueryData(
        productValidationQueryKeys.detail(orgId, validationId),
        updated,
      );
      await queryClient.invalidateQueries({
        queryKey: productValidationQueryKeys.stats(orgId, validationId),
      });
    },
  });
}

export function useTransitionValidationStatus(
  orgId: string,
  validationId: string,
): UseMutationResult<
  ProductValidationDto,
  ApiError,
  TransitionValidationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProductValidationDto,
    ApiError,
    TransitionValidationRequestDto
  >({
    mutationFn: (payload) =>
      transitionValidationStatus(orgId, validationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        productValidationQueryKeys.detail(orgId, validationId),
        updated,
      );
    },
  });
}

export function useDeleteValidation(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (validationId) => deleteValidation(orgId, validationId),
    onSuccess: async (_, validationId) => {
      queryClient.removeQueries({
        queryKey: productValidationQueryKeys.detail(orgId, validationId),
      });
      queryClient.removeQueries({
        queryKey: productValidationQueryKeys.stats(orgId, validationId),
      });
      await queryClient.invalidateQueries({
        queryKey: productValidationQueryKeys.all,
      });
    },
  });
}
