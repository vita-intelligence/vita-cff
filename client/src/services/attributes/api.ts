/**
 * Raw Axios calls for the attributes domain.
 */

import { apiClient } from "@/lib/api";

import { attributesEndpoints } from "./endpoints";
import type {
  AttributeDefinitionDto,
  CreateAttributeDefinitionRequestDto,
  UpdateAttributeDefinitionRequestDto,
} from "./types";

export async function fetchAttributeDefinitions(
  orgId: string,
  slug: string,
  options: { includeArchived?: boolean } = {},
): Promise<AttributeDefinitionDto[]> {
  const params: Record<string, string> = {};
  if (options.includeArchived) params.include_archived = "true";
  const { data } = await apiClient.get<AttributeDefinitionDto[]>(
    attributesEndpoints.list(orgId, slug),
    { params },
  );
  return data;
}

export async function createAttributeDefinition(
  orgId: string,
  slug: string,
  payload: CreateAttributeDefinitionRequestDto,
): Promise<AttributeDefinitionDto> {
  const { data } = await apiClient.post<AttributeDefinitionDto>(
    attributesEndpoints.list(orgId, slug),
    payload,
  );
  return data;
}

export async function updateAttributeDefinition(
  orgId: string,
  slug: string,
  definitionId: string,
  payload: UpdateAttributeDefinitionRequestDto,
): Promise<AttributeDefinitionDto> {
  const { data } = await apiClient.patch<AttributeDefinitionDto>(
    attributesEndpoints.detail(orgId, slug, definitionId),
    payload,
  );
  return data;
}

export async function archiveAttributeDefinition(
  orgId: string,
  slug: string,
  definitionId: string,
): Promise<void> {
  await apiClient.delete(attributesEndpoints.detail(orgId, slug, definitionId));
}
