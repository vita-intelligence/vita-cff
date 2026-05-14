/**
 * REST wrappers for the proposals domain.
 */

import { apiClient } from "@/lib/api";

import { proposalsEndpoints } from "./endpoints";
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


export async function fetchProposals(
  orgId: string,
  args: {
    formulationId?: string;
    /** Single-value status (used by the director approval inbox). */
    status?: string;
    /** Multi-select status for the org-wide list bar. */
    statuses?: readonly string[];
    search?: string;
    /** UUID, or ``"unassigned"`` for the no-owner bucket. */
    salesPersonId?: string;
    /** ISO ``YYYY-MM-DD``. Inclusive bound. */
    validUntilFrom?: string;
    /** ISO ``YYYY-MM-DD``. Inclusive bound. */
    validUntilTo?: string;
  } = {},
): Promise<ProposalDto[]> {
  const params = new URLSearchParams();
  if (args.formulationId) params.set("formulation_id", args.formulationId);
  if (args.status) params.set("status", args.status);
  if (args.statuses) {
    for (const s of args.statuses) params.append("statuses", s);
  }
  if (args.search && args.search.trim())
    params.set("search", args.search.trim());
  if (args.salesPersonId) params.set("sales_person_id", args.salesPersonId);
  if (args.validUntilFrom) params.set("valid_until_from", args.validUntilFrom);
  if (args.validUntilTo) params.set("valid_until_to", args.validUntilTo);
  const qs = params.toString();
  const url = qs
    ? `${proposalsEndpoints.list(orgId)}?${qs}`
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

/**
 * Fill required-for-sent fields on a proposal that's already in
 * ``approved``. The backend whitelists the keys and only accepts
 * values for fields it currently reports as missing, so the
 * director's signature stays attached to a proposal whose blank
 * slots are being filled — not one whose reviewed content is
 * being rewritten.
 */
export async function completeProposalRequiredFields(
  orgId: string,
  proposalId: string,
  patch: Record<string, string>,
): Promise<ProposalDto> {
  const { data } = await apiClient.post<ProposalDto>(
    proposalsEndpoints.completeRequiredFields(orgId, proposalId),
    { patch },
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

/**
 * Fetch the e-signature audit trail for a proposal — staff-side
 * surface that returns who signed, from where, when, with what
 * client, plus a live SHA-256 hash check against the document at
 * sign time. Mismatched hashes mean the contract drifted post-sign;
 * matched hashes are court-ready evidence.
 */
export async function fetchProposalAudit(
  orgId: string,
  proposalId: string,
): Promise<ProposalAuditDto> {
  const { data } = await apiClient.get<ProposalAuditDto>(
    proposalsEndpoints.audit(orgId, proposalId),
  );
  return data;
}


/**
 * Send a preview of the customer email to a test recipient (defaults
 * to the caller's own email on the backend if ``recipient`` is left
 * empty). The proposal status is NOT changed — this is a preview-
 * to-myself affordance for the compose modal, not part of the
 * customer-facing send flow.
 */
export async function sendProposalTestEmail(
  orgId: string,
  proposalId: string,
  payload: {
    readonly recipient?: string;
    readonly subject: string;
    readonly body_text: string;
  },
): Promise<{ readonly recipient: string; readonly subject: string }> {
  const { data } = await apiClient.post<{
    readonly recipient: string;
    readonly subject: string;
  }>(proposalsEndpoints.sendTestEmail(orgId, proposalId), payload);
  return data;
}


/**
 * Atomic "email + flip-to-sent" for an approved proposal.
 *
 * Either the customer receives the email AND the proposal advances
 * to ``sent`` in the same request, or neither happens (status stays
 * ``approved`` and the modal surfaces the SMTP error so the sales
 * person can retry).
 */
export async function sendProposalToClient(
  orgId: string,
  proposalId: string,
  payload: {
    readonly recipient: string;
    readonly subject: string;
    readonly body_text: string;
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
  },
): Promise<ProposalDto> {
  const { data } = await apiClient.post<ProposalDto>(
    proposalsEndpoints.sendToClient(orgId, proposalId),
    payload,
  );
  return data;
}
