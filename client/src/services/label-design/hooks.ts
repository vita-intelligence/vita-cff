/** TanStack Query hooks for the label-design domain. */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { rootQueryKey } from "@/lib/query";

import {
  assignLabelDesigner,
  fetchContentBlockHtml,
  fetchContentBlockJson,
  fetchContentBlockText,
  fetchLabelDesign,
  fetchLabelDesignReviews,
  fetchLabelDesignSpec,
  fetchLabelDesignTransitions,
  fetchLabelDesigns,
  holdLabelDesign,
  portalApproveLabel,
  portalChoosePath,
  portalFetchContentBlockJson,
  portalFetchContentBlockText,
  portalFetchLabelDesign,
  portalFetchLabelDesigns,
  portalRejectLabel,
  portalSubmitPreferences,
  portalUploadArtwork,
  resumeLabelDesign,
  submitDirectorReview,
  submitLabelForReview,
  submitScientistReview,
  uploadLabelArtwork,
  type PreferencesSubmitBody,
  type ReviewSubmitBody,
} from "./api";
import type { RenderedSheetContext } from "@/services/specifications";

import type {
  ComplianceContentBlockDto,
  ContentBlockTextDto,
  LabelDesignDto,
  LabelDesignListPage,
  LabelDesignReviewDto,
  LabelDesignTransitionDto,
} from "./types";


export const labelDesignKeys = {
  all: [...rootQueryKey, "label-design"] as const,
  list: (orgId: string, status?: string, search?: string) =>
    [
      ...rootQueryKey,
      "label-design",
      "list",
      orgId,
      status ?? "all",
      search ?? "",
    ] as const,
  detail: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "detail", orgId, ldId] as const,
  transitions: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "transitions", orgId, ldId] as const,
  reviews: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "reviews", orgId, ldId] as const,
  contentBlockJson: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "content-block-json", orgId, ldId] as const,
  contentBlockText: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "content-block-text", orgId, ldId] as const,
  contentBlockHtml: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "content-block-html", orgId, ldId] as const,
  specRender: (orgId: string, ldId: string) =>
    [...rootQueryKey, "label-design", "spec-render", orgId, ldId] as const,
  portalList: () => [...rootQueryKey, "label-design", "portal-list"] as const,
  portalDetail: (ldId: string) =>
    [...rootQueryKey, "label-design", "portal-detail", ldId] as const,
  portalContentBlockJson: (ldId: string) =>
    [...rootQueryKey, "label-design", "portal-content-block-json", ldId] as const,
  portalContentBlockText: (ldId: string) =>
    [...rootQueryKey, "label-design", "portal-content-block-text", ldId] as const,
} as const;


// ---------------------------------------------------------------------------
// Staff queries
// ---------------------------------------------------------------------------


const LIST_PAGE_SIZE = 25;


/** Paginated + searchable staff queue.
 *
 * Returns a TanStack ``useInfiniteQuery`` — call ``fetchNextPage()``
 * to append the next slice. Pages are keyed by ``(status, search)``
 * so changing tab or query resets the scroll cleanly.
 */
export function useLabelDesigns(
  orgId: string,
  options: {
    readonly status?: string;
    readonly search?: string;
    readonly designer?: string;
    readonly enabled?: boolean;
  } = {},
): UseInfiniteQueryResult<
  { pages: LabelDesignListPage[]; pageParams: unknown[] },
  Error
> {
  return useInfiniteQuery({
    queryKey: labelDesignKeys.list(orgId, options.status, options.search),
    queryFn: ({ pageParam }) =>
      fetchLabelDesigns(orgId, {
        status: options.status,
        designer: options.designer,
        search: options.search,
        limit: LIST_PAGE_SIZE,
        offset: (pageParam as number) ?? 0,
      }),
    initialPageParam: 0 as number,
    getNextPageParam: (last) => (last.has_more ? last.next_offset : undefined),
    enabled: options.enabled !== false && Boolean(orgId),
  });
}


export function useLabelDesign(
  orgId: string,
  ldId: string,
  enabled = true,
): UseQueryResult<LabelDesignDto> {
  return useQuery({
    queryKey: labelDesignKeys.detail(orgId, ldId),
    queryFn: () => fetchLabelDesign(orgId, ldId),
    enabled: enabled && Boolean(orgId) && Boolean(ldId),
  });
}


export function useLabelDesignSpec(
  orgId: string,
  ldId: string,
  enabled = true,
): UseQueryResult<RenderedSheetContext> {
  return useQuery({
    queryKey: labelDesignKeys.specRender(orgId, ldId),
    queryFn: () => fetchLabelDesignSpec(orgId, ldId),
    enabled: enabled && Boolean(orgId) && Boolean(ldId),
  });
}


export function useLabelDesignTransitions(
  orgId: string,
  ldId: string,
): UseQueryResult<ReadonlyArray<LabelDesignTransitionDto>> {
  return useQuery({
    queryKey: labelDesignKeys.transitions(orgId, ldId),
    queryFn: () => fetchLabelDesignTransitions(orgId, ldId),
    enabled: Boolean(orgId) && Boolean(ldId),
  });
}


export function useLabelDesignReviews(
  orgId: string,
  ldId: string,
): UseQueryResult<ReadonlyArray<LabelDesignReviewDto>> {
  return useQuery({
    queryKey: labelDesignKeys.reviews(orgId, ldId),
    queryFn: () => fetchLabelDesignReviews(orgId, ldId),
    enabled: Boolean(orgId) && Boolean(ldId),
  });
}


export function useContentBlockJson(
  orgId: string,
  ldId: string,
): UseQueryResult<ComplianceContentBlockDto> {
  return useQuery({
    queryKey: labelDesignKeys.contentBlockJson(orgId, ldId),
    queryFn: () => fetchContentBlockJson(orgId, ldId),
    enabled: Boolean(orgId) && Boolean(ldId),
  });
}


export function useContentBlockHtml(
  orgId: string,
  ldId: string,
): UseQueryResult<string> {
  return useQuery({
    queryKey: labelDesignKeys.contentBlockHtml(orgId, ldId),
    queryFn: () => fetchContentBlockHtml(orgId, ldId),
    enabled: Boolean(orgId) && Boolean(ldId),
  });
}


export function useContentBlockText(
  orgId: string,
  ldId: string,
): UseQueryResult<ContentBlockTextDto> {
  return useQuery({
    queryKey: labelDesignKeys.contentBlockText(orgId, ldId),
    queryFn: () => fetchContentBlockText(orgId, ldId),
    enabled: Boolean(orgId) && Boolean(ldId),
  });
}


// ---------------------------------------------------------------------------
// Staff mutations
// ---------------------------------------------------------------------------


function _invalidateLabelDesign(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
  ldId: string,
) {
  // ``refetchQueries`` (vs ``invalidateQueries``) forces a network
  // round-trip even when there is no active observer momentarily —
  // the Hold / Resume buttons unmount the moment the status flips
  // (the parent swaps in the other button), and an invalidate-only
  // call was racing the unmount in the resume case so the new state
  // never landed until a manual refresh. Refetching is the safe
  // hammer here.
  qc.refetchQueries({ queryKey: labelDesignKeys.detail(orgId, ldId) });
  qc.refetchQueries({ queryKey: labelDesignKeys.list(orgId) });
  qc.refetchQueries({ queryKey: labelDesignKeys.transitions(orgId, ldId) });
  qc.refetchQueries({ queryKey: labelDesignKeys.reviews(orgId, ldId) });
}


export function useAssignLabelDesigner(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (designerId: string | null) =>
      assignLabelDesigner(orgId, ldId, designerId),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useUploadLabelArtwork(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { artwork: File; notes?: string }) =>
      uploadLabelArtwork(orgId, ldId, payload),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useSubmitLabelForReview(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => submitLabelForReview(orgId, ldId),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useSubmitScientistReview(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewSubmitBody) =>
      submitScientistReview(orgId, ldId, body),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useSubmitDirectorReview(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ReviewSubmitBody) =>
      submitDirectorReview(orgId, ldId, body),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useHoldLabelDesign(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notes: string) => holdLabelDesign(orgId, ldId, notes),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


export function useResumeLabelDesign(orgId: string, ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notes: string) => resumeLabelDesign(orgId, ldId, notes),
    onSuccess: () => _invalidateLabelDesign(qc, orgId, ldId),
  });
}


// ---------------------------------------------------------------------------
// Portal queries + mutations
// ---------------------------------------------------------------------------


export function usePortalLabelDesigns(): UseQueryResult<
  ReadonlyArray<LabelDesignDto>
> {
  return useQuery({
    queryKey: labelDesignKeys.portalList(),
    queryFn: () => portalFetchLabelDesigns(),
  });
}


export function usePortalLabelDesign(
  ldId: string,
): UseQueryResult<LabelDesignDto> {
  return useQuery({
    queryKey: labelDesignKeys.portalDetail(ldId),
    queryFn: () => portalFetchLabelDesign(ldId),
    enabled: Boolean(ldId),
  });
}


export function usePortalContentBlockJson(
  ldId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ComplianceContentBlockDto> {
  return useQuery({
    queryKey: labelDesignKeys.portalContentBlockJson(ldId),
    queryFn: () => portalFetchContentBlockJson(ldId),
    enabled: Boolean(ldId) && (options.enabled ?? true),
  });
}


export function usePortalContentBlockText(
  ldId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ContentBlockTextDto> {
  return useQuery({
    queryKey: labelDesignKeys.portalContentBlockText(ldId),
    queryFn: () => portalFetchContentBlockText(ldId),
    enabled: Boolean(ldId) && (options.enabled ?? true),
  });
}


function _invalidatePortalLabel(
  qc: ReturnType<typeof useQueryClient>,
  ldId: string,
) {
  qc.invalidateQueries({ queryKey: labelDesignKeys.portalDetail(ldId) });
  qc.invalidateQueries({ queryKey: labelDesignKeys.portalList() });
}


export function usePortalChoosePath(ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: "design_by_us" | "design_by_customer") =>
      portalChoosePath(ldId, path),
    onSuccess: () => _invalidatePortalLabel(qc, ldId),
  });
}


export function usePortalSubmitPreferences(ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      body: PreferencesSubmitBody;
      inspirationFiles?: ReadonlyArray<File>;
    }) =>
      portalSubmitPreferences(ldId, args.body, args.inspirationFiles ?? []),
    onSuccess: () => _invalidatePortalLabel(qc, ldId),
  });
}


export function usePortalUploadArtwork(ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      artwork: File;
      signature_image: string;
      notes?: string;
    }) => portalUploadArtwork(ldId, payload),
    onSuccess: () => _invalidatePortalLabel(qc, ldId),
  });
}


export function usePortalApprove(ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (signature_image: string) =>
      portalApproveLabel(ldId, signature_image),
    onSuccess: () => _invalidatePortalLabel(qc, ldId),
  });
}


export function usePortalReject(ldId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => portalRejectLabel(ldId, reason),
    onSuccess: () => _invalidatePortalLabel(qc, ldId),
  });
}
