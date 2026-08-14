/**
 * ``usePortalFeed()`` — subscribe every list on the customer portal
 * to the org's live feed.
 *
 * Mirror of :func:`useOrgFeed` for the portal side. The customer's
 * WS connects to ``ws/portal/feed/`` and joins the same
 * ``org.feed.<uuid>`` Channels group the staff consumer joins, so
 * a staff-side mutation (proposal approved, invoice attached, label
 * design advanced) reaches the customer's tab live without a
 * reload.
 *
 * The routing table below is the customer-facing subset of the
 * staff one — portal never renders formulations / trial batches /
 * specifications lists as their own top-level pages, so those
 * entity kinds don't need portal invalidation targets. When they
 * do arrive on future portal surfaces, add them to
 * ``PORTAL_ENTITY_QUERY_ROOTS`` here.
 *
 * Note that the portal consumer forwards every event from the org
 * group — filtering happens on the FE side. A customer receiving
 * an event about an entity they don't own triggers at most one
 * wasted refetch that returns their own (unchanged) data. Cheap.
 * See :mod:`apps.client_portal.consumers` for the rationale on why
 * we don't filter server-side today.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { rootQueryKey } from "@/lib/query";

import {
  openPortalFeedSocket,
  type EntityChangedPayload,
} from "./org-feed-socket";


/** Portal surfaces today: proposals, spec sheets attached to
 *  those proposals, CFF submissions the customer authored,
 *  label designs for the customer's own projects, payments
 *  the customer placed. The keys here mirror each staff service's
 *  ``*QueryKeys`` prefix — the portal REST endpoints re-use the
 *  same TanStack Query cache namespaces (see the shared
 *  ``labelDesignKeys.portalList()`` variant) so an
 *  ``invalidateQueries`` against the root prefix clears both the
 *  staff and portal caches for that entity family without a fork.
 */
const PORTAL_ENTITY_QUERY_ROOTS: Record<string, string> = {
  payment: "payments",
  cff_submission: "cff",
  proposal: "proposals",
  label_design: "label-design",
  specification: "specifications",
};


/** Subscribe the current portal page to the live feed. Idempotent
 *  across mounts — the underlying socket is ref-counted in the
 *  shared registry. Slot this hook once inside the portal
 *  ``<layout>`` so every portal route inherits the subscription
 *  without per-page wiring.
 */
export function usePortalFeed(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const invalidateForEntity = (entity: string) => {
      const root = PORTAL_ENTITY_QUERY_ROOTS[entity];
      if (!root) {
        // Unknown / staff-only entity — do nothing. The portal
        // doesn't render this surface so nothing to refresh.
        return;
      }
      qc.invalidateQueries({ queryKey: [...rootQueryKey, root] });
    };

    const invalidateAllPortal = () => {
      for (const root of Object.values(PORTAL_ENTITY_QUERY_ROOTS)) {
        qc.invalidateQueries({ queryKey: [...rootQueryKey, root] });
      }
    };

    const handlers = {
      onConnect: invalidateAllPortal,
      onEntityChanged: (payload: EntityChangedPayload) =>
        invalidateForEntity(payload.entity),
    };

    const handle = openPortalFeedSocket(handlers);
    return () => handle.release();
  }, [qc]);
}
