/**
 * TanStack Query hooks for the audit log domain.
 */

import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";

import { fetchAuditLogPage } from "./api";
import type { AuditLogFilters, PaginatedAuditLogDto } from "./types";


export const auditQueryKeys = {
  all: ["audit"] as const,
  list: (orgId: string, filters: AuditLogFilters) =>
    ["audit", "list", orgId, filters] as const,
};


/**
 * Infinite-scroll page loader for the org-wide audit trail.
 *
 * ``filters`` becomes part of the cache key, so changing a filter
 * spawns a fresh query rather than re-paginating the old result
 * set. Empty / whitespace filter values are normalised to ``""``
 * up-stream so typing and then clearing a field doesn't produce
 * two distinct cache entries.
 */
export function useInfiniteAuditLog(
  orgId: string,
  filters: AuditLogFilters,
  options: { pageSize?: number } = {},
): UseInfiniteQueryResult<
  InfiniteData<PaginatedAuditLogDto, string | null>,
  ApiError
> {
  const cleanedFilters: AuditLogFilters = Object.fromEntries(
    Object.entries(filters).filter(
      ([, v]) => typeof v === "string" && v.trim().length > 0,
    ),
  );

  return useInfiniteQuery<
    PaginatedAuditLogDto,
    ApiError,
    InfiniteData<PaginatedAuditLogDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: auditQueryKeys.list(orgId, cleanedFilters),
    queryFn: ({ pageParam }) =>
      fetchAuditLogPage(orgId, {
        cursor: pageParam,
        pageSize: options.pageSize,
        filters: cleanedFilters,
      }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.next) return null;
      // Backend returns a full URL; we only need the cursor query
      // parameter — axios appends the rest of the path itself.
      try {
        const url = new URL(lastPage.next);
        return url.searchParams.get("cursor");
      } catch {
        return null;
      }
    },
    enabled: Boolean(orgId),
  });
}
