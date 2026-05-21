/**
 * Portal-wide Suspense fallback. Overrides the staff-styled
 * :file:`[locale]/loading.tsx` orb for every route under
 * ``/portal/*`` so the customer never sees the staff orange-orb
 * loader (which uses the ink palette + rounded skeleton bars and
 * would feel like landing on the wrong app).
 *
 * Deeper portal segments (the proposal / spec detail pages)
 * override this with their own labelled loaders; everything else
 * inherits this generic "LOADING" state.
 */
import { PortalLoadingSkeleton } from "@/components/loading/portal-loading-skeleton";


export default function PortalLoading() {
  return <PortalLoadingSkeleton />;
}
