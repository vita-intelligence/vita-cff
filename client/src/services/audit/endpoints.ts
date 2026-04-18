/**
 * URL constants for the audit log domain.
 *
 * The audit trail is read-only from the client — writes only ever
 * happen server-side via ``apps.audit.services.record``. No mutation
 * endpoints are published here by design.
 */

export const auditEndpoints = {
  list: (orgId: string) => `/api/organizations/${orgId}/audit-log/`,
} as const;
