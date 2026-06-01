/** Endpoint URL builders for the label-design domain (staff + portal). */

export const labelDesignEndpoints = {
  // Staff
  list: (orgId: string) =>
    `/api/organizations/${orgId}/label-designs/`,
  detail: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/`,
  assignDesigner: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/assign-designer/`,
  uploadArtwork: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/upload-artwork/`,
  submitForReview: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/submit-for-review/`,
  scientistReview: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/scientist-review/`,
  directorReview: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/director-review/`,
  hold: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/hold/`,
  resume: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/resume/`,
  transitions: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/transitions/`,
  reviews: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/reviews/`,
  specRender: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/spec/`,
  contentBlockJson: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/content-block/`,
  contentBlockPdf: (orgId: string, ldId: string, region?: string) => {
    const base = `/api/organizations/${orgId}/label-designs/${ldId}/content-block/pdf/`;
    return region && region !== "all" ? `${base}?region=${region}` : base;
  },
  contentBlockPng: (orgId: string, ldId: string, region?: string) => {
    const base = `/api/organizations/${orgId}/label-designs/${ldId}/content-block/png/`;
    return region && region !== "all" ? `${base}?region=${region}` : base;
  },
  contentBlockText: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/content-block/text/`,
  contentBlockHtml: (orgId: string, ldId: string) =>
    `/api/organizations/${orgId}/label-designs/${ldId}/content-block/html/`,

  // Portal
  portalList: () => `/api/portal/label-designs/`,
  portalDetail: (ldId: string) => `/api/portal/label-designs/${ldId}/`,
  portalChoosePath: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/choose-path/`,
  portalPreferences: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/preferences/`,
  portalContentBlockJson: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/content-block/`,
  portalContentBlockPdf: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/content-block/pdf/`,
  portalContentBlockPng: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/content-block/png/`,
  portalContentBlockText: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/content-block/text/`,
  portalContentBlockHtml: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/content-block/html/`,
  portalUploadArtwork: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/upload-artwork/`,
  portalApprove: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/approve/`,
  portalReject: (ldId: string) =>
    `/api/portal/label-designs/${ldId}/reject/`,

  // Staff template library
  templateCategories: (orgId: string) =>
    `/api/organizations/${orgId}/label-design-template-categories/`,
  templateCategoryDetail: (orgId: string, catId: string) =>
    `/api/organizations/${orgId}/label-design-template-categories/${catId}/`,
  templates: (orgId: string) =>
    `/api/organizations/${orgId}/label-design-templates/`,
  templateDetail: (orgId: string, tplId: string) =>
    `/api/organizations/${orgId}/label-design-templates/${tplId}/`,

  // Portal — customer-facing template library
  portalTemplateLibrary: () => `/api/portal/label-design-templates/`,
} as const;
