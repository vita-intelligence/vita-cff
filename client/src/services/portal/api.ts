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
}


// --- Inbox (bell badge + dropdown) ----------------------------------------


export interface PortalInboxThread {
  readonly entity_kind: "proposal" | "specification";
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
