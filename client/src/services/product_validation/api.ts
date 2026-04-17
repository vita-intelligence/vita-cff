/**
 * Raw Axios calls for the product-validation domain.
 */

import { apiClient, ApiError } from "@/lib/api";

import { productValidationEndpoints } from "./endpoints";
import type {
  CreateValidationRequestDto,
  ProductValidationDto,
  TransitionValidationRequestDto,
  UpdateValidationRequestDto,
  ValidationStatsDto,
} from "./types";


export async function fetchValidation(
  orgId: string,
  validationId: string,
): Promise<ProductValidationDto> {
  const { data } = await apiClient.get<ProductValidationDto>(
    productValidationEndpoints.detail(orgId, validationId),
  );
  return data;
}

export async function fetchValidationStats(
  orgId: string,
  validationId: string,
): Promise<ValidationStatsDto> {
  const { data } = await apiClient.get<ValidationStatsDto>(
    productValidationEndpoints.stats(orgId, validationId),
  );
  return data;
}

/**
 * Look up the validation attached to a trial batch. Returns ``null``
 * (instead of throwing) on 404 so the caller can route between
 * "open existing" and "start new" without a try/catch.
 */
export async function fetchValidationForBatch(
  orgId: string,
  batchId: string,
): Promise<ProductValidationDto | null> {
  try {
    const { data } = await apiClient.get<ProductValidationDto>(
      productValidationEndpoints.forBatch(orgId, batchId),
    );
    return data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function createValidation(
  orgId: string,
  payload: CreateValidationRequestDto,
): Promise<ProductValidationDto> {
  const { data } = await apiClient.post<ProductValidationDto>(
    productValidationEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateValidation(
  orgId: string,
  validationId: string,
  payload: UpdateValidationRequestDto,
): Promise<ProductValidationDto> {
  const { data } = await apiClient.patch<ProductValidationDto>(
    productValidationEndpoints.detail(orgId, validationId),
    payload,
  );
  return data;
}

export async function transitionValidationStatus(
  orgId: string,
  validationId: string,
  payload: TransitionValidationRequestDto,
): Promise<ProductValidationDto> {
  const { data } = await apiClient.post<ProductValidationDto>(
    productValidationEndpoints.status(orgId, validationId),
    payload,
  );
  return data;
}

export async function deleteValidation(
  orgId: string,
  validationId: string,
): Promise<void> {
  await apiClient.delete(productValidationEndpoints.detail(orgId, validationId));
}
