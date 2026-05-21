/**
 * Suspense fallback for ``/proposals/[id]/*``. Same shape as the
 * project detail loader so navigating between sibling detail
 * surfaces feels visually consistent.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function ProposalDetailLoading() {
  return <DetailPageSkeleton label="Loading proposal" />;
}
