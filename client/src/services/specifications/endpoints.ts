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
  packaging: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/packaging/`,
  packagingOptions: (
    orgId: string,
    params: {
      readonly slot: string;
      readonly search?: string;
      readonly limit?: number;
    },
  ) => {
    const qs = new URLSearchParams({ slot: params.slot });
    if (params.search) qs.set("search", params.search);
    if (params.limit) qs.set("limit", String(params.limit));
    return `/api/organizations/${orgId}/specifications/packaging-options/?${qs.toString()}`;
  },
  publicLink: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/public-link/`,
  status: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/status/`,
  visibility: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/visibility/`,
  publicRender: (token: string) => `/api/public/specifications/${token}/`,
  publicPdf: (token: string, opts?: { readonly download?: boolean }) =>
    `/api/public/specifications/${token}/pdf/${opts?.download ? "?download=1" : ""}`,
} as const;
