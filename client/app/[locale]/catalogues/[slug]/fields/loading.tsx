/**
 * Suspense fallback for the catalogue fields editor.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function CatalogueFieldsLoading() {
  return <DetailPageSkeleton label="Loading fields" />;
}
