/**
 * Suspense fallback for ``/settings/*``. Covers every settings
 * subroute (members, integrations, organization, audit log) so
 * the operator gets the same orb + skeleton treatment when
 * jumping between settings pages.
 */
import { DetailPageSkeleton } from "@/components/loading/detail-page-skeleton";


export default function SettingsLoading() {
  return <DetailPageSkeleton label="Loading settings" />;
}
