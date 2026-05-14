/**
 * Raw Axios calls for the members-administration domain.
 */

import { apiClient } from "@/lib/api";

import { membersEndpoints } from "./endpoints";
import type {
  MembershipDto,
  ModuleDefinitionDto,
  UpdateMembershipGroupsRequestDto,
  UpdateMembershipPermissionsRequestDto,
} from "./types";


export async function listMemberships(
  orgId: string,
  args: {
    /** Narrow the roster to one role tag (plus owners). Passes
     *  through as ``?group=sales`` etc. */
    readonly group?: string;
  } = {},
): Promise<readonly MembershipDto[]> {
  const params: Record<string, string> = {};
  if (args.group) params.group = args.group;
  const { data } = await apiClient.get<readonly MembershipDto[]>(
    membersEndpoints.list(orgId),
    { params },
  );
  return data;
}


export async function updateMembershipGroups(
  orgId: string,
  membershipId: string,
  payload: UpdateMembershipGroupsRequestDto,
): Promise<MembershipDto> {
  const { data } = await apiClient.patch<MembershipDto>(
    membersEndpoints.groups(orgId, membershipId),
    payload,
  );
  return data;
}


export async function updateMembershipPermissions(
  orgId: string,
  membershipId: string,
  payload: UpdateMembershipPermissionsRequestDto,
): Promise<MembershipDto> {
  const { data } = await apiClient.patch<MembershipDto>(
    membersEndpoints.detail(orgId, membershipId),
    payload,
  );
  return data;
}


export async function removeMembership(
  orgId: string,
  membershipId: string,
): Promise<void> {
  await apiClient.delete(membersEndpoints.detail(orgId, membershipId));
}


export async function listModules(): Promise<
  readonly ModuleDefinitionDto[]
> {
  const { data } = await apiClient.get<readonly ModuleDefinitionDto[]>(
    membersEndpoints.modules(),
  );
  return data;
}
