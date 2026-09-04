import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, FlaskConical, Package, RotateCw } from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { NewCFFWizard, type SalesPerson } from "./new-cff-wizard";


interface ProfileShape {
  readonly customer_id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
}


interface SalesPeopleResponse {
  readonly results: ReadonlyArray<SalesPerson>;
  readonly default_email: string | null;
}


/**
 * ``/portal/cffs/new`` — track chooser for the new-request flow.
 *
 * The customer picks between two engagement models before entering
 * the substantive form:
 *
 * * **Custom formulation** — the historical six-step wizard that
 *   captures a bespoke brief (dose, actives, target audience, etc.)
 *   for R&D. Rendered inline when ``?track=custom`` so the URL is
 *   shareable; the wizard mounts directly.
 * * **Ready-to-Go** — customer picks an existing published SKU off
 *   the org catalog. Routed via a distinct page at
 *   ``/portal/cffs/new/rtg`` so the two flows keep separate draft
 *   keys and the URL history reflects the choice.
 *
 * Without ``?track=`` we render the chooser cards so the customer
 * makes one deliberate pick before entering data.
 */
export default async function NewCFFPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const params = await searchParams;
  const track = typeof params.track === "string" ? params.track : "";

  if (track !== "custom") {
    // Chooser view — surfaces a third "Reorder" track only when the
    // customer has at least one eligible signed formulation. Cheap
    // HEAD-style GET with limit=1 keeps the cost negligible even if
    // the card is later gated behind a feature flag.
    const chooserHeaders = { Cookie: `vita_portal_access=${portalCookie.value}` };
    const reorderableRes = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/api/portal/reorderable-formulations/?limit=1`,
      { cache: "no-store", headers: chooserHeaders },
    ).catch(() => null);
    const hasReorderable = Boolean(
      reorderableRes &&
        reorderableRes.ok &&
        ((await reorderableRes.clone().json()) as { results?: unknown[] })
          ?.results?.length,
    );

    return (
      <PortalShell active="products">
        <PageHeader
          eyebrow="New request"
          title="Pick how you want to work with us"
          subtitle={
            hasReorderable
              ? "Custom develops a bespoke recipe. Ready-to-Go orders a validated catalog product. Reorder re-buys one of your own signed formulations without R&D."
              : "Choose Custom if you want us to develop a bespoke recipe, or Ready-to-Go if you'd like to order one of our existing validated products."
          }
          back={{ href: "/portal/products", label: "Back to products" }}
        />
        <div
          className={
            hasReorderable
              ? "grid gap-4 md:grid-cols-3"
              : "grid gap-4 md:grid-cols-2"
          }
        >
          <TrackCard
            href="/portal/cffs/new?track=custom"
            title="Custom formulation"
            icon={<FlaskConical className="h-6 w-6" />}
            headline="You have an idea. We develop the recipe."
            body="Six-step brief that captures your target audience, actives, packaging, and delivery. Our R&D team reviews and comes back with a proposal."
          />
          <TrackCard
            href="/portal/cffs/new/rtg"
            title="Ready-to-Go product"
            icon={<Package className="h-6 w-6" />}
            headline="Order one of our validated products as-is."
            body="Pick a product from our catalog, choose quantity + packaging, and we prepare a proposal to sign — no development cycle."
          />
          {hasReorderable ? (
            <TrackCard
              href="/portal/cffs/new/reorder"
              title="Reorder"
              icon={<RotateCw className="h-6 w-6" />}
              headline="Re-buy a product you've done before."
              body="Pick one of your signed custom formulations, tell us the quantity, and we prepare a proposal against the original spec — no re-development, no re-signing the spec sheet."
            />
          ) : null}
        </div>
      </PortalShell>
    );
  }

  // Custom track — mount the wizard with prefill fetches. Same shape
  // as before this PR so no regression on the primary path.
  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const base = env.NEXT_PUBLIC_API_URL;

  const [profileRes, salesRes] = await Promise.all([
    fetch(`${base}/api/portal/profile/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
    fetch(`${base}/api/portal/cffs/sales-people/`, {
      cache: "no-store",
      headers,
    }).catch(() => null),
  ]);

  if (!profileRes || profileRes.status === 401 || profileRes.status === 403) {
    redirect("/portal/login");
  }

  const profile: ProfileShape | null =
    profileRes && profileRes.ok ? await profileRes.json() : null;

  if (!profile) {
    redirect("/portal/login");
  }

  const salesData: SalesPeopleResponse =
    salesRes && salesRes.ok
      ? await salesRes.json()
      : { results: [], default_email: null };

  return (
    <PortalShell active="products">
      <NewCFFWizard
        profile={profile}
        salesPeople={salesData.results ?? []}
        defaultAccountManagerEmail={salesData.default_email ?? ""}
      />
    </PortalShell>
  );
}


function TrackCard({
  href,
  title,
  icon,
  headline,
  body,
}: {
  href: string;
  title: string;
  icon: React.ReactNode;
  headline: string;
  body: string;
}) {
  return (
    <Link href={href} className="group block">
      <Card hover className="h-full">
        <div className="flex h-full flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center border-2 border-black bg-orange-500 text-black">
              {icon}
            </span>
            <Eyebrow>{title}</Eyebrow>
          </div>
          <h2 className="text-xl font-black uppercase leading-tight tracking-tight">
            {headline}
          </h2>
          <p className="text-sm leading-relaxed text-neutral-700">{body}</p>
          <div className="mt-auto flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-700">
            Choose this
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </div>
        </div>
      </Card>
    </Link>
  );
}
