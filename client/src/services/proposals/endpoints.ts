/**
 * URL constants for the proposals domain.
 */

export const proposalsEndpoints = {
  list: (orgId: string) => `/api/organizations/${orgId}/proposals/`,
  forFormulation: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/proposals/?formulation_id=${formulationId}`,
  detail: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/`,
  status: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/status/`,
  sendToClient: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/send-to-client/`,
  sendTestEmail: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/send-test-email/`,
  transitions: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/transitions/`,
  render: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/render/`,
  audit: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/audit/`,
  lines: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/lines/`,
  lineDetail: (orgId: string, proposalId: string, lineId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/lines/${lineId}/`,
  costPreview: (orgId: string, versionId: string, marginPercent?: string) => {
    const base = `/api/organizations/${orgId}/formulation-versions/${versionId}/cost-preview/`;
    if (!marginPercent) return base;
    const qs = new URLSearchParams({ margin: marginPercent });
    return `${base}?${qs.toString()}`;
  },
  //: Public kiosk — token-gated, no org in the path. Returns the
  //: proposal payload + every attached spec sheet, each with its
  //: own signature-state metadata. The sibling sign/finalize URLs
  //: post into this same tree.
  publicKiosk: (token: string) => `/api/public/proposals/${token}/`,
  publicSign: (token: string) =>
    `/api/public/proposals/${token}/sign/`,
  publicSignSpec: (token: string, sheetId: string) =>
    `/api/public/proposals/${token}/specs/${sheetId}/sign/`,
  publicFinalize: (token: string) =>
    `/api/public/proposals/${token}/finalize/`,
  //: WeasyPrint-rendered PDF of the proposal, served with
  //: ``Content-Disposition: attachment`` so the browser saves a file
  //: instead of streaming inline. Token-gated like the preview.
  publicDownload: (token: string) =>
    `/api/public/proposals/${token}/download/`,
} as const;
