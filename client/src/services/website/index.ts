/**
 * Website integration — access tokens the marketing site presents
 * when calling NPD's ``/api/website/*`` surface. Sits alongside
 * ``services/psp`` — same shape, distinct namespace so a website-
 * token rotation doesn't disturb PSP and vice versa.
 */

export const websiteEndpoints = {
  accessTokens: (orgId: string) =>
    `/api/organizations/${orgId}/integrations/website-access-tokens/`,
  accessTokenRevoke: (orgId: string, tokenId: string) =>
    `/api/organizations/${orgId}/integrations/website-access-tokens/${tokenId}/revoke/`,
} as const;


export interface WebsiteAccessTokenDto {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly is_active: boolean;
  readonly created_at: string | null;
  readonly created_by_name: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by_name: string | null;
  readonly revoke_reason: string | null;
}


export interface WebsiteAccessTokenListDto {
  readonly items: readonly WebsiteAccessTokenDto[];
}


/** One-shot response body from mint. ``token`` is the RAW bearer
 *  string — appears here exactly once and must be rendered to the
 *  operator immediately + dropped. */
export interface WebsiteAccessTokenMintResponseDto {
  readonly token: string;
  readonly record: WebsiteAccessTokenDto;
}


import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { apiClient, type ApiError } from "@/lib/api";


export async function fetchWebsiteAccessTokens(
  orgId: string,
): Promise<WebsiteAccessTokenListDto> {
  const { data } = await apiClient.get<WebsiteAccessTokenListDto>(
    websiteEndpoints.accessTokens(orgId),
  );
  return data;
}


export async function mintWebsiteAccessToken(
  orgId: string,
  input: { name: string },
): Promise<WebsiteAccessTokenMintResponseDto> {
  const { data } = await apiClient.post<WebsiteAccessTokenMintResponseDto>(
    websiteEndpoints.accessTokens(orgId),
    { name: input.name },
  );
  return data;
}


export async function revokeWebsiteAccessToken(
  orgId: string,
  tokenId: string,
  input: { reason?: string } = {},
): Promise<{ record: WebsiteAccessTokenDto }> {
  const { data } = await apiClient.post<{ record: WebsiteAccessTokenDto }>(
    websiteEndpoints.accessTokenRevoke(orgId, tokenId),
    { reason: input.reason ?? "" },
  );
  return data;
}


export function websiteAccessTokensQueryKey(orgId: string) {
  return ["website", orgId, "access-tokens"] as const;
}


export function useWebsiteAccessTokens(
  orgId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<WebsiteAccessTokenListDto, ApiError> {
  return useQuery<WebsiteAccessTokenListDto, ApiError>({
    queryKey: websiteAccessTokensQueryKey(orgId),
    queryFn: () => fetchWebsiteAccessTokens(orgId),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}


export function useMintWebsiteAccessToken(
  orgId: string,
): UseMutationResult<
  WebsiteAccessTokenMintResponseDto,
  ApiError,
  { name: string }
> {
  const qc = useQueryClient();
  return useMutation<
    WebsiteAccessTokenMintResponseDto,
    ApiError,
    { name: string }
  >({
    mutationFn: (input) => mintWebsiteAccessToken(orgId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: websiteAccessTokensQueryKey(orgId) });
    },
  });
}


export function useRevokeWebsiteAccessToken(
  orgId: string,
): UseMutationResult<
  { record: WebsiteAccessTokenDto },
  ApiError,
  { tokenId: string; reason?: string }
> {
  const qc = useQueryClient();
  return useMutation<
    { record: WebsiteAccessTokenDto },
    ApiError,
    { tokenId: string; reason?: string }
  >({
    mutationFn: ({ tokenId, reason }) =>
      revokeWebsiteAccessToken(orgId, tokenId, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: websiteAccessTokensQueryKey(orgId) });
    },
  });
}
