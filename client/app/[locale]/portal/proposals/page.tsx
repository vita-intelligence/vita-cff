import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";

import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import {
  Card,
  EmptyState,
  Eyebrow,
  PageHeader,
  PortalShell,
  StatusPill,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


interface ProposalListResponse {
  results: Array<{
    id: string;
    code: string;
    title: string;
    status: string;
    updated_at: string;
    created_at: string;
  }>;
}


export default async function PortalProposalsListPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/portal/proposals/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  const data: ProposalListResponse =
    res && res.ok ? await res.json() : { results: [] };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="All proposals"
        title="Your proposals"
        subtitle="Every proposal Vita has shared with you. Open one to read, sign or message the team."
        back={{ href: "/portal", label: "Portal" }}
      />

      {data.results.length === 0 ? (
        <EmptyState
          title="No proposals yet"
          body="When Vita sends you a proposal, it will appear here. Your sales contact will let you know."
        />
      ) : (
        <div className="grid gap-4">
          {data.results.map((p) => (
            <Card key={p.id} hover className="!p-0">
              <Link
                href={`/portal/proposals/${p.id}`}
                className="flex items-center justify-between gap-6 p-6 sm:p-7"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <Eyebrow>{p.code || "Proposal"}</Eyebrow>
                  <div className="text-lg font-black uppercase tracking-tight">
                    {p.title || p.code || "Proposal"}
                  </div>
                  <div className="text-[11px] uppercase tracking-widest text-neutral-500">
                    Updated {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <StatusPill status={p.status} />
                  <LinkIconSlot
                    idleIcon={<ArrowRight className="h-5 w-5" />}
                    spinnerSizeClassName="h-5 w-5"
                  />
                </div>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
