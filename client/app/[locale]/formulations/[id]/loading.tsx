/**
 * Suspense fallback for ``/formulations/[id]/*``.
 *
 * Fires while the project layout + page server-render. Lives at
 * the segment level so it overrides the parent
 * :file:`[locale]/loading.tsx` overlay with an in-content
 * skeleton — the operator keeps the page chrome and gets a clear
 * "loading project" cue inside the content area instead of a
 * full-screen takeover.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function ProjectDetailLoading() {
  return <DetailPageSkeleton label="Loading project" />;
}
