/**
 * Raw Axios calls for the invitations domain.
 */

import { apiClient } from "@/lib/api";

import { invitationsEndpoints } from "./endpoints";
import type {
  AcceptInvitationRequestDto,
  AcceptInvitationResponseDto,
  CreateInvitationRequestDto,
  InvitationDto,
  PublicInvitationDto,
} from "./types";


export async function listInvitations(
  orgId: string,
): Promise<readonly InvitationDto[]> {
  const { data } = await apiClient.get<readonly InvitationDto[]>(
    invitationsEndpoints.list(orgId),
  );
  return data;
}


export async function createInvitation(
  orgId: string,
  payload: CreateInvitationRequestDto,
): Promise<InvitationDto> {
  const { data } = await apiClient.post<InvitationDto>(
    invitationsEndpoints.create(orgId),
    payload,
  );
  return data;
}


export async function resendInvitation(
  orgId: string,
  invitationId: string,
): Promise<InvitationDto> {
  const { data } = await apiClient.post<InvitationDto>(
    invitationsEndpoints.resend(orgId, invitationId),
  );
  return data;
}


export async function revokeInvitation(
  orgId: string,
  invitationId: string,
): Promise<void> {
  await apiClient.delete(invitationsEndpoints.adminDetail(orgId, invitationId));
}


export async function fetchPublicInvitation(
  token: string,
): Promise<PublicInvitationDto> {
  const { data } = await apiClient.get<PublicInvitationDto>(
    invitationsEndpoints.detail(token),
  );
  return data;
}


export async function acceptInvitation(
  token: string,
  payload: AcceptInvitationRequestDto,
): Promise<AcceptInvitationResponseDto> {
  const { data } = await apiClient.post<AcceptInvitationResponseDto>(
    invitationsEndpoints.accept(token),
    payload,
  );
  return data;
}
