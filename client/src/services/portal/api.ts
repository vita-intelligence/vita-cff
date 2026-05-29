/**
 * HTTP client for the customer portal.
 *
 * All requests are same-origin via Next's ``/api/*`` rewrite. The
 * portal cookie (``vita_portal_access``) sets / clears
 * automatically on the responses; no token plumbing needed in
 * client code.
 */

import { apiClient } from "@/lib/api";
import type {
  ActivationPreviewDto,
  PortalMeDto,
  PortalMessageDto,
  PortalMessagesDto,
  PortalProfileDto,
  PortalProposalListDto,
  ProfileUpdate,
} from "./types";


export async function previewActivation(token: string): Promise<ActivationPreviewDto> {
  const { data } = await apiClient.get<ActivationPreviewDto>(
    `/api/portal/activate/${token}/preview/`,
  );
  return data;
}


export async function activate(
  token: string,
  password: string,
  code: string,
): Promise<PortalMeDto> {
  const { data } = await apiClient.post<PortalMeDto>(
    `/api/portal/activate/${token}/`,
    { password, code },
  );
  return data;
}


export interface ActivationCodeRequestResult {
  readonly sent: boolean;
  readonly email_masked: string;
  /** Seconds the FE should wait before re-enabling the "Resend code"
   *  button. The server enforces the same cooldown on its side. */
  readonly retry_after_seconds: number;
}


/**
 * Ask the backend to mint + email a fresh 6-digit activation code
 * for the proposal that owns ``token``. Auto-fired on the code step
 * of the activation form, and on every "Resend code" click.
 *
 * Returns the cooldown the FE should use for its countdown. The
 * backend separately enforces the same window — a hammered Resend
 * click yields a 429 with ``retry_after_seconds`` so the FE can
 * resync.
 */
export async function requestActivationCode(
  token: string,
): Promise<ActivationCodeRequestResult> {
  const { data } = await apiClient.post<ActivationCodeRequestResult>(
    `/api/portal/activate/${token}/request-code/`,
    {},
  );
  return data;
}


/**
 * Redeem a staff-issued :class:`CustomerPortalInvite` and finish
 * activation. Same response shape as :func:`activate`; the only
 * difference is the URL — the public preview/redemption pair lives
 * under ``/api/portal/invites/<token>/`` and operates against a
 * customer record rather than a proposal token.
 */
export async function activateInvite(
  token: string,
  password: string,
  code: string,
): Promise<PortalMeDto> {
  const { data } = await apiClient.post<PortalMeDto>(
    `/api/portal/invites/${token}/activate/`,
    { password, code },
  );
  return data;
}


export async function login(email: string, password: string): Promise<PortalMeDto> {
  const { data } = await apiClient.post<PortalMeDto>(
    "/api/portal/auth/login/",
    { email, password },
  );
  return data;
}


export async function logout(): Promise<void> {
  await apiClient.post("/api/portal/auth/logout/", {});
}


export async function fetchMe(): Promise<PortalMeDto> {
  const { data } = await apiClient.get<PortalMeDto>("/api/portal/auth/me/");
  return data;
}


export async function requestPasswordReset(email: string): Promise<void> {
  await apiClient.post("/api/portal/auth/password-reset/request/", { email });
}


export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<PortalMeDto> {
  const { data } = await apiClient.post<PortalMeDto>(
    "/api/portal/auth/password-reset/confirm/",
    { token, new_password: newPassword },
  );
  return data;
}


export async function fetchProposals(): Promise<PortalProposalListDto> {
  const { data } = await apiClient.get<PortalProposalListDto>(
    "/api/portal/proposals/",
  );
  return data;
}


export async function fetchProposal(id: string): Promise<unknown> {
  const { data } = await apiClient.get(`/api/portal/proposals/${id}/`);
  return data;
}


export async function rejectProposal(id: string, reason: string): Promise<unknown> {
  const { data } = await apiClient.post(
    `/api/portal/proposals/${id}/reject/`,
    { reason },
  );
  return data;
}


export async function finalizeProposal(id: string): Promise<unknown> {
  const { data } = await apiClient.post(
    `/api/portal/proposals/${id}/finalize/`,
    {},
  );
  return data;
}


export interface SignProposalPayload {
  readonly signature_image: string;
  readonly ack_spec_signing?: boolean;
  readonly ack_lead_times?: boolean;
  readonly ack_terms?: boolean;
  readonly ack_rd_terms?: boolean;
}


export async function signProposal(
  id: string,
  payload: SignProposalPayload,
): Promise<unknown> {
  const { data } = await apiClient.post(
    `/api/portal/proposals/${id}/sign/`,
    payload,
  );
  return data;
}


export async function signSpec(
  proposalId: string,
  sheetId: string,
  signatureImage: string,
): Promise<unknown> {
  const { data } = await apiClient.post(
    `/api/portal/proposals/${proposalId}/specs/${sheetId}/sign/`,
    { signature_image: signatureImage },
  );
  return data;
}


export async function fetchProposalMessages(
  proposalId: string,
): Promise<PortalMessagesDto> {
  const { data } = await apiClient.get<PortalMessagesDto>(
    `/api/portal/proposals/${proposalId}/messages/`,
  );
  return data;
}


export async function postSpecMessage(
  sheetId: string,
  body: string,
  parentId?: string | null,
): Promise<PortalMessageDto> {
  const payload: Record<string, unknown> = { body };
  if (parentId) payload.parent_id = parentId;
  const { data } = await apiClient.post<PortalMessageDto>(
    `/api/portal/specs/${sheetId}/messages/`,
    payload,
  );
  return data;
}


export async function markSpecMessagesRead(sheetId: string): Promise<void> {
  await apiClient.post(`/api/portal/specs/${sheetId}/messages/read/`, {});
  _emitInboxRefresh();
}


// --- Specs (standalone surface) -------------------------------------------


export interface PortalSpecListItem {
  readonly id: string;
  readonly code: string;
  readonly document_kind: string;
  readonly status: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number | null;
  readonly has_signature: boolean;
  readonly customer_signed_at: string | null;
  readonly proposal: {
    readonly id: string;
    readonly code: string;
    readonly status: string;
  } | null;
}


export async function fetchSpecs(): Promise<{
  results: PortalSpecListItem[];
}> {
  const { data } = await apiClient.get<{ results: PortalSpecListItem[] }>(
    "/api/portal/specs/",
  );
  return data;
}


export async function fetchSpec(sheetId: string): Promise<
  PortalSpecListItem & { render_context: unknown }
> {
  const { data } = await apiClient.get<
    PortalSpecListItem & { render_context: unknown }
  >(`/api/portal/specs/${sheetId}/`);
  return data;
}


// --- Proposal-level chat (distinct from per-spec threads) -----------------


export async function fetchProposalChat(proposalId: string): Promise<{
  results: PortalMessageDto[];
  read_state: string | null;
  proposal_id: string;
}> {
  const { data } = await apiClient.get<{
    results: PortalMessageDto[];
    read_state: string | null;
    proposal_id: string;
  }>(`/api/portal/proposals/${proposalId}/proposal-messages/`);
  return data;
}


export async function postProposalChatMessage(
  proposalId: string,
  body: string,
  parentId?: string | null,
): Promise<PortalMessageDto> {
  const payload: Record<string, unknown> = { body };
  if (parentId) payload.parent_id = parentId;
  const { data } = await apiClient.post<PortalMessageDto>(
    `/api/portal/proposals/${proposalId}/proposal-messages/post/`,
    payload,
  );
  return data;
}


export async function markProposalChatRead(proposalId: string): Promise<void> {
  await apiClient.post(
    `/api/portal/proposals/${proposalId}/proposal-messages/read/`,
    {},
  );
  _emitInboxRefresh();
}


/** Tell every mounted ``PortalInboxBell`` to flush its badge
 *  immediately. Fired from each ``mark*Read`` helper so the bell
 *  doesn't wait for the next 15s tick to reflect a freshly-read
 *  thread. SSR-safe (the listener side is in a useEffect). */
function _emitInboxRefresh(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("vita:portal-inbox-refresh"));
  } catch {
    // ignore
  }
}


// --- Label-design chat -------------------------------------------------


export async function fetchLabelDesignChat(labelDesignId: string): Promise<{
  results: PortalMessageDto[];
  read_state: string | null;
  label_design_id: string;
}> {
  const { data } = await apiClient.get<{
    results: PortalMessageDto[];
    read_state: string | null;
    label_design_id: string;
  }>(`/api/portal/label-designs/${labelDesignId}/messages/`);
  return data;
}


export async function postLabelDesignChatMessage(
  labelDesignId: string,
  body: string,
  parentId?: string | null,
): Promise<PortalMessageDto> {
  const payload: Record<string, unknown> = { body };
  if (parentId) payload.parent_id = parentId;
  const { data } = await apiClient.post<PortalMessageDto>(
    `/api/portal/label-designs/${labelDesignId}/messages/post/`,
    payload,
  );
  return data;
}


export async function markLabelDesignChatRead(
  labelDesignId: string,
): Promise<void> {
  await apiClient.post(
    `/api/portal/label-designs/${labelDesignId}/messages/read/`,
    {},
  );
  _emitInboxRefresh();
}


// --- CFF (Custom Formulation Request) — customer-facing -----------------
//
// The customer sees CFFs they own — by email match against the form they
// submitted OR through a project link (their proposal is on the project a
// CFF was assigned to). See ``apps.cff_submissions.services.list_customer_cffs``
// for the ownership union; the wire shape mirrors what that endpoint emits.


export interface PortalCFFListItem {
  readonly id: string;
  readonly submitted_at: string;
  readonly status: string;
  readonly has_project: boolean;
  readonly project_code: string | null;
  /** Single-line preview pulled from the customer's own answers
   *  (market segment / product type / brief) so the list reads
   *  as more than a row of timestamps. Empty string when the
   *  importer couldn't find a usable slug. */
  readonly summary: string;
}


export interface PortalCFFDetail extends PortalCFFListItem {
  readonly wix_form_id: string;
  /** Full ``raw_payload`` from Wix so the customer can re-read
   *  their own submission verbatim. Shape varies by form
   *  version — render with the same heuristic dl approach the
   *  staff CFF page uses. */
  readonly raw_payload: {
    readonly submissions?: Record<string, unknown>;
    readonly [k: string]: unknown;
  };
}


export async function fetchCFFs(): Promise<{
  results: PortalCFFListItem[];
}> {
  const { data } = await apiClient.get<{ results: PortalCFFListItem[] }>(
    "/api/portal/cffs/",
  );
  return data;
}


export async function fetchCFF(submissionId: string): Promise<PortalCFFDetail> {
  const { data } = await apiClient.get<PortalCFFDetail>(
    `/api/portal/cffs/${submissionId}/`,
  );
  return data;
}


export async function fetchCFFMessages(
  submissionId: string,
): Promise<{
  results: PortalMessageDto[];
  read_state: string | null;
  cff_id: string;
}> {
  const { data } = await apiClient.get<{
    results: PortalMessageDto[];
    read_state: string | null;
    cff_id: string;
  }>(`/api/portal/cffs/${submissionId}/messages/`);
  return data;
}


export async function postCFFMessage(
  submissionId: string,
  body: string,
  parentId?: string | null,
): Promise<PortalMessageDto> {
  const payload: Record<string, unknown> = { body };
  if (parentId) payload.parent_id = parentId;
  const { data } = await apiClient.post<PortalMessageDto>(
    `/api/portal/cffs/${submissionId}/messages/`,
    payload,
  );
  return data;
}


export async function markCFFMessagesRead(submissionId: string): Promise<void> {
  await apiClient.post(
    `/api/portal/cffs/${submissionId}/messages/read/`,
    {},
  );
  _emitInboxRefresh();
}


// --- Inbox (bell badge + dropdown) ----------------------------------------


export interface PortalInboxThread {
  readonly entity_kind:
    | "proposal"
    | "specification"
    | "cff_submission"
    | "label_design";
  readonly entity_id: string;
  readonly entity_title: string;
  readonly deep_link: string;
  readonly unread_count: number;
  readonly last_message_at: string;
  readonly last_message_preview: string;
  readonly last_message_author: {
    readonly kind: "client" | "staff" | "system";
    readonly name: string;
  };
  readonly parent_proposal?: {
    readonly id: string;
    readonly code: string;
  } | null;
}


export async function fetchPortalInbox(): Promise<{
  results: PortalInboxThread[];
  total_unread: number;
}> {
  const { data } = await apiClient.get<{
    results: PortalInboxThread[];
    total_unread: number;
  }>("/api/portal/inbox/");
  return data;
}


export async function fetchPortalUnreadCount(): Promise<number> {
  const { data } = await apiClient.get<{ unread_count: number }>(
    "/api/portal/inbox/unread_count/",
  );
  return data.unread_count;
}


export async function fetchProfile(): Promise<PortalProfileDto> {
  const { data } = await apiClient.get<PortalProfileDto>("/api/portal/profile/");
  return data;
}


export async function updateProfile(
  patch: ProfileUpdate,
): Promise<PortalProfileDto> {
  const { data } = await apiClient.patch<PortalProfileDto>(
    "/api/portal/profile/",
    patch,
  );
  return data;
}


export async function requestEmailChange(newEmail: string): Promise<void> {
  await apiClient.post("/api/portal/profile/email/request/", {
    new_email: newEmail,
  });
}


export async function confirmEmailChange(
  code: string,
): Promise<PortalProfileDto> {
  const { data } = await apiClient.post<PortalProfileDto>(
    "/api/portal/profile/email/confirm/",
    { code },
  );
  return data;
}


export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await apiClient.post("/api/portal/profile/password/", {
    current_password: currentPassword,
    new_password: newPassword,
  });
}


export async function updateAvatar(dataUrl: string): Promise<string> {
  const { data } = await apiClient.post<{ avatar_image: string }>(
    "/api/portal/profile/avatar/",
    { avatar_image: dataUrl },
  );
  return data.avatar_image;
}
