import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileSignature,
  Inbox,
  Layers,
  PlusCircle,
  Sparkles,
  Wallet,
} from "lucide-react";

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
  | "draft_spec_in_progress"
  | "proposal_in_progress"
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
  // PSP-driven production overlay states. Once production is
  // actually running the badge tracks the goods, not the label
  // workflow that finished a week ago.
  | "production_planning"
  | "production_in_progress"
  | "production_quality_check"
  | "awaiting_dispatch"
  | "dispatched"
  | "delivered"
  | "on_hold"
  | "unknown"
  // Pre-project CFF states. Not real project stages — these only
  // appear on ``kind === "cff"`` cards emitted by the dashboard
  // backend to represent un-converted submissions inline with real
  // projects.
  | "cff_under_review"
  | "cff_rejected"
  // Ready-to-Go: customer ordered off the catalog; the drafted
  // proposal is on our desk pending final send.
  | "cff_awaiting_proposal";


type ActionKind =
  | "sign_proposal"
  | "sign_final_spec"
  | "pay_deposit"
  | "label_choose_path"
  | "label_preferences"
  | "label_upload"
  | "label_approve";


interface ActionItem {
  readonly kind: ActionKind;
  readonly urgency: 1 | 2 | 3;
  readonly title: string;
  readonly subtitle: string;
  readonly url: string;
  readonly product_code: string;
  readonly product_name: string;
  readonly reference_code: string;
  readonly created_at: string;
}


interface ProductItem {
  /** ``"formulation"`` = a real project the customer owns.
   *  ``"cff"`` = a pre-project CFF submission the customer sent
   *  that hasn't been converted to a project yet (or was rejected).
   *  Drives card tone + navigation target so the same array carries
   *  both mental-model slices without duplicating a component. */
  readonly kind: "formulation" | "cff";
  /** Populated only on ``kind === "cff"`` rows — ``custom`` for
   *  bespoke briefs, ``ready_to_go`` for RTG catalog orders whose
   *  drafted proposal is about to land. Drives the subtitle copy. */
  readonly submission_kind?: "custom" | "ready_to_go";
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
  /** Where the card link goes. Formulations open the project
   *  drill-down; CFFs go to the CFF detail so the customer can
   *  re-read their submission + see the rejection reason. */
  readonly href: string;
}


// Each stage gets a tone so a quick glance tells the customer
// where everything sits. Urgent / customer-blocking stages use
// the orange/black brutalist treatment; informational stages
// stay grey.
const STAGE_TONE: Record<Stage, string> = {
  proposal_pending: "bg-orange-500 text-black",
  draft_spec_pending: "bg-orange-500 text-black",
  // Neutral in-flight tone — scientists are working, customer waits.
  draft_spec_in_progress: "bg-blue-200 text-black",
  // Same blue in-flight tone — commercial team drafting the quote.
  proposal_in_progress: "bg-blue-200 text-black",
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
  production_planning: "bg-blue-200 text-black",
  production_in_progress: "bg-blue-200 text-black",
  production_quality_check: "bg-purple-200 text-black",
  awaiting_dispatch: "bg-amber-200 text-black",
  dispatched: "bg-amber-200 text-black",
  delivered: "bg-emerald-300 text-black",
  on_hold: "bg-rose-200 text-black",
  unknown: "bg-neutral-100 text-black",
  // CFF stages read as pending / declined, not as "urgent" — a
  // yellow "under review" chip signals "the ball is in our court";
  // red flags a decline without shouting.
  cff_under_review: "bg-yellow-200 text-black",
  cff_rejected: "bg-red-700 text-white",
  // Amber for the RTG "we're drafting your quote" state so it
  // reads as active-in-flight rather than yellow "still waiting
  // on us to look at your brief".
  cff_awaiting_proposal: "bg-amber-200 text-black",
};


const ACTION_ICONS: Record<
  ActionKind,
  React.ComponentType<{ className?: string }>
> = {
  sign_proposal: FileSignature,
  sign_final_spec: Sparkles,
  pay_deposit: Wallet,
  label_choose_path: Layers,
  label_preferences: Layers,
  label_upload: Layers,
  label_approve: AlertCircle,
};


/**
 * Portal home + product list — unified.
 *
 * Previously there were two surfaces: ``/portal`` (welcome + action
 * queue + first 6 products) and ``/portal/products`` (full product
 * grid). Customers couldn't tell them apart because both led
 * with product cards; the home page felt like a samplng of the
 * "all" page. We collapsed them into this single route so the
 * customer's mental model is "everything I have is here, and
 * the things that need me are at the top". ``/portal`` is now a
 * redirect to this page.
 */
export default async function PortalProductsPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [meRes, dashRes] = await Promise.all([
    fetch(`${base}/api/portal/auth/me/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
    fetch(`${base}/api/portal/dashboard/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
  ]);

  if (!meRes || meRes.status === 401 || meRes.status === 403) {
    redirect("/portal/login");
  }
  if (!dashRes || dashRes.status === 401 || dashRes.status === 403) {
    redirect("/portal/login");
  }

  const me = meRes.ok ? await meRes.json() : null;
  const dash: { actions?: ActionItem[]; products?: ProductItem[] } =
    dashRes.ok ? await dashRes.json() : {};
  const actions: ActionItem[] = dash.actions ?? [];
  const products: ProductItem[] = dash.products ?? [];

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Welcome"
        title={me?.customer_company || "Your portal"}
        subtitle={
          actions.length > 0
            ? `${actions.length} ${actions.length === 1 ? "thing" : "things"} need your attention. Your full project list is below.`
            : "All caught up — every project is below."
        }
      />

      {/* Action queue — pinned at the top because answering
          "what needs me right now?" is the first question the
          customer comes here to resolve. */}
      {actions.length > 0 ? (
        <section className="mb-10">
          <Eyebrow>Needs your attention</Eyebrow>
          <ul className="mt-3 flex flex-col gap-3">
            {actions.map((a, idx) => (
              <li key={`${a.kind}-${a.url}-${idx}`}>
                <ActionCard action={a} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="mb-10">
          <Card>
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-emerald-900">
                  All clear
                </p>
                <p className="mt-1 text-sm">
                  No outstanding actions on your side right now. We&rsquo;ll
                  be in touch as your projects move forward.
                </p>
              </div>
            </div>
          </Card>
        </section>
      )}

      {/* New-project CTA — in-portal wizard at ``/portal/cffs/new``.
          Successful submissions land in the CFF list and get picked
          up by our team from there. */}
      <div className="mb-6 flex flex-col gap-3 border-2 border-black bg-orange-500 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-black">
            Start a new product
          </p>
          <p className="mt-1 text-sm font-semibold text-black">
            Tell us what you want to make. We&rsquo;ll review your request and
            get back with a proposal.
          </p>
        </div>
        <Link
          href="/portal/cffs/new"
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800"
        >
          <PlusCircle className="h-4 w-4" />
          New project
        </Link>
      </div>

      <Eyebrow>Your products</Eyebrow>
      {products.length === 0 ? (
        <Card className="mt-3">
          <div className="flex items-start gap-3">
            <Inbox className="mt-0.5 h-6 w-6 shrink-0" />
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-500">
                Nothing here yet
              </p>
              <p className="mt-1 text-sm">
                Submit a request above and it&apos;ll appear here right away
                — first as a pending request, then as a full project once
                our team picks it up.
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            const isCff = p.kind === "cff";
            // Backend provides the click target so the FE doesn't
            // have to fork on kind for URL construction. Fallback
            // preserves the old behaviour if an older row happens
            // to be cached without the field.
            const href = p.href || `/portal/products/${p.id}`;
            return (
              <a key={p.id} href={href} className="group">
                <Card
                  hover
                  className={`h-full ${
                    // Muted treatment for pre-project CFF cards so
                    // the customer sees them as "your submission,
                    // pending" — visually distinct from active
                    // projects without needing a second list.
                    isCff ? "!bg-neutral-50 !border-dashed" : ""
                  }`}
                >
                  <div className="flex h-full flex-col gap-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
                          {isCff
                            ? "Request · pending"
                            : p.code || "Project"}
                        </p>
                        <h2 className="mt-1 truncate text-lg font-black uppercase leading-tight">
                          {p.name || "Untitled"}
                        </h2>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <div>
                      <span
                        className={`inline-block border-2 border-black px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] ${
                          STAGE_TONE[p.stage_key] ?? STAGE_TONE.unknown
                        }`}
                      >
                        {p.stage_label}
                      </span>
                    </div>
                    {p.proposal_code ? (
                      <p className="text-[11px] text-neutral-500">
                        Proposal {p.proposal_code}
                      </p>
                    ) : isCff ? (
                      // Reinforce the "waiting on us" framing so the
                      // customer doesn't scan the page looking for an
                      // action they need to take on a pre-project
                      // card — there isn't one. RTG rows get the
                      // more specific "we're drafting" copy so the
                      // customer sees the difference from a Custom
                      // brief that's still in triage review.
                      <p className="text-[11px] text-neutral-500">
                        {p.submission_kind === "ready_to_go"
                          ? "We’re drafting your proposal — you’ll see it here shortly."
                          : "We’ll review your submission and get back to you."}
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


function ActionCard({ action }: { action: ActionItem }) {
  const Icon = ACTION_ICONS[action.kind] ?? Clock;
  const isUrgent = action.urgency === 1;
  // Deposit is informational only — payment happens off-platform
  // (invoice + bank transfer), so there's nowhere useful to click
  // through to. Render as a static card without the arrow affordance.
  const isInformational = action.kind === "pay_deposit";
  const body = (
    <div className="flex items-start gap-4">
      <span
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center border-2 border-black ${
          isUrgent ? "bg-orange-500 text-black" : "bg-white text-black"
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-500">
          {action.product_code || "Project"}
          {isUrgent ? (
            <span className="ml-2 text-orange-700">· URGENT</span>
          ) : null}
        </p>
        <p className="mt-1 text-base font-black uppercase leading-tight">
          {action.title}
        </p>
        <p className="mt-1 text-sm text-neutral-700">{action.subtitle}</p>
      </div>
      {isInformational ? null : (
        <ArrowRight className="h-5 w-5 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-1" />
      )}
    </div>
  );
  if (isInformational) {
    return (
      <div className="block border-2 border-black bg-white p-4">{body}</div>
    );
  }
  return (
    <a
      href={action.url}
      className="group block border-2 border-black bg-white p-4 transition-all hover:shadow-[4px_4px_0_0_black]"
    >
      {body}
    </a>
  );
}
