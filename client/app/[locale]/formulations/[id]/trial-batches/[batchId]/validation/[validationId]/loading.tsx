/**
 * Suspense fallback for one product-validation run inside a
 * trial batch. Same orb + skeleton language as every other
 * detail route.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function ValidationRunLoading() {
  return <DetailPageSkeleton label="Loading validation" />;
}
