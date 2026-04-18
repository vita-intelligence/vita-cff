/**
 * Raw Axios calls for the members-administration domain.
 */

import { apiClient } from "@/lib/api";

import { membersEndpoints } from "./endpoints";
import type {
  MembershipDto,
  ModuleDefinitionDto,
  UpdateMembershipPermissionsRequestDto,
} from "./types";


export async function listMemberships(
  orgId: string,
): Promise<readonly MembershipDto[]> {
  const { data } = await apiClient.get<readonly MembershipDto[]>(
    membersEndpoints.list(orgId),
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
