/**
 * URL constants for the AI domain.
 *
 * One path per "purpose" — additional endpoints will land here as
 * we add ingredient-match, spec-sheet draft, QC draft, etc.
 */

export const aiEndpoints = {
  formulationDraft: (orgId: string) =>
    `/api/organizations/${orgId}/ai/formulation-draft/`,
} as const;
