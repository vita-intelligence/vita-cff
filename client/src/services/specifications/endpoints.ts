/**
 * URL constants for the specifications domain.
 */

export const specificationsEndpoints = {
  list: (orgId: string) =>
    `/api/organizations/${orgId}/specifications/`,
  detail: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/`,
  render: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/render/`,
  status: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/status/`,
} as const;
