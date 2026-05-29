/**
 * URL constants for the comments domain.
 */

export const commentsEndpoints = {
  formulationThread: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/comments/`,
  specificationThread: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/comments/`,
  // Proposal thread — used by the staff proposal detail page to
  // surface the customer-portal proposal-level conversation. The
  // backend allows shared comments + staff replies on the
  // ``proposals.Proposal`` polymorphic target (migration
  // ``comments.0007_comment_proposal``).
  proposalThread: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/comments/`,
  // CFF internal-triage chat. Mounted under the comments namespace
  // so the read pointer + inbox fan-out plumbing slots in unchanged
  // — the only difference vs. the formulation / spec / proposal
  // routes is the backend's capability gate (``cff_submissions.view``
  // instead of ``formulations.comments_view``).
  cffSubmissionThread: (orgId: string, submissionId: string) =>
    `/api/organizations/${orgId}/cff-submissions/${submissionId}/comments/`,
  // Label-design chat — same shape as the other entity threads.
  // Gated by ``labelling.view`` server-side so a designer can chat
  // without holding ``formulations.comments_view``.
  labelDesignThread: (orgId: string, labelDesignId: string) =>
    `/api/organizations/${orgId}/label-designs/${labelDesignId}/comments/`,
  detail: (orgId: string, commentId: string) =>
    `/api/organizations/${orgId}/comments/${commentId}/`,
  resolve: (orgId: string, commentId: string) =>
    `/api/organizations/${orgId}/comments/${commentId}/resolve/`,
  unresolve: (orgId: string, commentId: string) =>
    `/api/organizations/${orgId}/comments/${commentId}/unresolve/`,
  flag: (orgId: string, commentId: string) =>
    `/api/organizations/${orgId}/comments/${commentId}/flag/`,
  unflag: (orgId: string, commentId: string) =>
    `/api/organizations/${orgId}/comments/${commentId}/unflag/`,
  mentionable: (orgId: string, q: string | undefined) => {
    const qs = new URLSearchParams();
    if (q && q.trim()) qs.set("q", q.trim());
    const suffix = qs.toString();
    return `/api/organizations/${orgId}/members/mentionable/${
      suffix ? `?${suffix}` : ""
    }`;
  },
  notifyClient: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/notify-client/`,
} as const;
