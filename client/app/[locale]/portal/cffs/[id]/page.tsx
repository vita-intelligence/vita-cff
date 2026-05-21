import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { PortalCFFView } from "./portal-cff-view";


export default async function PortalCFFDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const res = await fetch(
    `${env.NEXT_PUBLIC_API_URL}/api/portal/cffs/${id}/`,
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
    <PortalShell active="cff">
      <PortalCFFView submissionId={id} />
    </PortalShell>
  );
}
