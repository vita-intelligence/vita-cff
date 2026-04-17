/**
 * URL constants for the trial-batches domain.
 */

export const trialBatchesEndpoints = {
  list: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/trial-batches/`,
  detail: (orgId: string, batchId: string) =>
    `/api/organizations/${orgId}/trial-batches/${batchId}/`,
  render: (orgId: string, batchId: string) =>
    `/api/organizations/${orgId}/trial-batches/${batchId}/render/`,
} as const;
