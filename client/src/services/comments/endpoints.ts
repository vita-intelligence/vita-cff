/**
 * URL constants for the comments domain.
 */

export const commentsEndpoints = {
  formulationThread: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/comments/`,
  specificationThread: (orgId: string, sheetId: string) =>
    `/api/organizations/${orgId}/specifications/${sheetId}/comments/`,
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
} as const;
