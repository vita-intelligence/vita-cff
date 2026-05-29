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
  //: Narrow patch for filling required-for-sent fields that were left
  //: blank when the director approved the proposal. Backend rejects
  //: any key outside its whitelist or any key that isn't currently
  //: flagged missing, so this can't be used to silently mutate
  //: approved content.
  completeRequiredFields: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/complete-required-fields/`,
  sendToClient: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/send-to-client/`,
  sendTestEmail: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/send-test-email/`,
  transitions: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/transitions/`,
  render: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/render/`,
  //: Passthrough to the spec sheet attached to this proposal —
  //: gated by ``proposals.view`` rather than ``formulations.view``
  //: so a sales member who can read the proposal can also read
  //: the spec underneath it without inheriting access to every
  //: signed spec in the org. The backend hard-checks the sheet
  //: is actually referenced by the proposal.
  attachedSpecRender: (
    orgId: string,
    proposalId: string,
    sheetId: string,
  ) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/specs/${sheetId}/render/`,
  //: WeasyPrint PDF download for authenticated staff. Mirror of the
  //: public token-gated ``publicDownload`` but gated by the standard
  //: org-scoped capability check so internal users can grab a signed
  //: copy without sharing a customer link.
  download: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/download/`,
  audit: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/audit/`,
  //: Customer-side portal activity timeline — list of PortalEvent rows
  //: (link opened, signed in, proposal viewed, …) the customer has
  //: produced for this proposal. Used by the "Customer activity" card
  //: on the staff proposal detail page to answer the "did they even
  //: open it?" question the audit endpoint can't.
  activity: (orgId: string, proposalId: string) =>
    `/api/organizations/${orgId}/proposals/${proposalId}/activity/`,
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
  publicReject: (token: string) =>
    `/api/public/proposals/${token}/reject/`,
  //: WeasyPrint-rendered PDF of the proposal, served with
  //: ``Content-Disposition: attachment`` so the browser saves a file
  //: instead of streaming inline. Token-gated like the preview.
  publicDownload: (token: string) =>
    `/api/public/proposals/${token}/download/`,
} as const;
