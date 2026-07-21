/**
 * URL constants for the formulations domain.
 */

export const formulationsEndpoints = {
  list: (orgId: string) => `/api/organizations/${orgId}/formulations/`,
  detail: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/`,
  lines: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/lines/`,
  compute: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/compute/`,
  versions: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/versions/`,
  rollback: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/rollback/`,
  overview: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/overview/`,
  salesPerson: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/sales-person/`,
  leadScientist: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/lead-scientist/`,
  approvedVersion: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/approved-version/`,
  clone: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/clone/`,
  stages: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/stages/`,
  syncPsp: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/sync-psp/`,
  pullPspBom: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/pull-psp-bom/`,
  stageTemplates: (orgId: string) =>
    `/api/organizations/${orgId}/formulation-stage-templates/`,
  stageTemplateDetail: (orgId: string, templateId: string) =>
    `/api/organizations/${orgId}/formulation-stage-templates/${templateId}/`,
  applyStageTemplate: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/apply-stage-template/`,
  wizardRouting: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/wizard-routing/`,
  photos: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/photos/`,
  photoDetail: (orgId: string, formulationId: string, photoId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/photos/${photoId}/`,
  files: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/files/`,
  fileDetail: (orgId: string, formulationId: string, fileId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/files/${fileId}/`,
  certificates: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/certificates/`,
  certificateCatalog: (orgId: string, formulationId: string) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/certificates/catalog/`,
  certificateDetail: (
    orgId: string,
    formulationId: string,
    certId: string,
  ) =>
    `/api/organizations/${orgId}/formulations/${formulationId}/certificates/${certId}/`,
} as const;
