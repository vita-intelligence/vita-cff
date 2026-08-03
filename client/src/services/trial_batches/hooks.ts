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
  createTrialBatchPspMo,
  deleteTrialBatch,
  fetchTrialBatch,
  fetchTrialBatchPspMoBookings,
  fetchTrialBatchPspMoChain,
  fetchTrialBatchRender,
  fetchTrialBatches,
  updateTrialBatch,
} from "./api";
import type {
  BOMResult,
  CreateTrialBatchPspMoRequestDto,
  CreateTrialBatchPspMoResponseDto,
  CreateTrialBatchRequestDto,
  PspTrialMoBookingsResponseDto,
  PspTrialMoChainResponseDto,
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
  pspMoBookings: (orgId: string, batchId: string) =>
    [
      ...trialBatchesQueryKeys.all,
      orgId,
      "psp-mo-bookings",
      batchId,
    ] as const,
  pspMoChain: (orgId: string, batchId: string) =>
    [
      ...trialBatchesQueryKeys.all,
      orgId,
      "psp-mo-chain",
      batchId,
    ] as const,
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
    onSuccess: () => {
      queryClient.invalidateQueries({
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

export function useCreateTrialBatchPspMo(
  orgId: string,
  batchId: string,
): UseMutationResult<
  CreateTrialBatchPspMoResponseDto,
  ApiError,
  CreateTrialBatchPspMoRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    CreateTrialBatchPspMoResponseDto,
    ApiError,
    CreateTrialBatchPspMoRequestDto
  >({
    mutationFn: (payload) =>
      createTrialBatchPspMo(orgId, batchId, payload),
    onSuccess: (response) => {
      // Prime the detail cache with the fresh row so the toolbar
      // chip flips from "Create MO" to "MO: <status>" without a
      // roundtrip.
      queryClient.setQueryData(
        trialBatchesQueryKeys.detail(orgId, batchId),
        response.trial_batch,
      );
      queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.pspMoBookings(orgId, batchId),
      });
      // Chain query drives the "linked-vs-create-new" gate on the
      // toolbar. On a retry after a cancelled MO the cached chain
      // still reports ``cancelled`` and the button stays labelled
      // "Create new MO" until the next 20s poll tick. Invalidating
      // here flips the toolbar to the "linked MO" chip immediately.
      queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.pspMoChain(orgId, batchId),
      });
      // Overview + render caches carry the linked-MO status too
      // (QC-tab gate, activity row). Invalidate so the whole page
      // reflects the new run without a manual refresh.
      queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.render(orgId, batchId),
      });
    },
  });
}

export function useTrialBatchPspMoBookings(
  orgId: string,
  batchId: string,
  options: { enabled?: boolean; refetchInterval?: number } = {},
): UseQueryResult<PspTrialMoBookingsResponseDto, ApiError> {
  return useQuery<PspTrialMoBookingsResponseDto, ApiError>({
    queryKey: trialBatchesQueryKeys.pspMoBookings(orgId, batchId),
    queryFn: () => fetchTrialBatchPspMoBookings(orgId, batchId),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
  });
}

export function useTrialBatchPspMoChain(
  orgId: string,
  batchId: string,
  options: { enabled?: boolean; refetchInterval?: number } = {},
): UseQueryResult<PspTrialMoChainResponseDto, ApiError> {
  return useQuery<PspTrialMoChainResponseDto, ApiError>({
    queryKey: trialBatchesQueryKeys.pspMoChain(orgId, batchId),
    queryFn: () => fetchTrialBatchPspMoChain(orgId, batchId),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
  });
}

export function useDeleteTrialBatch(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (batchId) => deleteTrialBatch(orgId, batchId),
    onSuccess: (_, batchId) => {
      queryClient.removeQueries({
        queryKey: trialBatchesQueryKeys.detail(orgId, batchId),
      });
      queryClient.removeQueries({
        queryKey: trialBatchesQueryKeys.render(orgId, batchId),
      });
      // Invalidate every by-formulation list in the org — we do not
      // know from the batchId alone which formulation it belonged to.
      queryClient.invalidateQueries({
        queryKey: trialBatchesQueryKeys.all,
      });
    },
  });
}
