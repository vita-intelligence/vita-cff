/**
 * REST wrappers for the proposals domain.
 */

import { apiClient } from "@/lib/api";
import type { RenderedSheetContext } from "@/services/specifications";

import { proposalsEndpoints } from "./endpoints";
import type {
  CostPreviewDto,
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
 * Query args accepted by :func:`fetchProposalsPage`. Mirrors the
 * filter set the org-wide list bar exposes, plus the pagination
 * controls owned by the cursor pagination class on the backend.
 */
export interface FetchProposalsPageArgs {
  readonly formulationId?: string;
  /** Single-value status filter — used by the director approval
   *  inbox, the signed archive (one query per lifecycle state), and
   *  any other "give me everything in status X" view. */
  readonly status?: string;
  /** Multi-select status filter — used by the org-wide list bar's
   *  chip strip. */
  readonly statuses?: readonly string[];
  readonly search?: string;
  /** UUID, or ``"unassigned"`` for the no-owner bucket. */
  readonly salesPersonId?: string;
  /** ISO ``YYYY-MM-DD``. Inclusive bound. */
  readonly validUntilFrom?: string;
  /** ISO ``YYYY-MM-DD``. Inclusive bound. */
  readonly validUntilTo?: string;
  /** ``"custom"`` (manually authored proposals) or ``"ready_to_go"``
   *  (auto-drafted by the customer portal RTG flow). Omitted / any
   *  other value means "no template filter". */
  readonly templateType?: "custom" | "ready_to_go" | "";
  /** Cap per response. Default 50 (matches the cursor page size).
   *  Short surfaces (approvals inbox, signed archive) bump this to
   *  ~500 so the entire roster lands in one page without an
   *  infinite-scroll harness. */
  readonly pageSize?: number;
  /** Full ``next`` / ``previous`` URL from a prior cursor response.
   *  When set, every other arg is ignored and the request is sent
   *  verbatim — the cursor opaquely encodes them. */
  readonly cursorUrl?: string | null;
}


/**
 * Fetch one cursor page of proposals. The list endpoint is now
 * paginated server-side (was returning the org's full roster on
 * every open — the source of the "slow proposals page" report); the
 * frontend walks ``next`` / ``previous`` to stream forward or jumps
 * straight to a large ``pageSize`` for short surfaces.
 */
export async function fetchProposalsPage(
  orgId: string,
  args: FetchProposalsPageArgs = {},
): Promise<PaginatedProposalsDto> {
  // Cursor-URL path: the server's encoded link already carries every
  // filter + the cursor position, so we re-issue it as-is and ignore
  // any other arg the caller might have re-passed.
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedProposalsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }

  const params = new URLSearchParams();
  if (args.pageSize) params.set("page_size", String(args.pageSize));
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
  if (args.templateType) params.set("template_type", args.templateType);
  const qs = params.toString();
  const url = qs
    ? `${proposalsEndpoints.list(orgId)}?${qs}`
    : proposalsEndpoints.list(orgId);
  const { data } = await apiClient.get<PaginatedProposalsDto>(url);
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


/** Fetch the rendered view-model for a spec sheet that's attached
 *  to ``proposalId``. Gated by the proposals module so sales can
 *  read it without holding ``formulations.view``. */
export async function fetchProposalAttachedSpec(
  orgId: string,
  proposalId: string,
  sheetId: string,
): Promise<RenderedSheetContext> {
  const { data } = await apiClient.get<RenderedSheetContext>(
    proposalsEndpoints.attachedSpecRender(orgId, proposalId, sheetId),
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
 * Fetch the customer-side portal activity timeline for a proposal.
 *
 * Backed by :class:`apps.proposals.api.views.ProposalActivityView`.
 * Returns up to the last 200 :class:`PortalEvent` rows newest-first,
 * plus a per-kind summary the panel uses for the compact "first /
 * last seen" header line.
 */
export async function fetchProposalActivity(
  orgId: string,
  proposalId: string,
): Promise<ProposalActivityDto> {
  const { data } = await apiClient.get<ProposalActivityDto>(
    proposalsEndpoints.activity(orgId, proposalId),
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
