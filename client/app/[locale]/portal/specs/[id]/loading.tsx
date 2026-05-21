/**
 * Suspense fallback for ``/portal/specs/[id]/*``. Brutalist
 * skeleton so the loader matches the customer surface's design
 * language — same treatment as the portal proposal detail
 * loader.
 */
import { PortalLoadingSkeleton } from "@/components/loading/portal-loading-skeleton";


export default function PortalSpecDetailLoading() {
  return <PortalLoadingSkeleton label="Loading specification" />;
}
