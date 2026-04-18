/**
 * TanStack Query hooks for the invitations domain.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { accountsQueryKeys } from "@/services/accounts";
import { organizationsQueryKeys } from "@/services/organizations";

import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "./api";
import type {
  AcceptInvitationRequestDto,
  AcceptInvitationResponseDto,
  CreateInvitationRequestDto,
  InvitationDto,
} from "./types";


export const invitationsQueryKeys = {
  all: ["invitations"] as const,
  list: (orgId: string) =>
    [...invitationsQueryKeys.all, "list", orgId] as const,
};


export function useInvitations(
  orgId: string,
  options: { readonly initialData?: readonly InvitationDto[] } = {},
): UseQueryResult<readonly InvitationDto[], ApiError> {
  return useQuery<readonly InvitationDto[], ApiError>({
    queryKey: invitationsQueryKeys.list(orgId),
    queryFn: () => listInvitations(orgId),
    initialData: options.initialData,
    // Listed invitations change frequently (send/revoke/resend), so
    // keep them fresh without being spammy.
    staleTime: 10_000,
  });
}


export function useCreateInvitation(
  orgId: string,
): UseMutationResult<InvitationDto, ApiError, CreateInvitationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<InvitationDto, ApiError, CreateInvitationRequestDto>({
    mutationFn: (payload) => createInvitation(orgId, payload),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: invitationsQueryKeys.list(orgId),
      }),
  });
}


export function useResendInvitation(
  orgId: string,
): UseMutationResult<InvitationDto, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<InvitationDto, ApiError, string>({
    mutationFn: (invitationId) => resendInvitation(orgId, invitationId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: invitationsQueryKeys.list(orgId),
      }),
  });
}


export function useRevokeInvitation(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (invitationId) => revokeInvitation(orgId, invitationId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: invitationsQueryKeys.list(orgId),
      }),
  });
}


export function useAcceptInvitation(
  token: string,
): UseMutationResult<
  AcceptInvitationResponseDto,
  ApiError,
  AcceptInvitationRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    AcceptInvitationResponseDto,
    ApiError,
    AcceptInvitationRequestDto
  >({
    mutationFn: (payload) => acceptInvitation(token, payload),
    onSuccess: async (user) => {
      // Prime the /me cache so the server-side auth guard on /home
      // sees the new session immediately on the next navigation, and
      // invalidate the org list so the new org appears.
      queryClient.setQueryData(accountsQueryKeys.me(), user);
      await queryClient.invalidateQueries({
        queryKey: organizationsQueryKeys.list(),
      });
    },
  });
}
