import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Card,
  H1,
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


/**
 * Dashboard — the post-login landing page.
 *
 * Server component. Reads the portal cookie via ``next/headers`` and
 * forwards it to the backend ``/api/portal/proposals/`` so the
 * response carries only proposals tied to the logged-in customer.
 * Unauthenticated visitors are bounced to ``/portal/login`` before
 * any markup ships.
 */
export default async function PortalDashboard() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const base = env.NEXT_PUBLIC_API_URL;
  const res = await fetch(`${base}/api/portal/proposals/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }

  const meRes = await fetch(`${base}/api/portal/auth/me/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);
  const me = meRes && meRes.ok ? await meRes.json() : null;

  const data: ProposalListResponse = res && res.ok
    ? await res.json()
    : { results: [] };

  return (
    <PortalShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <H1>{me?.customer_company || "Your proposals"}</H1>
        <Link
          href="/portal/settings"
          className="border-2 border-black bg-white px-4 py-2 text-xs font-bold uppercase tracking-widest shadow-[4px_4px_0_#000] hover:bg-neutral-100"
        >
          Settings →
        </Link>
      </div>
      {data.results.length === 0 ? (
        <Card className="max-w-2xl">
          <p className="text-sm">
            No proposals yet. As soon as Vita sends one, it will appear here.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {data.results.map((p) => (
            <Link
              key={p.id}
              href={`/portal/proposals/${p.id}`}
              className="block"
            >
              <Card className="hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-[8px_8px_0_#000] transition-transform">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-lg font-black">
                      {p.code || "Proposal"}
                    </div>
                    {p.title ? (
                      <div className="text-sm">{p.title}</div>
                    ) : null}
                  </div>
                  <StatusPill status={p.status} />
                </div>
                <div className="mt-3 text-[11px] uppercase tracking-widest">
                  Updated {new Date(p.updated_at).toLocaleString()}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </PortalShell>
  );
}
