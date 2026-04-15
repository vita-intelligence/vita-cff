/**
 * URL constants for the attributes domain.
 *
 * Attribute definitions are nested under a catalogue slug — they
 * describe the dynamic schema for items inside that catalogue.
 */

export const attributesEndpoints = {
  list: (orgId: string, slug: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/attributes/`,
  detail: (orgId: string, slug: string, definitionId: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/attributes/${definitionId}/`,
} as const;
