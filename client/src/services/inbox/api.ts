/**
 * Raw axios calls for the messenger inbox.
 */

import { apiClient } from "@/lib/api";

import { inboxEndpoints } from "./endpoints";
import type {
  InboxEntityKind,
  InboxListResponseDto,
  InboxUnreadCountDto,
  ThreadMarkReadResponseDto,
} from "./types";

export async function fetchInbox(): Promise<InboxListResponseDto> {
  const response = await apiClient.get<InboxListResponseDto>(
    inboxEndpoints.list(),
  );
  return response.data;
}

export async function fetchInboxUnreadCount(): Promise<InboxUnreadCountDto> {
  const response = await apiClient.get<InboxUnreadCountDto>(
    inboxEndpoints.unreadCount(),
  );
  return response.data;
}

export async function markThreadRead(args: {
  readonly entityKind: InboxEntityKind;
  readonly entityId: string;
  /** Optional ISO timestamp — defaults server-side to now(). Pass an
   *  explicit value when the caller knows exactly which message the
   *  user last saw (e.g. scroll-to-bottom of a specific row). */
  readonly at?: string;
  /** Visibility lane to mark read. Omit to write the legacy
   *  ``visibility=""`` row (preserves pre-split behavior so older
   *  callers keep working unchanged). Pass ``"internal"`` /
   *  ``"shared"`` to clear only the matching lane's unread count
   *  without touching its sibling lane. */
  readonly visibility?: "internal" | "shared";
}): Promise<ThreadMarkReadResponseDto> {
  const body: Record<string, string> = {};
  if (args.at) body.at = args.at;
  if (args.visibility) body.visibility = args.visibility;
  const response = await apiClient.post<ThreadMarkReadResponseDto>(
    inboxEndpoints.markRead(args.entityKind, args.entityId),
    body,
  );
  return response.data;
}
