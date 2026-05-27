import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, ExternalLink, PlusCircle } from "lucide-react";

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
    <PortalShell active="products">
      <PageHeader
        eyebrow="All requests"
        title="Your custom formulation requests"
        subtitle="Every request you've submitted to Vita. Open one to re-read your answers and continue the conversation."
        back={{ href: "/portal", label: "Portal" }}
      />

      {/* "Start a new project" CTA. The form itself is hosted on the
          marketing site (vitamanufacture.co.uk) — the Wix submission
          is mirrored into our system by the CFF poller, so every new
          request that lands there shows up in this list automatically.
          ``rel="noopener noreferrer"`` because we're sending the
          customer out of the portal. */}
      <div className="mb-6 flex flex-col gap-3 border-2 border-black bg-orange-500 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-black">
            Start a new project
          </p>
          <p className="mt-1 text-sm font-semibold text-black">
            Fill in the custom formulation request form and we'll pick it up
            from there.
          </p>
        </div>
        <a
          href="https://www.vitamanufacture.co.uk/custom-formulation-request-form"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <PlusCircle className="h-4 w-4" />
          New request
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

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
