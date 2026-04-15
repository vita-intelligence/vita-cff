import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import {
  getAttributeDefinitionsServer,
  getCataloguesServer,
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { HomeActions } from "../../../home/home-actions";
import { CatalogueTabs } from "../catalogue-tabs";
import { FieldsManager } from "./fields-manager";

function resolveCataloguePermission(
  isOwner: boolean,
  permissions: Record<string, unknown>,
  slug: string,
): "admin" | "write" | "read" | "none" {
  if (isOwner) return "admin";
  const scoped = permissions.catalogues;
  if (scoped && typeof scoped === "object" && !Array.isArray(scoped)) {
    const level = (scoped as Record<string, unknown>)[slug];
    if (level === "admin" || level === "write" || level === "read") {
      return level;
    }
  }
  return "none";
}

export default async function CatalogueFieldsPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
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
  const catalogue = catalogues.find((c) => c.slug === slug);
  if (!catalogue) {
    notFound();
  }

  const level = resolveCataloguePermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
    slug,
  );
  if (level !== "admin") {
    redirect({ href: `/catalogues/${slug}`, locale });
  }

  const definitions =
    (await getAttributeDefinitionsServer(primaryOrg.id, slug, {
      includeArchived: true,
    })) ?? [];

  const tAttrs = await getTranslations("attributes");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  const initials =
    (currentUser.first_name[0] ?? "") + (currentUser.last_name[0] ?? "");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 md:px-10 md:py-12">
        <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-6">
          <div className="flex items-center gap-8">
            <span className="font-mono text-xs tracking-widest uppercase text-ink-700">
              {tCommon("brand")}
            </span>
            <nav className="flex items-center gap-6 font-mono text-[10px] tracking-widest uppercase">
              <Link href="/home" className="text-ink-500 hover:text-ink-1000">
                {tNav("main.dashboard")}
              </Link>
              <Link
                href={`/catalogues/${slug}`}
                className="border-b-2 border-ink-1000 text-ink-1000"
              >
                {catalogue.name}
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center border-2 border-ink-1000 bg-ink-1000 font-mono text-xs font-bold tracking-widest text-ink-0">
                {initials.toUpperCase() || "··"}
              </div>
              <span className="hidden font-mono text-xs tracking-widest uppercase text-ink-700 md:inline">
                {currentUser.full_name}
              </span>
            </div>
            <HomeActions />
          </div>
        </header>

        <div className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.catalogues"), href: "/catalogues" },
              { label: catalogue.name, href: `/catalogues/${slug}` },
              { label: tAttrs("title") },
            ]}
          />
        </div>

        <CatalogueTabs
          slug={slug}
          active="fields"
          catalogueLabel={catalogue.name}
          fieldsLabel={tAttrs("title")}
        />

        <FieldsManager
          orgId={primaryOrg.id}
          slug={slug}
          initialDefinitions={definitions}
        />

        <footer className="mt-auto flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
