/**
 * TanStack Query hooks for the trial-batches domain.
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
  createTrialBatch,
  deleteTrialBatch,
  fetchTrialBatch,
  fetchTrialBatchRender,
  fetchTrialBatches,
  updateTrialBatch,
} from "./api";
import type {
  BOMResult,
  CreateTrialBatchRequestDto,
  TrialBatchDto,
  UpdateTrialBatchRequestDto,
} from "./types";

export const trialBatchesQueryKeys = {
  all: [...rootQueryKey, "trial-batches"] as const,
  byFormulation: (orgId: string, formulationId: string) =>
    [
      ...trialBatchesQueryKeys.all,
      orgId,
      "by-formulation",
      formulationId,
    ] as const,
  detail: (orgId: string, batchId: string) =>
    [...trialBatchesQueryKeys.all, orgId, "detail", batchId] as const,
  render: (orgId: string, batchId: string) =>
    [...trialBatchesQueryKeys.all, orgId, "render", batchId] as const,
} as const;

export function useTrialBatches(
  orgId: string,
  formulationId: string,
  options: { initialData?: readonly TrialBatchDto[] } = {},
): UseQueryResult<readonly TrialBatchDto[], ApiError> {
  return useQuery<readonly TrialBatchDto[], ApiError>({
    queryKey: trialBatchesQueryKeys.byFormulation(orgId, formulationId),
    queryFn: () => fetchTrialBatches(orgId, formulationId),
    initialData: options.initialData,
  });
}

export function useTrialBatch(
  orgId: string,
  batchId: string,
): UseQueryResult<TrialBatchDto, ApiError> {
  return useQuery<TrialBatchDto, ApiError>({
    queryKey: trialBatchesQueryKeys.detail(orgId, batchId),
    queryFn: () => fetchTrialBatch(orgId, batchId),
  });
}

export function useTrialBatchRender(
  orgId: string,
  batchId: string,
): UseQueryResult<BOMResult, ApiError> {
  return useQuery<BOMResult, ApiError>({
    queryKey: trialBatchesQueryKeys.render(orgId, batchId),
    queryFn: () => fetchTrialBatchRender(orgId, batchId),
  });
}

export function useCreateTrialBatch(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  TrialBatchDto,
  ApiError,
  CreateTrialBatchRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<TrialBatchDto, ApiError, CreateTrialBatchRequestDto>({
    mutationFn: (payload) =>
      createTrialBatch(orgId, formulationId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.byFormulation(orgId, formulationId),
      });
    },
  });
}

export function useUpdateTrialBatch(
  orgId: string,
  batchId: string,
): UseMutationResult<
  TrialBatchDto,
  ApiError,
  UpdateTrialBatchRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<TrialBatchDto, ApiError, UpdateTrialBatchRequestDto>({
    mutationFn: (payload) => updateTrialBatch(orgId, batchId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        trialBatchesQueryKeys.detail(orgId, batchId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.render(orgId, batchId),
      });
    },
  });
}

export function useDeleteTrialBatch(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (batchId) => deleteTrialBatch(orgId, batchId),
    onSuccess: async (_, batchId) => {
      queryClient.removeQueries({
        queryKey: trialBatchesQueryKeys.detail(orgId, batchId),
      });
      queryClient.removeQueries({
        queryKey: trialBatchesQueryKeys.render(orgId, batchId),
      });
      // Invalidate every by-formulation list in the org — we do not
      // know from the batchId alone which formulation it belonged to.
      await queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.all,
      });
    },
  });
}
