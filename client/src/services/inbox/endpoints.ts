/**
 * URL constants for the messenger inbox API.
 *
 * Cross-org by design — the user's bell aggregates every chat they
 * can see across every workspace they belong to. No org prefix in
 * the path because the inbox represents the user, not one workspace.
 */

import type { InboxEntityKind } from "./types";

export const inboxEndpoints = {
  list: () => "/api/comments/inbox/",
  unreadCount: () => "/api/comments/inbox/unread_count/",
  markRead: (kind: InboxEntityKind, entityId: string) =>
    `/api/comments/threads/${kind}/${entityId}/read/`,
} as const;
