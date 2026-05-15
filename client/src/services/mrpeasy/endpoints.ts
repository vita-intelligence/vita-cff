/**
 * URL constants for the MRPEasy integration domain.
 *
 * Owner-only settings CRUD + test endpoints live alongside the
 * picker-facing price-lookup endpoint. Mirrors the Dynamics
 * integration URL shape so the settings page can route the two
 * integrations through the same form-card pattern.
 */

export const mrpeasyEndpoints = {
  config: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/mrpeasy/`,
  test: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/mrpeasy/test/`,
  lookup: (orgId: string, code: string) =>
    `/api/organizations/${orgId}/integrations/mrpeasy/lookup/?code=${encodeURIComponent(
      code,
    )}`,
  items: (orgId: string, search?: string) => {
    const base = `/api/organizations/${orgId}/integrations/mrpeasy/items/`;
    const trimmed = (search ?? "").trim();
    return trimmed
      ? `${base}?search=${encodeURIComponent(trimmed)}`
      : base;
  },
} as const;
