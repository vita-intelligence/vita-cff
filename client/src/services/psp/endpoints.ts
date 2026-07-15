/**
 * URL constants for the PSP integration domain.
 *
 * Owner-only settings CRUD + test endpoints live alongside the
 * picker-facing item list / detail endpoints. Mirrors the MRPEasy
 * integration URL shape so the settings page can route the two
 * integrations through the same form-card pattern.
 */

export const pspEndpoints = {
  config: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/psp/`,
  test: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/psp/test/`,
  items: (
    orgId: string,
    args: {
      search?: string;
      itemTypes?: readonly string[];
      useAs?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    const search = (args.search ?? "").trim();
    if (search) params.set("search", search);
    if (args.itemTypes && args.itemTypes.length > 0) {
      params.set("item_types", args.itemTypes.join(","));
    }
    const useAs = (args.useAs ?? "").trim();
    if (useAs) params.set("use_as", useAs);
    const base = `/api/organizations/${orgId}/integrations/psp/items/`;
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  },
  itemDetail: (orgId: string, itemUuid: string) =>
    `/api/organizations/${orgId}/integrations/psp/items/${itemUuid}/`,
  itemMirror: (orgId: string, itemUuid: string) =>
    `/api/organizations/${orgId}/integrations/psp/items/${itemUuid}/mirror/`,
  workstationGroups: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/psp/workstation-groups/`,
} as const;
