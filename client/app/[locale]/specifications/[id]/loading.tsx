/**
 * Suspense fallback for ``/specifications/[id]/*``. Same
 * brand-consistent orb + skeleton the other detail routes use.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function SpecificationDetailLoading() {
  return <DetailPageSkeleton label="Loading specification" />;
}
