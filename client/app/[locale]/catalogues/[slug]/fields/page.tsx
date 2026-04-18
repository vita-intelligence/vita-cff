import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { redirect } from "@/i18n/navigation";
import {
  getAttributeDefinitionsServer,
  getCataloguesServer,
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

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

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="catalogues" />

        <div className="mt-8 md:mt-10">
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

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
