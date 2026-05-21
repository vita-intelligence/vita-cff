/**
 * Brutalist Suspense fallback for the signing surface. Distinct
 * label so the operator can tell the routing landed on the right
 * step ("Loading signing form" vs the detail page).
 */
import { PortalLoadingSkeleton } from "@/components/loading/portal-loading-skeleton";


export default function PortalProposalSignLoading() {
  return <PortalLoadingSkeleton label="Loading signing form" />;
}
