/**
 * URL constants for the members-administration domain.
 *
 * The wire shape maps 1-to-1 onto :mod:`apps.organizations.api.urls`.
 * Kept as a ``const`` so the paths are importable anywhere that needs
 * to hit the backend directly (e.g. SSR fetchers in
 * :file:`src/lib/auth/server.ts`).
 */

export const membersEndpoints = {
  /** List memberships in the org. Requires ``members.view``. */
  list: (orgId: string) => `/api/organizations/${orgId}/memberships/`,
  /** Update permissions (PATCH) + remove (DELETE). */
  detail: (orgId: string, membershipId: string) =>
    `/api/organizations/${orgId}/memberships/${membershipId}/`,
  /** Replace the membership's ``groups`` list. Requires
   *  ``members.edit_permissions``. */
  groups: (orgId: string, membershipId: string) =>
    `/api/organizations/${orgId}/memberships/${membershipId}/groups/`,
  /** Module + capability registry — not org-scoped. */
  modules: () => `/api/organizations/modules/`,
} as const;
