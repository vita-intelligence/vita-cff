/**
 * Brutalist Suspense fallback for the proposal-decline surface.
 */
import { PortalLoadingSkeleton } from "@/components/loading/portal-loading-skeleton";


export default function PortalProposalRejectLoading() {
  return <PortalLoadingSkeleton label="Loading decline form" />;
}
