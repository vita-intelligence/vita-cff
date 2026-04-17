/**
 * Raw Axios calls for the trial-batches domain.
 */

import { apiClient } from "@/lib/api";

import { trialBatchesEndpoints } from "./endpoints";
import type {
  BOMResult,
  CreateTrialBatchRequestDto,
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
