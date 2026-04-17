/**
 * URL constants for the product-validation domain.
 */

export const productValidationEndpoints = {
  list: (orgId: string) =>
    `/api/organizations/${orgId}/product-validations/`,
  detail: (orgId: string, validationId: string) =>
    `/api/organizations/${orgId}/product-validations/${validationId}/`,
  stats: (orgId: string, validationId: string) =>
    `/api/organizations/${orgId}/product-validations/${validationId}/stats/`,
  status: (orgId: string, validationId: string) =>
    `/api/organizations/${orgId}/product-validations/${validationId}/status/`,
  forBatch: (orgId: string, batchId: string) =>
    `/api/organizations/${orgId}/trial-batches/${batchId}/validation/`,
} as const;
