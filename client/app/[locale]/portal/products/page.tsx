import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight, ExternalLink, Inbox, PlusCircle } from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


type Stage =
  | "proposal_pending"
  | "draft_spec_pending"
  | "in_development"
  | "pilot"
  | "final_spec_pending"
  | "approved_awaiting_payment"
  | "label_path_pending"
  | "label_preferences_pending"
  | "label_in_progress"
  | "label_review"
  | "label_customer_approval"
  | "label_approved"
  | "on_hold"
  | "unknown";


interface ProductItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly project_status: string;
  readonly stage_key: Stage;
  readonly stage_label: string;
  readonly next_action_url: string | null;
  readonly proposal_id: string | null;
  readonly proposal_code: string;
  readonly label_design_id: string | null;
  readonly last_updated: string;
}


// Each stage gets a tone so a quick glance tells the customer
// where everything sits. Urgent / customer-blocking stages use
// the orange/black brutalist treatment; informational stages
// stay grey.
const STAGE_TONE: Record<Stage, string> = {
  proposal_pending: "bg-orange-500 text-black",
  draft_spec_pending: "bg-orange-500 text-black",
  in_development: "bg-neutral-200 text-black",
  pilot: "bg-blue-200 text-black",
  final_spec_pending: "bg-orange-500 text-black",
  approved_awaiting_payment: "bg-amber-200 text-black",
  label_path_pending: "bg-orange-500 text-black",
  label_preferences_pending: "bg-orange-500 text-black",
  label_in_progress: "bg-blue-200 text-black",
  label_review: "bg-blue-200 text-black",
  label_customer_approval: "bg-orange-500 text-black",
  label_approved: "bg-emerald-300 text-black",
  on_hold: "bg-rose-200 text-black",
  unknown: "bg-neutral-100 text-black",
};


/**
 * Project-centric portal view.
 *
 * Companion to the action queue on the portal home — answers the
 * customer's "where are my products?" question by showing one card
 * per project with its current stage chip. Clicking a card jumps
 * straight to whatever surface is most relevant (the open action
 * if there is one, otherwise the proposal detail).
 */
export default async function PortalProductsPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const dashRes = await fetch(`${base}/api/portal/dashboard/`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!dashRes || dashRes.status === 401 || dashRes.status === 403) {
    redirect("/portal/login");
  }

  const dash: { products?: ProductItem[] } =
    dashRes.ok ? await dashRes.json() : {};
  const products: ProductItem[] = dash.products ?? [];

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Your products"
        title="All your projects"
        subtitle="One card per project — the chip shows where it sits in the journey from proposal to approved label."
      />

      {/* Single entry point for starting a new project. The form
          itself lives on the marketing site (vitamanufacture.co.uk)
          and the Wix poller mirrors each submission into our system,
          so the new product shows up in this list automatically. */}
      <div className="mb-6 flex flex-col gap-3 border-2 border-black bg-orange-500 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-black">
            Start a new product
          </p>
          <p className="mt-1 text-sm font-semibold text-black">
            Fill in the custom formulation request form and we'll take it
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
          New project
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {products.length === 0 ? (
        <Card>
          <div className="flex items-start gap-3">
            <Inbox className="mt-0.5 h-6 w-6 shrink-0" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                Nothing here yet
              </p>
              <p className="mt-1 text-sm">
                Submit a request above and your first project will appear here.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            // Cards always open the per-project pipeline view — the
            // "journey" page is the customer's central touchpoint for
            // one product. Action shortcuts live there too, so we
            // don't lose the deep-link behaviour the old card had.
            const href = `/portal/products/${p.id}`;
            return (
              <a key={p.id} href={href} className="group">
                <Card hover className="h-full">
                  <div className="flex h-full flex-col gap-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
                          {p.code || "Project"}
                        </p>
                        <h2 className="mt-1 truncate text-lg font-black uppercase leading-tight">
                          {p.name || "Untitled"}
                        </h2>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <div>
                      <span
                        className={`inline-block border-2 border-black px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${STAGE_TONE[p.stage_key] ?? STAGE_TONE.unknown}`}
                      >
                        {p.stage_label}
                      </span>
                    </div>
                    {p.proposal_code ? (
                      <p className="text-[11px] text-neutral-500">
                        Proposal {p.proposal_code}
                      </p>
                    ) : null}
                  </div>
                </Card>
              </a>
            );
          })}
        </div>
      )}
    </PortalShell>
  );
}
