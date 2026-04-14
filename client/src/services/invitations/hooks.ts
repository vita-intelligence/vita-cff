/**
 * TanStack Query hooks for the invitations domain.
 */

import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { accountsQueryKeys } from "@/services/accounts";
import { organizationsQueryKeys } from "@/services/organizations";

import { acceptInvitation, createInvitation } from "./api";
import type {
  AcceptInvitationRequestDto,
  AcceptInvitationResponseDto,
  CreateInvitationRequestDto,
  InvitationDto,
} from "./types";

export function useCreateInvitation(
  orgId: string,
): UseMutationResult<InvitationDto, ApiError, CreateInvitationRequestDto> {
  return useMutation<InvitationDto, ApiError, CreateInvitationRequestDto>({
    mutationFn: (payload) => createInvitation(orgId, payload),
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
