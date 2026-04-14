/**
 * Transport types for the invitations domain. Mirrors the backend
 * serializers in ``apps/organizations/api/serializers.py``.
 */

import type { UserDto } from "@/services/accounts/types";

/** Owner-facing view returned by ``POST /api/organizations/<id>/invitations/``. */
export interface InvitationDto {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly permissions: Record<string, string>;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly created_at: string;
}

/** Public view on the accept page. Deliberately minimal. */
export interface PublicInvitationDto {
  readonly email: string;
  readonly organization_name: string;
  readonly invited_by_name: string;
  readonly expires_at: string;
}

export interface CreateInvitationRequestDto {
  readonly email: string;
}

export interface AcceptInvitationRequestDto {
  readonly first_name: string;
  readonly last_name: string;
  readonly password: string;
  readonly password_confirm: string;
}

/** Accepting an invitation issues auth cookies and returns the new user. */
export type AcceptInvitationResponseDto = UserDto;
