import { ArrowRight, Layers } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Chip } from "@/components/ui/chip";
import { Link, redirect } from "@/i18n/navigation";
import {
  getCataloguesServer,
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

export default async function CataloguesIndexPage({
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

  const catalogues = (await getCataloguesServer(primaryOrg.id)) ?? [];

  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="catalogues" />

        <section className="mt-10 md:mt-14">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {primaryOrg.name}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {tNav("main.catalogues")}
          </h1>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-4 md:mt-10 md:grid-cols-2 md:gap-6">
          {catalogues.map((catalogue) => (
            <Link
              key={catalogue.id}
              href={`/catalogues/${catalogue.slug}`}
              className="group flex flex-col justify-between gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
            >
              <div>
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-ink-500" />
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                    {catalogue.slug}
                  </p>
                </div>
                <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl">
                  {catalogue.name}
                </h2>
                {catalogue.description ? (
                  <p className="mt-1 text-sm text-ink-500">
                    {catalogue.description}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-between">
                {catalogue.is_system ? <Chip tone="neutral">system</Chip> : <span />}
                <span className="inline-flex items-center gap-1 text-sm font-medium text-orange-700 transition-transform group-hover:translate-x-0.5">
                  open <ArrowRight className="h-4 w-4" />
                </span>
              </div>
            </Link>
          ))}
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
