/**
 * TanStack Query hooks for the proposals domain.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import type { RenderedSheetContext } from "@/services/specifications";

import {
  addProposalLine,
  completeProposalRequiredFields,
  createProposal,
  createProposalBundle,
  deleteProposal,
  deleteProposalLine,
  fetchCostPreview,
  fetchProposal,
  fetchProposalActivity,
  fetchProposalAttachedSpec,
  fetchProposalAudit,
  fetchProposalLines,
  fetchProposalTransitions,
  fetchProposalsPage,
  patchProposalLine,
  sendProposalTestEmail,
  sendProposalToClient,
  transitionProposalStatus,
  updateProposal,
} from "./api";
import type {
  CostPreviewDto,
  CreateProposalBundleRequestDto,
  CreateProposalLineRequestDto,
  CreateProposalRequestDto,
  PaginatedProposalsDto,
  ProposalActivityDto,
  ProposalAuditDto,
  ProposalDto,
  ProposalLineDto,
  ProposalStatusRequestDto,
  ProposalTransitionDto,
  UpdateProposalLineRequestDto,
  UpdateProposalRequestDto,
} from "./types";


/**
 * Args accepted by the list + infinite-list hooks. Single source of
 * truth for the filter shape — the cache key derives from this so a
 * field added here is automatically a cache-distinguishing key.
 */
export interface ProposalsListArgs {
  readonly formulationId?: string;
  /** Director approval inbox uses the single-value form. */
  readonly status?: string;
  /** Multi-select status (list bar). */
  readonly statuses?: readonly string[];
  readonly search?: string;
  readonly salesPersonId?: string;
  readonly validUntilFrom?: string;
  readonly validUntilTo?: string;
  /** ``"custom"`` (manually authored) or ``"ready_to_go"``
   *  (auto-drafted by the customer portal RTG flow). Rendered as a
   *  top-of-list tab on the org proposals page. */
  readonly templateType?: "custom" | "ready_to_go";
}


/** Build the order-insensitive cache fragment for a filter set. Used
 *  by both the single-page and infinite query keys so re-ordering
 *  status chips (or omitting an unused filter) doesn't fragment the
 *  cache. */
function listKeyFragment(args: ProposalsListArgs): readonly unknown[] {
  return [
    args.formulationId ?? "__all__",
    args.status ?? "__any__",
    [...(args.statuses ?? [])].sort().join(","),
    args.search ?? "",
    args.salesPersonId ?? "",
    args.validUntilFrom ?? "",
    args.validUntilTo ?? "",
    args.templateType ?? "__all__",
  ] as const;
}


export const proposalsQueryKeys = {
  all: [rootQueryKey, "proposals"] as const,
  /** Single-page list cache. Pair with :func:`useProposalsPage` —
   *  the small surfaces (approvals inbox, signed archive, per-project
   *  history) that pull one large page rather than streaming. */
  list: (orgId: string, args: ProposalsListArgs, pageSize?: number) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      "list",
      ...listKeyFragment(args),
      pageSize ?? "default",
    ] as const,
  /** Infinite (cursor) list cache. Pair with
   *  :func:`useInfiniteProposals` — the org-wide list page that
   *  virtualises rows and auto-loads the next cursor. */
  infinite: (orgId: string, args: ProposalsListArgs) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      "infinite",
      ...listKeyFragment(args),
    ] as const,
  detail: (orgId: string, proposalId: string) =>
    [rootQueryKey, "proposals", orgId, proposalId] as const,
  transitions: (orgId: string, proposalId: string) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      proposalId,
      "transitions",
    ] as const,
  audit: (orgId: string, proposalId: string) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      proposalId,
      "audit",
    ] as const,
  activity: (orgId: string, proposalId: string) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      proposalId,
      "activity",
    ] as const,
  costPreview: (orgId: string, versionId: string, margin?: string) =>
    [
      rootQueryKey,
      "proposals",
      "cost-preview",
      orgId,
      versionId,
      margin ?? "",
    ] as const,
  attachedSpecRender: (
    orgId: string,
    proposalId: string,
    sheetId: string,
  ) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      proposalId,
      "attached-spec-render",
      sheetId,
    ] as const,
};


/**
 * Cursor-paginated infinite-scroll fetch for the org-wide proposals
 * list. Mirrors :func:`useInfiniteFormulations`: the caller supplies
 * filters + page size, the hook re-keys on those so switching
 * filters starts a clean paged cache, and ``next`` / ``previous``
 * URLs from the server are walked verbatim.
 *
 * For short, single-screen surfaces (approvals inbox, signed
 * archive, per-project history) use :func:`useProposalsPage` with a
 * large ``pageSize`` instead — those views don't want infinite-scroll
 * UX, they want every row visible at once.
 */
export function useInfiniteProposals(
  orgId: string,
  args: ProposalsListArgs & {
    readonly pageSize?: number;
    /** Override the default ``Boolean(orgId)`` gate — callers that
     *  fan out one query per pipeline column pass ``false`` on
     *  columns whose stage doesn't intersect the active status
     *  filter so the query never fires for a bucket that must be
     *  empty. */
    readonly enabled?: boolean;
  } = {},
): UseInfiniteQueryResult<
  InfiniteData<PaginatedProposalsDto, string | null>,
  ApiError
> {
  const { pageSize, enabled, ...filters } = args;
  return useInfiniteQuery<
    PaginatedProposalsDto,
    ApiError,
    InfiniteData<PaginatedProposalsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: proposalsQueryKeys.infinite(orgId, filters),
    queryFn: ({ pageParam }) =>
      fetchProposalsPage(orgId, {
        ...filters,
        pageSize,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    enabled: Boolean(orgId) && (enabled ?? true),
  });
}


/**
 * Single-page fetch — for surfaces that render every row on one
 * screen and don't need a "load more" affordance. Pass a large
 * ``pageSize`` (up to the backend's ``max_page_size`` of 500) to
 * pull the whole roster in one round-trip.
 *
 * The returned ``data.results`` is the array clients want; use
 * :func:`useInfiniteProposals` instead when you need cursor
 * traversal.
 */
export function useProposalsPage(
  orgId: string,
  args: ProposalsListArgs = {},
  pageSize?: number,
): UseQueryResult<PaginatedProposalsDto, ApiError> {
  return useQuery<PaginatedProposalsDto, ApiError>({
    queryKey: proposalsQueryKeys.list(orgId, args, pageSize),
    queryFn: () => fetchProposalsPage(orgId, { ...args, pageSize }),
    enabled: Boolean(orgId),
  });
}


export function useProposal(
  orgId: string,
  proposalId: string,
): UseQueryResult<ProposalDto, ApiError> {
  return useQuery<ProposalDto, ApiError>({
    queryKey: proposalsQueryKeys.detail(orgId, proposalId),
    queryFn: () => fetchProposal(orgId, proposalId),
    enabled: Boolean(orgId && proposalId),
  });
}


/** Render the spec sheet attached to ``proposalId`` via the
 *  proposal-scoped passthrough. Use this on the proposal detail
 *  page instead of ``useRenderedSpecification`` so members with
 *  only ``proposals.view`` (e.g. sales) can read the spec. */
export function useProposalAttachedSpec(
  orgId: string,
  proposalId: string,
  sheetId: string,
): UseQueryResult<RenderedSheetContext, ApiError> {
  return useQuery<RenderedSheetContext, ApiError>({
    queryKey: proposalsQueryKeys.attachedSpecRender(
      orgId,
      proposalId,
      sheetId,
    ),
    queryFn: () => fetchProposalAttachedSpec(orgId, proposalId, sheetId),
    enabled: Boolean(orgId && proposalId && sheetId),
  });
}


export function useProposalTransitions(
  orgId: string,
  proposalId: string,
): UseQueryResult<ProposalTransitionDto[], ApiError> {
  return useQuery<ProposalTransitionDto[], ApiError>({
    queryKey: proposalsQueryKeys.transitions(orgId, proposalId),
    queryFn: () => fetchProposalTransitions(orgId, proposalId),
    enabled: Boolean(orgId && proposalId),
  });
}


/**
 * Staff-side e-signature audit trail. ``enabled`` is gated on the
 * caller so the read only fires once the proposal has been signed
 * (otherwise every detail-page mount would make a render call for
 * nothing). Refetches on demand to re-verify the hash without
 * stomping the cached row.
 */
export function useProposalAudit(
  orgId: string,
  proposalId: string,
  enabled: boolean = true,
): UseQueryResult<ProposalAuditDto, ApiError> {
  return useQuery<ProposalAuditDto, ApiError>({
    queryKey: proposalsQueryKeys.audit(orgId, proposalId),
    queryFn: () => fetchProposalAudit(orgId, proposalId),
    enabled: Boolean(orgId && proposalId && enabled),
    staleTime: 0,
  });
}


/**
 * Customer-portal activity timeline for one proposal.
 *
 * Distinct from :func:`useProposalAudit` — that one renders the
 * e-signature trail and is only meaningful once the customer has
 * signed. This one renders the *engagement* trail: did they open
 * the link, did they sign in, did they view the proposal, where in
 * the flow did they stop. Enabled by default — even an unsent
 * proposal is allowed to return an empty list rather than gate the
 * hook so the panel renders a clean "Not yet opened" empty state
 * whenever it mounts.
 */
export function useProposalActivity(
  orgId: string,
  proposalId: string,
  enabled: boolean = true,
): UseQueryResult<ProposalActivityDto, ApiError> {
  return useQuery<ProposalActivityDto, ApiError>({
    queryKey: proposalsQueryKeys.activity(orgId, proposalId),
    queryFn: () => fetchProposalActivity(orgId, proposalId),
    enabled: Boolean(orgId && proposalId && enabled),
    // Activity is append-only and customer-driven — poll-on-focus
    // gives staff a fresh read when they tab back without forcing
    // every render to re-fetch.
    staleTime: 30_000,
  });
}


export function useCostPreview(
  orgId: string,
  versionId: string | null,
  marginPercent: string,
): UseQueryResult<CostPreviewDto, ApiError> {
  return useQuery<CostPreviewDto, ApiError>({
    queryKey: proposalsQueryKeys.costPreview(
      orgId,
      versionId ?? "",
      marginPercent,
    ),
    queryFn: () => fetchCostPreview(orgId, versionId!, marginPercent),
    enabled: Boolean(orgId && versionId),
    staleTime: 30_000,
  });
}


export function useCreateProposal(
  orgId: string,
): UseMutationResult<ProposalDto, ApiError, CreateProposalRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<ProposalDto, ApiError, CreateProposalRequestDto>({
    mutationFn: (payload) => createProposal(orgId, payload),
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, created.id),
        created,
      );
    },
  });
}


//: Bulk-create — N spec sheets → one :class:`Proposal`. Cache
//: invalidation mirrors :func:`useCreateProposal` so the /signed
//: archive + the org-wide list update immediately after the
//: modal closes and the caller navigates to the new detail page.
export function useCreateProposalBundle(
  orgId: string,
): UseMutationResult<
  ProposalDto,
  ApiError,
  CreateProposalBundleRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProposalDto,
    ApiError,
    CreateProposalBundleRequestDto
  >({
    mutationFn: (payload) => createProposalBundle(orgId, payload),
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, created.id),
        created,
      );
    },
  });
}


export function useUpdateProposal(
  orgId: string,
  proposalId: string,
): UseMutationResult<ProposalDto, ApiError, UpdateProposalRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<ProposalDto, ApiError, UpdateProposalRequestDto>({
    mutationFn: (payload) => updateProposal(orgId, proposalId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, proposalId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
    },
  });
}


/**
 * Fill missing required-for-sent fields on an already-approved
 * proposal. Backend whitelists the keys and verifies each is
 * actually flagged missing, so this can't be used as a back-door to
 * mutate content the director already approved.
 */
export function useCompleteProposalRequiredFields(
  orgId: string,
  proposalId: string,
): UseMutationResult<ProposalDto, ApiError, Record<string, string>> {
  const queryClient = useQueryClient();
  return useMutation<ProposalDto, ApiError, Record<string, string>>({
    mutationFn: (patch) =>
      completeProposalRequiredFields(orgId, proposalId, patch),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, proposalId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
    },
  });
}


export function useDeleteProposal(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (proposalId) => deleteProposal(orgId, proposalId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
    },
  });
}


// ---------------------------------------------------------------------------
// Line CRUD
// ---------------------------------------------------------------------------


export function useProposalLines(
  orgId: string,
  proposalId: string,
): UseQueryResult<ProposalLineDto[], ApiError> {
  return useQuery<ProposalLineDto[], ApiError>({
    queryKey: [rootQueryKey, "proposal-lines", orgId, proposalId] as const,
    queryFn: () => fetchProposalLines(orgId, proposalId),
    enabled: Boolean(orgId && proposalId),
  });
}


export function useAddProposalLine(
  orgId: string,
  proposalId: string,
): UseMutationResult<
  ProposalLineDto,
  ApiError,
  CreateProposalLineRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProposalLineDto,
    ApiError,
    CreateProposalLineRequestDto
  >({
    mutationFn: (payload) => addProposalLine(orgId, proposalId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposal-lines", orgId, proposalId],
      });
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.detail(orgId, proposalId),
      });
    },
  });
}


export function usePatchProposalLine(
  orgId: string,
  proposalId: string,
): UseMutationResult<
  ProposalLineDto,
  ApiError,
  { lineId: string; payload: UpdateProposalLineRequestDto }
> {
  const queryClient = useQueryClient();
  return useMutation<
    ProposalLineDto,
    ApiError,
    { lineId: string; payload: UpdateProposalLineRequestDto }
  >({
    mutationFn: ({ lineId, payload }) =>
      patchProposalLine(orgId, proposalId, lineId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposal-lines", orgId, proposalId],
      });
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.detail(orgId, proposalId),
      });
    },
  });
}


export function useDeleteProposalLine(
  orgId: string,
  proposalId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (lineId) =>
      deleteProposalLine(orgId, proposalId, lineId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposal-lines", orgId, proposalId],
      });
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.detail(orgId, proposalId),
      });
    },
  });
}


export function useTransitionProposalStatus(
  orgId: string,
  proposalId: string,
): UseMutationResult<ProposalDto, ApiError, ProposalStatusRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<ProposalDto, ApiError, ProposalStatusRequestDto>({
    mutationFn: (payload) =>
      transitionProposalStatus(orgId, proposalId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, proposalId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.transitions(orgId, proposalId),
      });
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
    },
  });
}


/**
 * Send a preview of the customer email to a test recipient. The
 * proposal stays at its current status — useful for sales staff
 * to eyeball the final layout in their own inbox before clicking
 * "Send to client" for real. ``recipient`` is optional; the backend
 * defaults to the logged-in user's email when omitted.
 */
export function useSendProposalTestEmail(
  orgId: string,
  proposalId: string,
): UseMutationResult<
  { readonly recipient: string; readonly subject: string },
  ApiError,
  { readonly recipient?: string; readonly subject: string; readonly body_text: string }
> {
  return useMutation({
    mutationFn: (payload) =>
      sendProposalTestEmail(orgId, proposalId, payload),
  });
}


/**
 * Atomic "email + flip-to-sent" mutation for an approved proposal.
 * On success the detail cache is replaced with the freshly-returned
 * proposal (now at status ``sent``) and the status-transitions
 * timeline is invalidated so the new entry shows up.
 */
export function useSendProposalToClient(
  orgId: string,
  proposalId: string,
): UseMutationResult<
  ProposalDto,
  ApiError,
  {
    readonly recipient: string;
    readonly subject: string;
    readonly body_text: string;
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
  }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload) =>
      sendProposalToClient(orgId, proposalId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        proposalsQueryKeys.detail(orgId, proposalId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.transitions(orgId, proposalId),
      });
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "proposals", orgId],
      });
    },
  });
}
