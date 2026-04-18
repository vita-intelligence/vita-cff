/**
 * URL constants for the invitations domain.
 */

export const invitationsEndpoints = {
  /** List + create. GET requires ``members.view``; POST requires
   *  ``members.invite``. */
  list: (orgId: string) => `/api/organizations/${orgId}/invitations/`,
  /** Legacy alias pointing at ``list`` — kept so existing callers
   *  (``useCreateInvitation``) don't have to migrate in this PR. */
  create: (orgId: string) => `/api/organizations/${orgId}/invitations/`,
  /** Admin detail URL — DELETE revokes a pending invitation. */
  adminDetail: (orgId: string, invitationId: string) =>
    `/api/organizations/${orgId}/invitations/${invitationId}/`,
  /** Admin resend endpoint — rotates the token + extends the expiry. */
  resend: (orgId: string, invitationId: string) =>
    `/api/organizations/${orgId}/invitations/${invitationId}/resend/`,
  /** Public details endpoint for the accept page (token in path). */
  detail: (token: string) => `/api/invitations/${token}/`,
  /** Public accept endpoint. Creates user + membership + auth cookies. */
  accept: (token: string) => `/api/invitations/${token}/accept/`,
} as const;
