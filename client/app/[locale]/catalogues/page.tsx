import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
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
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="catalogues" />

        <section className="mt-12 md:mt-16">
          <p className="font-mono text-[11px] tracking-widest uppercase text-ink-500">
            {primaryOrg.name}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase md:text-6xl">
            {tNav("main.catalogues")}
          </h1>
        </section>

        <section className="mt-10 grid grid-cols-1 gap-6 md:mt-12 md:grid-cols-2">
          {catalogues.map((catalogue) => (
            <Link
              key={catalogue.id}
              href={`/catalogues/${catalogue.slug}`}
              className="group flex flex-col justify-between gap-6 border-2 border-ink-1000 bg-ink-0 p-6 transition-colors hover:bg-ink-100"
            >
              <div>
                <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                  {catalogue.slug}
                </p>
                <h2 className="mt-3 text-2xl font-black tracking-tight uppercase md:text-3xl">
                  {catalogue.name}
                </h2>
                {catalogue.description ? (
                  <p className="mt-3 text-sm text-ink-600">
                    {catalogue.description}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center justify-between">
                {catalogue.is_system ? (
                  <span className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                    system
                  </span>
                ) : (
                  <span />
                )}
                <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700 group-hover:text-ink-1000">
                  open →
                </span>
              </div>
            </Link>
          ))}
        </section>

        <footer className="mt-auto flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
