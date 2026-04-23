export const customersEndpoints = {
  list: (orgId: string, search?: string) => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    return `/api/organizations/${orgId}/customers/${qs}`;
  },
  detail: (orgId: string, customerId: string) =>
    `/api/organizations/${orgId}/customers/${customerId}/`,
} as const;
