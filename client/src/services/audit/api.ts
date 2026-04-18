/**
 * Raw Axios calls for the audit log domain.
 *
 * ``fetchAuditLogPage`` supports both the initial page (``cursor``
 * empty) and subsequent pages (``cursor`` is the opaque token the
 * server returned on ``next``). Filters flatten to the query string
 * exactly as the backend expects them — empty strings are dropped
 * so the cache key is stable when the user clears a filter.
 */

import { apiClient } from "@/lib/api";

import { auditEndpoints } from "./endpoints";
import type {
  AuditLogFilters,
  PaginatedAuditLogDto,
} from "./types";


export async function fetchAuditLogPage(
  orgId: string,
  options: {
    cursor: string | null;
    pageSize?: number;
    filters?: AuditLogFilters;
  } = { cursor: null },
): Promise<PaginatedAuditLogDto> {
  const params: Record<string, string | number> = {};
  if (options.cursor) params.cursor = options.cursor;
  if (options.pageSize) params.page_size = options.pageSize;
  const filters = options.filters ?? {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim()) {
      params[key] = value.trim();
    }
  }
  const { data } = await apiClient.get<PaginatedAuditLogDto>(
    auditEndpoints.list(orgId),
    { params },
  );
  return data;
}
