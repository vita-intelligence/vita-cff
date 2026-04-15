/**
 * URL constants for the catalogues domain.
 *
 * Catalogues are org-scoped typed reference tables (raw materials,
 * packaging, custom user-defined tables). Each catalogue hosts items
 * and attribute definitions identified by the catalogue ``slug``.
 */

export const cataloguesEndpoints = {
  catalogueList: (orgId: string) =>
    `/api/organizations/${orgId}/catalogues/`,
  catalogueDetail: (orgId: string, slug: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/`,
  itemList: (orgId: string, slug: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/items/`,
  itemDetail: (orgId: string, slug: string, itemId: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/items/${itemId}/`,
  itemImport: (orgId: string, slug: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/items/import/`,
  attributeList: (orgId: string, slug: string) =>
    `/api/organizations/${orgId}/catalogues/${slug}/attributes/`,
  attributeDetail: (
    orgId: string,
    slug: string,
    definitionId: string,
  ) =>
    `/api/organizations/${orgId}/catalogues/${slug}/attributes/${definitionId}/`,
} as const;
