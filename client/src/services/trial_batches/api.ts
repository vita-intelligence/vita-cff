/**
 * Raw Axios calls for the trial-batches domain.
 */

import { apiClient } from "@/lib/api";

import { trialBatchesEndpoints } from "./endpoints";
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

export async function fetchTrialBatches(
  orgId: string,
  formulationId: string,
): Promise<readonly TrialBatchDto[]> {
  const { data } = await apiClient.get<readonly TrialBatchDto[]>(
    trialBatchesEndpoints.list(orgId, formulationId),
  );
  return data;
}

export async function fetchTrialBatch(
  orgId: string,
  batchId: string,
): Promise<TrialBatchDto> {
  const { data } = await apiClient.get<TrialBatchDto>(
    trialBatchesEndpoints.detail(orgId, batchId),
  );
  return data;
}

export async function fetchTrialBatchRender(
  orgId: string,
  batchId: string,
): Promise<BOMResult> {
  const { data } = await apiClient.get<BOMResult>(
    trialBatchesEndpoints.render(orgId, batchId),
  );
  return data;
}

export async function createTrialBatch(
  orgId: string,
  formulationId: string,
  payload: CreateTrialBatchRequestDto,
): Promise<TrialBatchDto> {
  const { data } = await apiClient.post<TrialBatchDto>(
    trialBatchesEndpoints.list(orgId, formulationId),
    payload,
  );
  return data;
}

export async function updateTrialBatch(
  orgId: string,
  batchId: string,
  payload: UpdateTrialBatchRequestDto,
): Promise<TrialBatchDto> {
  const { data } = await apiClient.patch<TrialBatchDto>(
    trialBatchesEndpoints.detail(orgId, batchId),
    payload,
  );
  return data;
}

export async function deleteTrialBatch(
  orgId: string,
  batchId: string,
): Promise<void> {
  await apiClient.delete(trialBatchesEndpoints.detail(orgId, batchId));
}

export async function createTrialBatchPspMo(
  orgId: string,
  batchId: string,
  payload: CreateTrialBatchPspMoRequestDto,
): Promise<CreateTrialBatchPspMoResponseDto> {
  const { data } = await apiClient.post<CreateTrialBatchPspMoResponseDto>(
    trialBatchesEndpoints.createPspMo(orgId, batchId),
    payload,
  );
  return data;
}

export async function fetchTrialBatchPspMoBookings(
  orgId: string,
  batchId: string,
): Promise<PspTrialMoBookingsResponseDto> {
  const { data } = await apiClient.get<PspTrialMoBookingsResponseDto>(
    trialBatchesEndpoints.pspMoBookings(orgId, batchId),
  );
  return data;
}

export async function fetchTrialBatchPspMoChain(
  orgId: string,
  batchId: string,
): Promise<PspTrialMoChainResponseDto> {
  const { data } = await apiClient.get<PspTrialMoChainResponseDto>(
    trialBatchesEndpoints.pspMoChain(orgId, batchId),
  );
  return data;
}
