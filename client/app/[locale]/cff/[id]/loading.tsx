/**
 * Suspense fallback for ``/cff/[id]/*``. Mirrors the project +
 * proposal detail loaders so the operator gets the same orb +
 * skeleton treatment regardless of which detail surface they're
 * navigating into.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function CFFDetailLoading() {
  return <DetailPageSkeleton label="Loading CFF" />;
}
