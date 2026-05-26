/**
 * TanStack Query hooks for the messenger inbox.
 *
 * Three caches share one root key:
 *
 * * ``inboxQueryKeys.list()`` — the dropdown's thread list.
 * * ``inboxQueryKeys.unreadCount()`` — the bell badge.
 * * ``inboxQueryKeys.readState(kind, id)`` — placeholder for any
 *   future per-thread metadata; today's mark-read mutation only
 *   needs to invalidate the two above.
 *
 * The WebSocket layer (``InboxSocket``) drives invalidations live;
 * polling fallbacks here are slow on purpose (60s) so a tab that
 * loses WS for a while still reconciles without hammering the API.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  fetchInbox,
  fetchInboxUnreadCount,
  markThreadRead,
} from "./api";
import type {
  InboxEntityKind,
  InboxListResponseDto,
  InboxUnreadCountDto,
  ThreadMarkReadResponseDto,
} from "./types";

const inboxRoot = [...rootQueryKey, "inbox"] as const;

export const inboxQueryKeys = {
  all: inboxRoot,
  list: () => [...inboxRoot, "list"] as const,
  unreadCount: () => [...inboxRoot, "unread_count"] as const,
} as const;

export function useInboxList(options: {
  readonly enabled?: boolean;
} = {}): UseQueryResult<InboxListResponseDto, ApiError> {
  return useQuery<InboxListResponseDto, ApiError>({
    queryKey: inboxQueryKeys.list(),
    queryFn: fetchInbox,
    enabled: options.enabled ?? true,
    // WS pushes are the primary freshness driver; the slow poll is a
    // belt-and-braces net for any tab that missed an event.
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}

export function useInboxUnreadCount(options: {
  readonly enabled?: boolean;
} = {}): UseQueryResult<InboxUnreadCountDto, ApiError> {
  return useQuery<InboxUnreadCountDto, ApiError>({
    queryKey: inboxQueryKeys.unreadCount(),
    queryFn: fetchInboxUnreadCount,
    enabled: options.enabled ?? true,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}

interface MarkReadVars {
  readonly entityKind: InboxEntityKind;
  readonly entityId: string;
  readonly at?: string;
  readonly visibility?: "internal" | "shared";
}

export function useMarkThreadRead(): UseMutationResult<
  ThreadMarkReadResponseDto,
  ApiError,
  MarkReadVars
> {
  const queryClient = useQueryClient();
  return useMutation<ThreadMarkReadResponseDto, ApiError, MarkReadVars>({
    mutationFn: markThreadRead,
    onSuccess: () => {
      // Both queries depend on the read pointer; refetch them both.
      // The bell badge update is the user-visible signal so we keep
      // the round-trip in the critical path.
      queryClient.invalidateQueries({ queryKey: inboxQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: inboxQueryKeys.unreadCount(),
      });
    },
  });
}
