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
  pdf: (orgId: string, sheetId: string, opts?: { readonly download?: boolean }) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/pdf/${
      opts?.download ? "?download=1" : ""
    }`,
  publicLink: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/public-link/`,
  status: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/status/`,
  publicRender: (token: string) => `/api/public/specifications/${token}/`,
  publicPdf: (token: string, opts?: { readonly download?: boolean }) =>
    `/api/public/specifications/${token}/pdf/${opts?.download ? "?download=1" : ""}`,
} as const;
