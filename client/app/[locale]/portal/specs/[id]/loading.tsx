/**
 * Suspense fallback for ``/portal/specs/[id]/*``. Matches the
 * portal proposal detail loader so navigating between the two
 * customer surfaces feels uniform.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function PortalSpecDetailLoading() {
  return <DetailPageSkeleton label="Loading specification" />;
}
