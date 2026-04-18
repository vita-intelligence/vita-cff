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
  readonly created_at: string;
  readonly updated_at: string;
}


export interface UpdateMembershipPermissionsRequestDto {
  readonly permissions: PermissionsDict;
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
