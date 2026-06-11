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

/**
 * Snapshot of the inbox caches taken at the start of a mark-read
 * mutation so ``onError`` can roll back to a coherent state if the
 * server roundtrip fails.
 */
interface MarkReadOptimisticContext {
  readonly previousList: InboxListResponseDto | undefined;
  readonly previousUnread: InboxUnreadCountDto | undefined;
}

function threadMatchesMarkRead(
  thread: { entity_kind: string; entity_id: string; visibility: string },
  vars: MarkReadVars,
): boolean {
  if (thread.entity_kind !== vars.entityKind) return false;
  if (thread.entity_id !== vars.entityId) return false;
  // The mutation may target a specific lane — match it. When the
  // caller omits ``visibility`` (legacy code path) we clear every
  // lane for the entity, matching the server's "blank pointer
  // covers all lanes" fallback.
  if (vars.visibility && thread.visibility !== vars.visibility) return false;
  return true;
}

export function useMarkThreadRead(): UseMutationResult<
  ThreadMarkReadResponseDto,
  ApiError,
  MarkReadVars,
  MarkReadOptimisticContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ThreadMarkReadResponseDto,
    ApiError,
    MarkReadVars,
    MarkReadOptimisticContext
  >({
    mutationFn: markThreadRead,
    // Patch both caches before the network roundtrip so the badge
    // and the row's count clear the instant the user opens a thread.
    // The legacy ``invalidateQueries`` approach paid a full inbox
    // refetch (50+ DB queries on the server) before the badge moved
    // — that latency is what made the notifications feel "sticky".
    onMutate: async (vars) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: inboxQueryKeys.list() }),
        queryClient.cancelQueries({ queryKey: inboxQueryKeys.unreadCount() }),
      ]);

      const previousList = queryClient.getQueryData<InboxListResponseDto>(
        inboxQueryKeys.list(),
      );
      const previousUnread = queryClient.getQueryData<InboxUnreadCountDto>(
        inboxQueryKeys.unreadCount(),
      );

      let cleared = 0;
      if (previousList) {
        const nextThreads = previousList.threads.map((thread) => {
          if (!threadMatchesMarkRead(thread, vars)) return thread;
          cleared += thread.unread_count;
          if (thread.unread_count === 0) return thread;
          return { ...thread, unread_count: 0 };
        });
        queryClient.setQueryData<InboxListResponseDto>(
          inboxQueryKeys.list(),
          {
            ...previousList,
            threads: nextThreads,
            total_unread: Math.max(0, previousList.total_unread - cleared),
          },
        );
      }

      if (previousUnread) {
        // Fall back to the cleared total if the list cache is
        // primed; otherwise leave the unread count untouched and
        // let the server reconcile via WS / next poll. Better to
        // under-clear briefly than to render a wrong negative.
        if (cleared > 0) {
          queryClient.setQueryData<InboxUnreadCountDto>(
            inboxQueryKeys.unreadCount(),
            {
              unread_count: Math.max(
                0,
                previousUnread.unread_count - cleared,
              ),
            },
          );
        }
      }

      return { previousList, previousUnread };
    },
    onError: (_err, _vars, context) => {
      // Roll back to the pre-mutation snapshot so a failed POST
      // does not leave the badge / list lying about the state.
      if (context?.previousList) {
        queryClient.setQueryData(
          inboxQueryKeys.list(),
          context.previousList,
        );
      }
      if (context?.previousUnread) {
        queryClient.setQueryData(
          inboxQueryKeys.unreadCount(),
          context.previousUnread,
        );
      }
    },
    // No ``invalidateQueries`` on success — the optimistic patch
    // already matches what the server just wrote (the mark-read
    // endpoint only bumps the pointer, doesn't append messages),
    // and the WS layer + 60s poll fallback reconcile any drift.
  });
}
