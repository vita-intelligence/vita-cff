export const customersEndpoints = {
  list: (orgId: string, search?: string) => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    return `/api/organizations/${orgId}/customers/${qs}`;
  },
  detail: (orgId: string, customerId: string) =>
    `/api/organizations/${orgId}/customers/${customerId}/`,
  portalInvite: (orgId: string, customerId: string) =>
    `/api/organizations/${orgId}/customers/${customerId}/portal-invites/`,
  // Microsoft Dynamics integration — admin config + picker search +
  // on-demand import.
  dynamicsConfig: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/dynamics/`,
  dynamicsTest: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/dynamics/test/`,
  dynamicsSearch: (orgId: string, q: string, limit = 10) =>
    `/api/organizations/${orgId}/dynamics/customers/search/?q=${encodeURIComponent(
      q,
    )}&limit=${limit}`,
  dynamicsImport: (orgId: string) =>
    `/api/organizations/${orgId}/customers/import-from-dynamics/`,
} as const;
