import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { PortalProposalView } from "./portal-proposal-view";


/**
 * Server shell for ``/portal/proposals/<id>``. The interactive
 * piece (proposal + spec previews, ack checkboxes, signature
 * dialog, finalize) lives in :component:`PortalProposalView` —
 * we just gate the route here so an unauthenticated visitor
 * never sees the surrounding chrome.
 */
export default async function PortalProposalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect(`/portal/login`);
  }

  // One server-side existence probe so a bad id 404s before any
  // markup ships. The client view will refetch as it mounts; that
  // request inherits the same cookie via the shared apiClient.
  const res = await fetch(
    `${env.NEXT_PUBLIC_API_URL}/api/portal/proposals/${id}/`,
    {
      cache: "no-store",
      headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
    },
  ).catch(() => null);

  if (!res) notFound();
  if (res.status === 401 || res.status === 403) redirect("/portal/login");
  if (res.status === 404) notFound();
  if (!res.ok) notFound();

  return (
    <PortalShell>
      <PortalProposalView proposalId={id} />
    </PortalShell>
  );
}
