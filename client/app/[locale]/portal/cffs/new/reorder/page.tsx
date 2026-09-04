import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PageHeader, PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import {
  ReorderOrderWizard,
  type PortalReorderableFormulation,
  type ProfileShape,
} from "./reorder-order-wizard";


interface ReorderableResponse {
  readonly results: ReadonlyArray<PortalReorderableFormulation>;
  readonly next_cursor: string | null;
}


/**
 * Reorder track — customer picks one of their own past signed
 * Custom formulations and re-buys it. SSR loads the first page of
 * eligible formulations + the profile; the wizard then paginates +
 * searches client-side against `/api/portal/reorderable-formulations/`.
 *
 * Auth pattern mirrors ``/portal/cffs/new/rtg`` exactly — portal
 * cookie required, 401 / 403 bounce to ``/portal/login``.
 */
export default async function PortalReorderPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [profileRes, reorderableRes] = await Promise.all([
    fetch(`${base}/api/portal/profile/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
    fetch(`${base}/api/portal/reorderable-formulations/?limit=20`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
  ]);

  if (!profileRes || profileRes.status === 401 || profileRes.status === 403) {
    redirect("/portal/login");
  }

  const profile: ProfileShape | null =
    profileRes && profileRes.ok ? await profileRes.json() : null;
  if (!profile) {
    redirect("/portal/login");
  }

  const reorderable: ReorderableResponse =
    reorderableRes && reorderableRes.ok
      ? await reorderableRes.json()
      : { results: [], next_cursor: null };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Reorder"
        title="Re-buy a signed formulation"
        subtitle="Pick one of your own past custom formulations. We'll draft a proposal against the original signed spec — you only sign the proposal."
        back={{ href: "/portal/cffs/new", label: "Back to track" }}
      />
      <ReorderOrderWizard
        profile={profile}
        initialResults={reorderable.results ?? []}
        initialNextCursor={reorderable.next_cursor}
      />
    </PortalShell>
  );
}
