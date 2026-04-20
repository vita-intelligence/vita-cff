/**
 * URL constants for the formulations domain.
 */

export const formulationsEndpoints = {
  list: (orgId: string) => `/api/organizations/${orgId}/formulations/`,
  detail: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/`,
  lines: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/lines/`,
  compute: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/compute/`,
  versions: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/versions/`,
  rollback: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/rollback/`,
  overview: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/overview/`,
  salesPerson: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/sales-person/`,
} as const;
