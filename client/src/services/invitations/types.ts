/**
 * Transport types for the invitations domain. Mirrors the backend
 * serializers in ``apps/organizations/api/serializers.py``.
 */

import type { UserDto } from "@/services/accounts/types";


/** A flat-module capability list or a row-scoped per-slug capability
 *  map — the same shape we persist on ``Membership.permissions``. */
export type PermissionsDict = Readonly<
  Record<
    string,
    readonly string[] | Readonly<Record<string, readonly string[]>>
  >
>;


/** Minimal user identity embedded in member + invitation rows so the
 *  settings UI can render a row without a second round-trip. */
export interface NestedUserDto {
  readonly id: string;
  readonly email: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly full_name: string;
}


export type InvitationStatus = "pending" | "expired" | "accepted";


/** Owner-facing view. Exposes the raw token so the admin can assemble
 *  a shareable link; used for both the create response and the list
 *  endpoint. */
export interface InvitationDto {
  readonly id: string;
  readonly email: string;
  readonly token: string;
  readonly permissions: PermissionsDict;
  readonly invited_by: NestedUserDto;
  readonly status: InvitationStatus;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly created_at: string;
}


/** Public view shown on the accept page. Deliberately minimal. */
export interface PublicInvitationDto {
  readonly email: string;
  readonly organization_name: string;
  readonly invited_by_name: string;
  readonly expires_at: string;
}


export interface CreateInvitationRequestDto {
  readonly email: string;
  readonly permissions?: PermissionsDict;
}


export interface AcceptInvitationRequestDto {
  readonly first_name: string;
  readonly last_name: string;
  readonly password: string;
  readonly password_confirm: string;
}


/** Accepting an invitation issues auth cookies and returns the new user. */
export type AcceptInvitationResponseDto = UserDto;
