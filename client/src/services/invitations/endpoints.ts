/**
 * URL constants for the invitations domain.
 */

export const invitationsEndpoints = {
  /** Create an invitation (requires ``members:admin`` on the target org). */
  create: (orgId: string) => `/api/organizations/${orgId}/invitations/`,
  /** Public details endpoint for the accept page. */
  detail: (token: string) => `/api/invitations/${token}/`,
  /** Public accept endpoint. Creates user + membership + auth cookies. */
  accept: (token: string) => `/api/invitations/${token}/accept/`,
} as const;
