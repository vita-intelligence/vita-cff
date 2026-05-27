import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileSignature,
  Layers,
  Sparkles,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";


/**
 * Portal home — action-oriented.
 *
 * Replaces the previous surface-oriented hub (Proposals / Specs /
 * Requests cards). The customer's first question is "what needs my
 * attention right now?", not "where are my proposals stored?". The
 * top section answers exactly that with a flat queue of every open
 * action across every project (sign a proposal, sign a final spec,
 * choose a label-design path, approve label artwork…). The lower
 * section gives them quick access to their products and the
 * surface-oriented drill-downs for power users.
 */
export default async function PortalHub() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [meRes, dashRes] = await Promise.all([
    fetch(`${base}/api/portal/auth/me/`, { cache: "no-store", headers }).catch(
      () => null,
    ),
    fetch(`${base}/api/portal/dashboard/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
  ]);

  if (!meRes || meRes.status === 401 || meRes.status === 403) {
    redirect("/portal/login");
  }

  const me = meRes.ok ? await meRes.json() : null;
  const dash: { actions?: ActionItem[]; products?: ProductItem[] } =
    dashRes && dashRes.ok ? await dashRes.json() : {};
  const actions: ActionItem[] = dash.actions ?? [];
  const products: ProductItem[] = dash.products ?? [];

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="Welcome"
        title={me?.customer_company || "Your portal"}
        subtitle={
          actions.length > 0
            ? `${actions.length} ${actions.length === 1 ? "thing" : "things"} need your attention.`
            : "All caught up — we'll let you know when there's something new."
        }
      />

      {/* Action queue */}
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
                  No outstanding actions on your side right now. We'll be in
                  touch as your projects move forward.
                </p>
              </div>
            </div>
          </Card>
        </section>
      )}

      {/* Quick product snapshot */}
      {products.length > 0 ? (
        <section>
          <div className="flex items-center justify-between">
            <Eyebrow>Your products</Eyebrow>
            <a
              href="/portal/products"
              className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-600 underline-offset-4 hover:text-black hover:underline"
            >
              See all →
            </a>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.slice(0, 6).map((p) => (
              <a
                key={p.id}
                href={`/portal/products/${p.id}`}
                className="group"
              >
                <Card hover>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">
                        {p.code || "Project"}
                      </p>
                      <h3 className="mt-1 truncate text-base font-black uppercase leading-tight">
                        {p.name || "Untitled"}
                      </h3>
                      <p className="mt-2 text-xs font-semibold text-black">
                        {p.stage_label}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Card>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </PortalShell>
  );
}


// ---------------------------------------------------------------------------
// Types — server-side, no client state
// ---------------------------------------------------------------------------


type ActionKind =
  | "sign_proposal"
  | "sign_final_spec"
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
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly project_status: string;
  readonly stage_key: string;
  readonly stage_label: string;
  readonly next_action_url: string | null;
  readonly proposal_id: string | null;
  readonly proposal_code: string;
  readonly label_design_id: string | null;
  readonly last_updated: string;
}


// ---------------------------------------------------------------------------
// Action card
// ---------------------------------------------------------------------------


const ACTION_ICONS: Record<ActionKind, React.ComponentType<{ className?: string }>> = {
  sign_proposal: FileSignature,
  sign_final_spec: Sparkles,
  label_choose_path: Layers,
  label_preferences: Layers,
  label_upload: Layers,
  label_approve: AlertCircle,
};


function ActionCard({ action }: { action: ActionItem }) {
  const Icon = ACTION_ICONS[action.kind] ?? Clock;
  const isUrgent = action.urgency === 1;
  return (
    <a
      href={action.url}
      className="group block border-2 border-black bg-white p-4 transition-all hover:shadow-[4px_4px_0_0_black]"
    >
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
            {isUrgent ? <span className="ml-2 text-orange-700">· URGENT</span> : null}
          </p>
          <p className="mt-1 text-base font-black uppercase leading-tight">
            {action.title}
          </p>
          <p className="mt-1 text-sm text-neutral-700">{action.subtitle}</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-neutral-400 transition-transform group-hover:translate-x-1" />
      </div>
    </a>
  );
}
