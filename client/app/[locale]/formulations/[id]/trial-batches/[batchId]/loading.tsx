/**
 * Suspense fallback for ``/formulations/[id]/trial-batches/[batchId]/*``.
 * Batches load a lot of versioned data; the orb + skeleton gives
 * the operator a clear "we're fetching this batch" cue.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function TrialBatchLoading() {
  return <DetailPageSkeleton label="Loading trial batch" />;
}
