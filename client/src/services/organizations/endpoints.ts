/**
 * URL constants for the organizations domain.
 *
 * Every path the app hits in this domain lives here — never inlined in
 * a hook or a form. Rename a backend route once and the whole frontend
 * tracks the change.
 */

export const organizationsEndpoints = {
  list: "/api/organizations/",
  detail: (orgId: string) => `/api/organizations/${orgId}/`,
} as const;
