/**
 * Suspense fallback for ``/portal/proposals/[id]/*``. The customer
 * lands here from the portal hub or the bell dropdown; same orb +
 * skeleton treatment the staff detail routes use so the visual
 * language stays consistent across both surfaces.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function PortalProposalDetailLoading() {
  return <DetailPageSkeleton label="Loading proposal" />;
}
