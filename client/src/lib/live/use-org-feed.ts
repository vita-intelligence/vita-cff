/**
 * ``useOrgFeed(orgId)`` — subscribe every list on the page to the
 * org-scoped live feed.
 *
 * Mount this hook at the top of any page that renders lists of
 * entities the backend fans out (CFF / project / proposal / trial
 * batch / label design / specification / payment). Every
 * ``entity.changed`` event received translates into a coarse-grained
 * TanStack Query invalidation of that entity family — TanStack
 * refetches only what's currently mounted, so a page that only
 * shows proposals ignores payment events for free.
 *
 * The invalidation is org-scoped where the query key includes the
 * org id (e.g. payments: ``[root, "payments", orgId]``), and flat
 * where it doesn't (e.g. formulations: ``[root, "formulations"]``).
 * TanStack matches by prefix so ``invalidateQueries({queryKey: [root,
 * "payments"]})`` clears every payments-shaped cache regardless of
 * status / detail / pagination sub-keys.
 *
 * Also invalidates the whole map on socket ``open`` — belt-and-
 * braces for events pushed during a disconnected interval (proxy
 * hiccup, sleep/resume, initial mount).
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { rootQueryKey } from "@/lib/query";
import {
  openOrgFeedSocket,
  type EntityChangedPayload,
} from "./org-feed-socket";


/** Maps a backend ``entity`` slug to the TanStack Query key prefix
 *  that every query for that family shares. Keep in sync with each
 *  service's ``*QueryKeys`` object:
 *
 *   * ``services/payments/index.ts``     → ``paymentsQueryKeys`` (root: "payments")
 *   * ``services/cff-submissions/*``     → ``cffQueryKeys.all`` (root: "cff")
 *   * ``services/formulations/*``        → ``formulationsQueryKeys.all`` (root: "formulations")
 *   * ``services/proposals/*``           → ``proposalsQueryKeys.all`` (root: "proposals")
 *   * ``services/trial_batches/*``       → ``trialBatchesQueryKeys.all`` (root: "trial-batches")
 *   * ``services/label-design/*``        → ``labelDesignKeys.all`` (root: "label-design")
 *   * ``services/specifications/*``      → ``specificationsQueryKeys.all`` (root: "specifications")
 *
 * If a new entity is added on the backend (``EntityKind`` in
 * :mod:`apps.organizations.live`), add its slug here.
 */
const ENTITY_QUERY_ROOTS: Record<string, string> = {
  payment: "payments",
  cff_submission: "cff",
  formulation: "formulations",
  proposal: "proposals",
  trial_batch: "trial-batches",
  label_design: "label-design",
  specification: "specifications",
};


/** Subscribe the current page to the org's live feed for the
 *  duration of the component's lifetime. Idempotent — mounting
 *  ``useOrgFeed(orgId)`` in two components on one page shares one
 *  underlying socket via the ref-counted registry.
 */
export function useOrgFeed(orgId: string): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!orgId) return undefined;

    const invalidateForEntity = (entity: string) => {
      const root = ENTITY_QUERY_ROOTS[entity];
      if (!root) {
        // Unknown entity — a backend kind that predates this FE
        // deploy. Coarse-grained fallback: invalidate everything
        // under ``rootQueryKey`` so nothing goes silently stale.
        qc.invalidateQueries({ queryKey: rootQueryKey });
        return;
      }
      qc.invalidateQueries({ queryKey: [...rootQueryKey, root] });
    };

    const invalidateEverything = () => {
      for (const root of Object.values(ENTITY_QUERY_ROOTS)) {
        qc.invalidateQueries({ queryKey: [...rootQueryKey, root] });
      }
    };

    const handlers = {
      // Reconcile on reconnect — a tab that missed events during a
      // disconnect window otherwise stays stale until the next
      // window-focus or the 5s staleTime elapses. Doing this coarse
      // is cheap: only mounted caches actually re-fetch.
      onConnect: invalidateEverything,
      onEntityChanged: (payload: EntityChangedPayload) =>
        invalidateForEntity(payload.entity),
    };

    const handle = openOrgFeedSocket(orgId, handlers);
    return () => handle.release();
  }, [qc, orgId]);
}
