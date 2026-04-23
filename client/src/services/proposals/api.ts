/**
 * REST wrappers for the proposals domain.
 */

import { apiClient } from "@/lib/api";

import { proposalsEndpoints } from "./endpoints";
import type {
  CostPreviewDto,
  CreateProposalLineRequestDto,
  CreateProposalRequestDto,
  ProposalDto,
  ProposalLineDto,
  ProposalStatusRequestDto,
  ProposalTransitionDto,
  UpdateProposalLineRequestDto,
  UpdateProposalRequestDto,
} from "./types";


export async function fetchProposals(
  orgId: string,
  formulationId?: string,
): Promise<ProposalDto[]> {
  const url = formulationId
    ? proposalsEndpoints.forFormulation(orgId, formulationId)
    : proposalsEndpoints.list(orgId);
  const { data } = await apiClient.get<ProposalDto[]>(url);
  return data;
}

export async function fetchProposal(
  orgId: string,
  proposalId: string,
): Promise<ProposalDto> {
  const { data } = await apiClient.get<ProposalDto>(
    proposalsEndpoints.detail(orgId, proposalId),
  );
  return data;
}

export async function createProposal(
  orgId: string,
  payload: CreateProposalRequestDto,
): Promise<ProposalDto> {
  const { data } = await apiClient.post<ProposalDto>(
    proposalsEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateProposal(
  orgId: string,
  proposalId: string,
  payload: UpdateProposalRequestDto,
): Promise<ProposalDto> {
  const { data } = await apiClient.patch<ProposalDto>(
    proposalsEndpoints.detail(orgId, proposalId),
    payload,
  );
  return data;
}

export async function deleteProposal(
  orgId: string,
  proposalId: string,
): Promise<void> {
  await apiClient.delete(proposalsEndpoints.detail(orgId, proposalId));
}

export async function transitionProposalStatus(
  orgId: string,
  proposalId: string,
  payload: ProposalStatusRequestDto,
): Promise<ProposalDto> {
  const { data } = await apiClient.post<ProposalDto>(
    proposalsEndpoints.status(orgId, proposalId),
    payload,
  );
  return data;
}

export async function fetchProposalTransitions(
  orgId: string,
  proposalId: string,
): Promise<ProposalTransitionDto[]> {
  const { data } = await apiClient.get<ProposalTransitionDto[]>(
    proposalsEndpoints.transitions(orgId, proposalId),
  );
  return data;
}

export async function fetchProposalLines(
  orgId: string,
  proposalId: string,
): Promise<ProposalLineDto[]> {
  const { data } = await apiClient.get<ProposalLineDto[]>(
    proposalsEndpoints.lines(orgId, proposalId),
  );
  return data;
}

export async function addProposalLine(
  orgId: string,
  proposalId: string,
  payload: CreateProposalLineRequestDto,
): Promise<ProposalLineDto> {
  const { data } = await apiClient.post<ProposalLineDto>(
    proposalsEndpoints.lines(orgId, proposalId),
    payload,
  );
  return data;
}

export async function patchProposalLine(
  orgId: string,
  proposalId: string,
  lineId: string,
  payload: UpdateProposalLineRequestDto,
): Promise<ProposalLineDto> {
  const { data } = await apiClient.patch<ProposalLineDto>(
    proposalsEndpoints.lineDetail(orgId, proposalId, lineId),
    payload,
  );
  return data;
}

export async function deleteProposalLine(
  orgId: string,
  proposalId: string,
  lineId: string,
): Promise<void> {
  await apiClient.delete(
    proposalsEndpoints.lineDetail(orgId, proposalId, lineId),
  );
}

export async function fetchCostPreview(
  orgId: string,
  versionId: string,
  marginPercent?: string,
): Promise<CostPreviewDto> {
  const { data } = await apiClient.get<CostPreviewDto>(
    proposalsEndpoints.costPreview(orgId, versionId, marginPercent),
  );
  return data;
}
