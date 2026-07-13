/**
 * URL constants for the CFF submissions domain.
 *
 * Owner-only integration CRUD + test endpoints live alongside the
 * triage-facing list / detail / assign routes. Mirrors the MRPEasy
 * and Dynamics integration URL shapes for consistency.
 */

export const cffEndpoints = {
  list: (orgId: string) =>
    `/api/organizations/${orgId}/cff-submissions/`,
  detail: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/`,
  assign: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/assign/`,
  unassign: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/unassign/`,
  reject: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/reject/`,
  unreject: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/unreject/`,
  createProject: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/create-project/`,
  fieldLabels: (orgId: string) =>
    `/api/organizations/${orgId}/cff-submissions/field-labels/`,
  syncStatus: (orgId: string) =>
    `/api/organizations/${orgId}/cff-submissions/sync-status/`,
  integration: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/wix-cff/`,
  integrationTest: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/wix-cff/test/`,
} as const;
