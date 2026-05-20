import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { ProposalSignForm } from "./sign-form";


export default async function PortalProposalSignPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect(`/portal/login`);
  }

  const base = env.NEXT_PUBLIC_API_URL;
  const res = await fetch(`${base}/api/portal/proposals/${id}/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 404) notFound();
  if (res.status === 401 || res.status === 403) redirect("/portal/login");
  if (!res.ok) notFound();

  const proposal = await res.json();
  return (
    <PortalShell>
      <ProposalSignForm
        proposalId={id}
        code={proposal?.code || "Proposal"}
        status={proposal?.status || "unknown"}
      />
    </PortalShell>
  );
}
