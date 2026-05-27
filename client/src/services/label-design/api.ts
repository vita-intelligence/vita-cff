/** Raw API calls for the label-design domain.
 *
 * Thin wrappers around ``apiClient``; caching + invalidation live in
 * the corresponding TanStack hooks.
 */

import { apiClient } from "@/lib/api";

import { labelDesignEndpoints as ep } from "./endpoints";
import type {
  ComplianceContentBlockDto,
  ContentBlockTextDto,
  LabelDesignDto,
  LabelDesignListItemDto,
  LabelDesignListPage,
  LabelDesignReviewDto,
  LabelDesignTransitionDto,
} from "./types";


// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------


export async function fetchLabelDesigns(
  orgId: string,
  options: {
    readonly status?: string;
    readonly designer?: string;
    readonly search?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<LabelDesignListPage> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.designer) params.set("designer", options.designer);
  if (options.search) params.set("search", options.search);
  if (typeof options.limit === "number")
    params.set("limit", String(options.limit));
  if (typeof options.offset === "number")
    params.set("offset", String(options.offset));
  const qs = params.toString();
  const url = qs ? `${ep.list(orgId)}?${qs}` : ep.list(orgId);
  const { data } = await apiClient.get<LabelDesignListPage>(url);
  return data;
}


// Maintained as a small helper for one-off callers that just want an
// array of rows from a single page (current usages: nothing in app
// code — kept for parity with the previous shape so external imports
// don't break).
export async function fetchLabelDesignsFirstPage(
  orgId: string,
  options: { readonly status?: string; readonly designer?: string } = {},
): Promise<ReadonlyArray<LabelDesignListItemDto>> {
  const page = await fetchLabelDesigns(orgId, options);
  return page.items;
}


export async function fetchLabelDesign(
  orgId: string,
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.get<LabelDesignDto>(ep.detail(orgId, ldId));
  return data;
}


export async function assignLabelDesigner(
  orgId: string,
  ldId: string,
  designerId: string | null,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.assignDesigner(orgId, ldId),
    { designer_id: designerId },
  );
  return data;
}


export async function uploadLabelArtwork(
  orgId: string,
  ldId: string,
  payload: { readonly artwork: File; readonly notes?: string },
): Promise<LabelDesignDto> {
  const form = new FormData();
  form.append("artwork", payload.artwork);
  if (payload.notes) form.append("notes", payload.notes);
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.uploadArtwork(orgId, ldId),
    form,
  );
  return data;
}


export async function submitLabelForReview(
  orgId: string,
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.submitForReview(orgId, ldId),
    {},
  );
  return data;
}


export interface ReviewSubmitBody {
  readonly outcome: "approved" | "requires_revision";
  readonly checklist: ReadonlyArray<{
    readonly item_key: string;
    readonly pass_check: boolean;
    readonly comment: string;
  }>;
  readonly final_comments: string;
  readonly signature_image?: string;
}


export async function submitScientistReview(
  orgId: string,
  ldId: string,
  body: ReviewSubmitBody,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.scientistReview(orgId, ldId),
    body,
  );
  return data;
}


export async function submitDirectorReview(
  orgId: string,
  ldId: string,
  body: ReviewSubmitBody,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.directorReview(orgId, ldId),
    body,
  );
  return data;
}


export async function holdLabelDesign(
  orgId: string,
  ldId: string,
  notes: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.hold(orgId, ldId),
    { notes },
  );
  return data;
}


export async function resumeLabelDesign(
  orgId: string,
  ldId: string,
  notes: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.resume(orgId, ldId),
    { notes },
  );
  return data;
}


export async function fetchLabelDesignTransitions(
  orgId: string,
  ldId: string,
): Promise<ReadonlyArray<LabelDesignTransitionDto>> {
  const { data } = await apiClient.get<{ items: LabelDesignTransitionDto[] }>(
    ep.transitions(orgId, ldId),
  );
  return data.items;
}


export async function fetchLabelDesignReviews(
  orgId: string,
  ldId: string,
): Promise<ReadonlyArray<LabelDesignReviewDto>> {
  const { data } = await apiClient.get<{ items: LabelDesignReviewDto[] }>(
    ep.reviews(orgId, ldId),
  );
  return data.items;
}


export async function fetchContentBlockJson(
  orgId: string,
  ldId: string,
): Promise<ComplianceContentBlockDto> {
  const { data } = await apiClient.get<ComplianceContentBlockDto>(
    ep.contentBlockJson(orgId, ldId),
  );
  return data;
}


export async function fetchContentBlockText(
  orgId: string,
  ldId: string,
): Promise<ContentBlockTextDto> {
  const { data } = await apiClient.get<ContentBlockTextDto>(
    ep.contentBlockText(orgId, ldId),
  );
  return data;
}


// ---------------------------------------------------------------------------
// Portal (no orgId — the cookie-bound ClientAccount scopes ownership)
// ---------------------------------------------------------------------------


export async function portalFetchLabelDesigns(): Promise<
  ReadonlyArray<LabelDesignDto>
> {
  const { data } = await apiClient.get<{ items: LabelDesignDto[] }>(
    ep.portalList(),
  );
  return data.items;
}


export async function portalFetchLabelDesign(
  ldId: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.get<LabelDesignDto>(ep.portalDetail(ldId));
  return data;
}


export async function portalChoosePath(
  ldId: string,
  path: "design_by_us" | "design_by_customer",
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalChoosePath(ldId),
    { path },
  );
  return data;
}


export interface PreferencesSubmitBody {
  readonly company_name?: string;
  readonly brand_name?: string;
  readonly product_names?: string;
  readonly product_codes?: string;
  readonly brand_colours?: ReadonlyArray<{ name: string; hex: string }>;
  readonly inspiration_urls?: ReadonlyArray<string>;
  readonly elements_to_include?: string;
  readonly design_style?: string;
  readonly material_type?: string;
  readonly additional_comments?: string;
  readonly declaration_name?: string;
  readonly declaration_position?: string;
  readonly declaration_signature_image?: string;
}


export async function portalSubmitPreferences(
  ldId: string,
  body: PreferencesSubmitBody,
  inspirationFiles: ReadonlyArray<File> = [],
): Promise<LabelDesignDto> {
  const form = new FormData();
  Object.entries(body).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  });
  for (const file of inspirationFiles) {
    form.append("inspiration_files", file);
  }
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalPreferences(ldId),
    form,
  );
  return data;
}


export async function portalFetchContentBlockJson(
  ldId: string,
): Promise<ComplianceContentBlockDto> {
  const { data } = await apiClient.get<ComplianceContentBlockDto>(
    ep.portalContentBlockJson(ldId),
  );
  return data;
}


export async function portalFetchContentBlockText(
  ldId: string,
): Promise<ContentBlockTextDto> {
  const { data } = await apiClient.get<ContentBlockTextDto>(
    ep.portalContentBlockText(ldId),
  );
  return data;
}


export async function portalUploadArtwork(
  ldId: string,
  payload: {
    readonly artwork: File;
    readonly signature_image: string;
    readonly notes?: string;
  },
): Promise<LabelDesignDto> {
  const form = new FormData();
  form.append("artwork", payload.artwork);
  form.append("signature_image", payload.signature_image);
  if (payload.notes) form.append("notes", payload.notes);
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalUploadArtwork(ldId),
    form,
  );
  return data;
}


export async function portalApproveLabel(
  ldId: string,
  signature_image: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalApprove(ldId),
    { signature_image },
  );
  return data;
}


export async function portalRejectLabel(
  ldId: string,
  reason: string,
): Promise<LabelDesignDto> {
  const { data } = await apiClient.post<LabelDesignDto>(
    ep.portalReject(ldId),
    { reason },
  );
  return data;
}
