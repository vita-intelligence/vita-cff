/**
 * Transport types for the members-administration domain.
 *
 * The ``PermissionsDict`` shape is re-exported from the invitations
 * service (they share the storage shape), so consumers don't have to
 * pick a side when they import it from here.
 */

import type {
  NestedUserDto,
  PermissionsDict,
} from "@/services/invitations/types";


/** One row in the Settings > Members table. */
export interface MembershipDto {
  readonly id: string;
  readonly user: NestedUserDto;
  readonly is_owner: boolean;
  readonly permissions: PermissionsDict;
  /** Picker-scoping tags. Currently a subset of
   *  ``"scientist" | "sales"``; the backend silently drops unknown
   *  values so a future tag drop won't 400 a stale client. */
  readonly groups: readonly MembershipGroup[];
  readonly created_at: string;
  readonly updated_at: string;
}


/** Role tags admins can assign in Members > Edit. Drives the
 *  picker scope on the staff queues (scientist on /rd-pipeline,
 *  sales on /pipeline, designer on /labelling, finance on
 *  /finance). The frontend list and the backend
 *  ``MEMBERSHIP_GROUPS`` frozenset must stay in lockstep. */
export const MEMBERSHIP_GROUPS = [
  "scientist",
  "sales",
  "designer",
  "finance",
] as const;
export type MembershipGroup = (typeof MEMBERSHIP_GROUPS)[number];


export interface UpdateMembershipPermissionsRequestDto {
  readonly permissions: PermissionsDict;
}


export interface UpdateMembershipGroupsRequestDto {
  readonly groups: readonly MembershipGroup[];
}


/** One module declared in the backend registry. ``capabilities`` is
 *  the tuple the backend accepts on ``PATCH`` payloads; anything else
 *  will be silently dropped server-side, so the UI renders from this
 *  list to avoid showing a checkbox that can never be saved. */
export interface ModuleDefinitionDto {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly row_scoped: boolean;
  readonly capabilities: readonly string[];
}


export type { NestedUserDto, PermissionsDict } from "@/services/invitations/types";
