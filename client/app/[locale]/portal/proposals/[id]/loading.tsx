/**
 * Suspense fallback for ``/portal/proposals/[id]/*``. Uses the
 * brutalist skeleton so the loader speaks the same design
 * language as the rest of the customer surface (black squares,
 * hard offset shadows, uppercase tracking) — the staff orb
 * sibling stays on the staff-side detail routes.
 */
import { PortalLoadingSkeleton } from "@/components/loading/portal-loading-skeleton";


export default function PortalProposalDetailLoading() {
  return <PortalLoadingSkeleton label="Loading proposal" />;
}
