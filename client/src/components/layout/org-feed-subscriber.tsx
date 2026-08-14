"use client";

/**
 * Invisible client component that mounts :func:`useOrgFeed` for the
 * active organisation. Slotted inside :class:`ProtectedHeader` so
 * every authenticated staff page picks up the live-feed
 * subscription automatically — the page component itself doesn't
 * need to know about it.
 *
 * Returns ``null`` — its only job is to open the WebSocket and
 * fan-out invalidations for the lifetime of the mount. The socket
 * is ref-counted in the shared registry
 * (:file:`lib/live/org-feed-socket.ts`), so a page that also mounts
 * ``useOrgFeed`` directly (e.g. via ``usePaymentsLive``) shares one
 * underlying connection rather than opening a second.
 */

import { useOrgFeed } from "@/lib/live/use-org-feed";


export function OrgFeedSubscriber({ orgId }: { orgId: string }) {
  useOrgFeed(orgId);
  return null;
}
