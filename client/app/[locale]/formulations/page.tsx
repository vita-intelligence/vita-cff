import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import { resolveLegacyFlatLevel } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getFormulationsFirstPageServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { FormulationsTable } from "./formulations-table";
import { NewFormulationButton } from "./new-formulation-button";

export default async function FormulationsListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = organizations[0]!;

  const level = resolveLegacyFlatLevel(primaryOrg, "formulations");

  const tFormulations = await getTranslations("formulations");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  if (level === "none") {
    return (
      <main className="min-h-dvh bg-ink-0 text-ink-1000">
        <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-6 py-10 text-center">
          <div className="rounded-2xl bg-ink-0 p-10 shadow-sm ring-1 ring-ink-200">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              403
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000">
              {tFormulations("access_denied.title")}
            </h1>
            <p className="mt-2 text-sm text-ink-500">
              {tFormulations("access_denied.body")}
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

  const initialFirstPage = await getFormulationsFirstPageServer(
    primaryOrg.id,
    { ordering: "-updated_at", pageSize: 50 },
  );
  const canWrite = level === "write" || level === "admin";

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.formulations") },
            ]}
          />
        </section>

        <section className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {primaryOrg.name}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
              {tFormulations("title")}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {tFormulations("subtitle")}
            </p>
          </div>
          {canWrite ? <NewFormulationButton orgId={primaryOrg.id} /> : null}
        </section>

        <section className="mt-10 md:mt-12">
          <FormulationsTable
            orgId={primaryOrg.id}
            initialFirstPage={initialFirstPage}
            emptyTitle={tFormulations("no_formulations")}
            emptyHint={tFormulations("no_formulations_hint")}
          />
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
