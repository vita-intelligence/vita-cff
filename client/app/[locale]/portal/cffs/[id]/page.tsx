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

  // Swap-in-place: once triage links the CFF to a Formulation the
  // customer's mental model is "this is now my project workspace".
  // Hard-redirect to the product page so the full pipeline (draft
  // spec → proposal → sample selection → …) takes over the URL
  // instead of the stale CFF-form record. Only walk this branch when
  // ``project_id`` is populated — a pending or rejected CFF still
  // renders its own detail here.
  const cff = (await res.json()) as {
    has_project?: boolean;
    project_id?: string | null;
  };
  if (cff.has_project && cff.project_id) {
    redirect(`/portal/products/${cff.project_id}`);
  }

  return (
    <PortalShell active="products">
      <PortalCFFView submissionId={id} />
    </PortalShell>
  );
}
