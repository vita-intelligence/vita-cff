/**
 * TanStack Query hooks for the proposals domain.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  addProposalLine,
  createProposal,
  deleteProposal,
  deleteProposalLine,
  fetchCostPreview,
  fetchProposal,
  fetchProposalAudit,
  fetchProposalLines,
  fetchProposalTransitions,
  fetchProposals,
  patchProposalLine,
  sendProposalTestEmail,
  sendProposalToClient,
  transitionProposalStatus,
  updateProposal,
} from "./api";
import type {
  CostPreviewDto,
  CreateProposalLineRequestDto,
  CreateProposalRequestDto,
  ProposalAuditDto,
  ProposalDto,
  ProposalLineDto,
  ProposalStatusRequestDto,
  ProposalTransitionDto,
  UpdateProposalLineRequestDto,
  UpdateProposalRequestDto,
} from "./types";


export const proposalsQueryKeys = {
  all: [rootQueryKey, "proposals"] as const,
  list: (
    orgId: string,
    formulationId?: string,
    status?: string,
  ) =>
    [
      rootQueryKey,
      "proposals",
      orgId,
      formulationId ?? "__all__",
      status ?? "__any__",
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
  costPreview: (orgId: string, versionId: string, margin?: string) =>
    [
      rootQueryKey,
      "proposals",
      "cost-preview",
      orgId,
      versionId,
      margin ?? "",
    ] as const,
};


export function useProposals(
  orgId: string,
  args: { formulationId?: string; status?: string } = {},
): UseQueryResult<ProposalDto[], ApiError> {
  const { formulationId, status } = args;
  return useQuery<ProposalDto[], ApiError>({
    queryKey: proposalsQueryKeys.list(orgId, formulationId, status),
    queryFn: () => fetchProposals(orgId, { formulationId, status }),
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
