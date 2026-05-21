/**
 * Suspense fallback for ``/catalogues/[slug]/[id]/*`` — single
 * catalogue item detail. Same orb + skeleton language as every
 * other detail surface.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function CatalogueItemLoading() {
  return <DetailPageSkeleton label="Loading item" />;
}
