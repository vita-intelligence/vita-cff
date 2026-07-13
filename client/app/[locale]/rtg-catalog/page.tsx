import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
  getFormulationsFirstPageServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { NewRTGButton } from "./new-rtg-button";
import { RTGCatalogGrid } from "./rtg-catalog-grid";
import { APP_VERSION } from "@/config/version";


/**
 * Staff RTG Catalog surface.
 *
 * Lists every ``project_type='ready_to_go'`` formulation in the org
 * — both published and unpublished — so a catalog manager can see
 * "what do we sell as ready-to-go" without filtering the full
 * projects list every time. The row-level publish + marketing
 * edits still happen on the per-formulation project overview page
 * via :class:`RTGCatalogPanel`; this page just gives them a hub.
 *
 * Access rides the standard ``formulations.view`` capability — every
 * RTG SKU is a formulation, so anyone who can see the projects list
 * can see the catalog view of it.
 */
export default async function RTGCatalogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    await redirectToLogin(locale);
  }
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = (await getActiveOrganizationServer())!;

  // RTG Catalog page rides its own module now. ``view`` is the
  // minimum entry cap; ``manage`` or ``publish`` unlocks the New RTG
  // dialog + inline write affordances. We also treat holders of the
  // legacy ``formulations.edit`` as writable to keep the surface
  // functional between the code deploy and the migration run.
  const canView = hasFlatCapability(primaryOrg, "rtg_catalog", "view");
  const canManage = hasFlatCapability(primaryOrg, "rtg_catalog", "manage");
  const canPublish = hasFlatCapability(primaryOrg, "rtg_catalog", "publish");

  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  if (!canView) {
    return (
      <main className="min-h-dvh bg-ink-0 text-ink-1000">
        <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
          <div className="rounded-2xl bg-ink-0 p-10 shadow-sm ring-1 ring-ink-200">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              403
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000">
              Access denied
            </h1>
            <p className="mt-2 text-sm text-ink-500">
              You don&apos;t have permission to view the RTG catalog for
              this organisation.
            </p>
            <Link
              href="/home"
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:text-orange-800"
            >
              ← {tNav("main.dashboard")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Fetch a generous first page — RTG catalogs are usually tens of
  // SKUs, not thousands, so paginating server-side would add churn
  // for a listing that fits on one screen. Falls back gracefully to
  // an empty list on a fetch error rather than 500-ing the whole page.
  const initialFirstPage = await getFormulationsFirstPageServer(
    primaryOrg.id,
    { ordering: "-updated_at", pageSize: 100, projectType: "ready_to_go" },
  );
  const canWrite = canManage || canPublish;

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="rtg_catalog" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: "RTG Catalog" },
            ]}
          />
        </section>

        <section className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {primaryOrg.name}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
              Ready-to-Go Catalog
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              Every product you sell as an off-the-shelf SKU. Publishing
              a card here makes it discoverable in the customer portal.
            </p>
          </div>
          {canWrite ? (
            <NewRTGButton orgId={primaryOrg.id} locale={locale} />
          ) : null}
        </section>

        <section className="mt-10 md:mt-12">
          <RTGCatalogGrid
            orgId={primaryOrg.id}
            initialFirstPage={initialFirstPage}
            canWrite={canWrite}
          />
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
