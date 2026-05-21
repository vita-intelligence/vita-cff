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


interface CFFListResponse {
  results: Array<{
    id: string;
    submitted_at: string;
    status: string;
    has_project: boolean;
    project_code: string | null;
    summary: string;
  }>;
}


export default async function PortalCFFsListPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/portal/cffs/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  const data: CFFListResponse =
    res && res.ok ? await res.json() : { results: [] };

  return (
    <PortalShell active="cff">
      <PageHeader
        eyebrow="All requests"
        title="Your custom formulation requests"
        subtitle="Every request you've submitted to Vita. Open one to re-read your answers and continue the conversation."
        back={{ href: "/portal", label: "Portal" }}
      />

      {data.results.length === 0 ? (
        <EmptyState
          title="No requests yet"
          body="When you submit a custom formulation request through the Vita NPD form, it will appear here."
        />
      ) : (
        <div className="grid gap-4">
          {data.results.map((cff) => {
            const submitted = new Date(cff.submitted_at);
            const submittedLabel = Number.isNaN(submitted.getTime())
              ? "—"
              : submitted.toLocaleDateString();
            return (
              <Card key={cff.id} hover className="!p-0">
                <Link
                  href={`/portal/cffs/${cff.id}`}
                  className="flex items-center justify-between gap-6 p-6 sm:p-7"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <Eyebrow>
                      {cff.project_code
                        ? `Request · ${cff.project_code}`
                        : `Request · ${cff.id.slice(0, 8)}`}
                    </Eyebrow>
                    <div className="text-lg font-black uppercase tracking-tight">
                      {cff.summary || "Custom formulation request"}
                    </div>
                    <div className="text-[11px] uppercase tracking-widest text-neutral-500">
                      Submitted {submittedLabel}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <StatusPill status={cff.status} />
                    <LinkIconSlot
                      idleIcon={<ArrowRight className="h-5 w-5" />}
                      spinnerSizeClassName="h-5 w-5"
                    />
                  </div>
                </Link>
              </Card>
            );
          })}
        </div>
      )}
    </PortalShell>
  );
}
