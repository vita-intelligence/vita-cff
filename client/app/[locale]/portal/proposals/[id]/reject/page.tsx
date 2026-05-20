import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";

import { ProposalRejectForm } from "./reject-form";


export default async function PortalProposalRejectPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  if (!jar.get("vita_portal_access")) {
    redirect(`/portal/login`);
  }
  return (
    <PortalShell>
      <ProposalRejectForm proposalId={id} />
    </PortalShell>
  );
}
