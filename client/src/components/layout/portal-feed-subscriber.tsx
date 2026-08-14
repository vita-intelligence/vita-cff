"use client";

/**
 * Invisible client component that mounts :func:`usePortalFeed` for
 * the current portal session. Slotted inside the portal ``layout``
 * so every portal route inherits the live-feed subscription
 * without per-page wiring.
 *
 * Mirror of :class:`OrgFeedSubscriber` for the staff side.
 */

import { usePortalFeed } from "@/lib/live/use-portal-feed";


export function PortalFeedSubscriber() {
  usePortalFeed();
  return null;
}
