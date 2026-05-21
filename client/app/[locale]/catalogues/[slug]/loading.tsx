/**
 * Suspense fallback for ``/catalogues/[slug]/*``. Catalogue tables
 * can carry thousands of rows; the detail-page skeleton signals
 * progress while the server paginates the first page.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function CatalogueDetailLoading() {
  return <DetailPageSkeleton label="Loading catalogue" />;
}
