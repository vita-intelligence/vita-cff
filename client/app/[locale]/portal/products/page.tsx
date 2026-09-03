import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileSignature,
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

import { ActivityFeed } from "./activity-feed";


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
 * Portal home — welcome + action queue + unified activity feed.
 *
 * Server component owns the auth check + the initial action-queue
 * fetch (both dependency-free of any client state). The activity
 * feed (projects + RTG orders + samples) mounts as a client child
 * because it owns tab / search / infinite-scroll state. Mirrors the
 * web-site portal's ``/portal`` structure so both surfaces stay in
 * lockstep.
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
  const dash: { actions?: ActionItem[] } = dashRes.ok ? await dashRes.json() : {};
  const actions: ActionItem[] = dash.actions ?? [];

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Welcome"
        title={me?.customer_company || "Your portal"}
        subtitle={
          actions.length > 0
            ? `${actions.length} ${actions.length === 1 ? "thing" : "things"} need your attention. Your full activity is below.`
            : "All caught up — every item is below."
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

      <Eyebrow>Your activity</Eyebrow>
      {/* Unified feed — projects + RTG orders + samples in one
          filterable list. Mirrors the web-site portal's ``/portal``
          hub. Replaces the old dashboard-only ``Your products`` grid
          which dropped samples entirely. Server data is fetched
          client-side so the tab/search/scroll state stays local. */}
      <ActivityFeed />
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
