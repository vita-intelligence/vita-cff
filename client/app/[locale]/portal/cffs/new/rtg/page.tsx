import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PageHeader, PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import {
  RTGOrderWizard,
  type PortalRTGCatalogItem,
  type ProfileShape,
} from "./rtg-order-wizard";


interface CatalogResponse {
  readonly results: ReadonlyArray<PortalRTGCatalogItem>;
}


/**
 * Ready-to-Go order surface — SSR shell that fetches the customer's
 * profile and the catalog for their org, then hands both to the
 * client wizard. Same auth pattern as the sibling Custom-track
 * page: the portal cookie is checked first, 401 / 403 bounce to
 * ``/portal/login`` to keep the FE middleware's mental model
 * consistent.
 *
 * Rendered at ``/portal/cffs/new/rtg`` so the URL history reflects
 * the customer's track pick without collapsing the two flows onto
 * one route.
 */
export default async function PortalRTGPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [profileRes, catalogRes] = await Promise.all([
    fetch(`${base}/api/portal/profile/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
    fetch(`${base}/api/portal/rtg-catalog/`, {
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

  const catalog: CatalogResponse =
    catalogRes && catalogRes.ok
      ? await catalogRes.json()
      : { results: [] };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Ready-to-Go catalog"
        title="Order a validated product"
        subtitle="Pick a product below, tell us quantity + packaging, and we'll draft a proposal you can sign — no development cycle."
        back={{ href: "/portal/cffs/new", label: "Back to track" }}
      />
      <RTGOrderWizard
        profile={profile}
        catalog={catalog.results ?? []}
      />
    </PortalShell>
  );
}
