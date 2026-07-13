import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, PlusCircle } from "lucide-react";

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
    // Wix submission status. Kept for legacy/back-compat display;
    // the ``lifecycle_state`` field below is the one the chip reads.
    status: string;
    has_project: boolean;
    project_code: string | null;
    summary: string;
    // Rejection state (customer-visible). Empty string when the CFF
    // isn't rejected — safe to render inline conditionally.
    is_rejected: boolean;
    rejection_reason: string;
    rejected_at: string | null;
    // "wix" for anonymous marketing-form submissions, "portal" for
    // ones the customer typed in the wizard here. Drives the small
    // provenance chip on the row.
    provenance: string;
    // Single-value lifecycle: "under_review" | "rejected" | "project_created".
    lifecycle_state: string;
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

      {/* "Start a new project" CTA — now an in-portal wizard at
          ``/portal/cffs/new`` instead of the previous redirect to
          the marketing-site Wix form. */}
      <div className="mb-6 flex flex-col gap-3 border-2 border-black bg-orange-500 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-black">
            Start a new project
          </p>
          <p className="mt-1 text-sm font-semibold text-black">
            Tell us what you want to make. We'll review your request and get
            back with a proposal.
          </p>
        </div>
        <Link
          href="/portal/cffs/new"
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <PlusCircle className="h-4 w-4" />
          New request
        </Link>
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
            // Prefer the derived lifecycle chip; fall back to the
            // Wix status if lifecycle isn't populated (older rows
            // before the FE migrated).
            const chipStatus = cff.lifecycle_state || cff.status;
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
                      {cff.provenance === "portal" ? (
                        <span className="ml-2 rounded-none border border-black px-1.5 py-0.5 text-[9px] text-black">
                          via portal
                        </span>
                      ) : null}
                    </div>
                    {/* Rejected rows carry the reason inline so the
                        customer doesn't have to open the detail page
                        to see the outcome. Same brutalist palette as
                        the rejected-chip on the staff inbox. */}
                    {cff.is_rejected && cff.rejection_reason ? (
                      <p className="mt-1 border-2 border-black bg-red-50 px-3 py-2 text-[11px] leading-relaxed text-black">
                        <span className="font-bold uppercase tracking-widest">
                          Not proceeding:
                        </span>{" "}
                        <span className="whitespace-pre-wrap">
                          {cff.rejection_reason}
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <StatusPill status={chipStatus} />
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
