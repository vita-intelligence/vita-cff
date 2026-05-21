import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2 } from "lucide-react";

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


interface SpecListResponse {
  results: Array<{
    id: string;
    code: string;
    document_kind: string;
    status: string;
    formulation_name: string;
    has_signature: boolean;
    customer_signed_at: string | null;
    proposal: { id: string; code: string; status: string } | null;
  }>;
}


export default async function PortalSpecsListPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/portal/specs/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  const data: SpecListResponse =
    res && res.ok ? await res.json() : { results: [] };

  return (
    <PortalShell active="specs">
      <PageHeader
        eyebrow="All specifications"
        title="Specification sheets"
        subtitle="Every spec sheet attached to a Vita proposal of yours. Open one to read and sign."
        back={{ href: "/portal", label: "Portal" }}
      />

      {data.results.length === 0 ? (
        <EmptyState
          title="No specifications yet"
          body="Spec sheets appear here once Vita attaches them to a proposal."
        />
      ) : (
        <div className="grid gap-4">
          {data.results.map((s) => (
            <Card key={s.id} hover className="!p-0">
              <Link
                href={`/portal/specs/${s.id}`}
                className="flex items-center justify-between gap-6 p-6 sm:p-7"
              >
                <div className="flex min-w-0 flex-col gap-2">
                  <Eyebrow>
                    {s.proposal ? `${s.proposal.code} · ${s.code || "spec"}` : s.code || "spec"}
                  </Eyebrow>
                  <div className="text-lg font-black uppercase tracking-tight">
                    {s.formulation_name || s.code || "Specification"}
                  </div>
                  {s.proposal ? (
                    <div className="text-[11px] uppercase tracking-widest text-neutral-500">
                      Attached to proposal {s.proposal.code}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  {s.has_signature ? (
                    <span className="inline-flex items-center gap-1.5 border-2 border-black bg-black px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-white">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Signed
                    </span>
                  ) : (
                    <StatusPill status={s.status} />
                  )}
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
