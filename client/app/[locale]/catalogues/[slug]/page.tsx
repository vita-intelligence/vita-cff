import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import {
  getAttributeDefinitionsServer,
  getCatalogueItemsFirstPageServer,
  getCataloguesServer,
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { CatalogueTable } from "./catalogue-table";
import { CatalogueTabs } from "./catalogue-tabs";
import { ImportItemsButton } from "./import-items-button";
import { NewItemButton } from "./new-item-button";

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

export default async function CatalogueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { archived: archivedParam } = await searchParams;
  const viewArchived = archivedParam === "1";

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

  const tItems = await getTranslations("items");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");
  const tAttrs = await getTranslations("attributes");

  const level = resolveCataloguePermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
    slug,
  );
  if (level === "none") {
    redirect({ href: "/home", locale });
  }

  const canAdmin = level === "admin";
  const canWrite = level === "write" || level === "admin";

  const initialFirstPage = await getCatalogueItemsFirstPageServer(
    primaryOrg.id,
    slug,
    {
      includeArchived: viewArchived,
      ordering: "name",
      pageSize: 100,
    },
  );
  const definitions =
    (await getAttributeDefinitionsServer(primaryOrg.id, slug)) ?? [];

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="catalogues" />

        <section className="mt-8 md:mt-10">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.catalogues"), href: "/catalogues" },
              { label: catalogue.name },
            ]}
          />
        </section>

        {canAdmin ? (
          <CatalogueTabs
            slug={slug}
            active="catalogue"
            catalogueLabel={catalogue.name}
            fieldsLabel={tAttrs("title")}
          />
        ) : null}

        <section className="mt-6 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {primaryOrg.name}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
              {catalogue.name}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {catalogue.description || tItems("subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={
                viewArchived
                  ? `/catalogues/${slug}`
                  : `/catalogues/${slug}?archived=1`
              }
              className="inline-flex h-10 items-center rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            >
              {viewArchived
                ? tItems("show_active")
                : tItems("show_archived")}
            </Link>
            {canWrite && !viewArchived ? (
              <ImportItemsButton orgId={primaryOrg.id} slug={slug} />
            ) : null}
            {canWrite && !viewArchived ? (
              <NewItemButton
                orgId={primaryOrg.id}
                slug={slug}
                definitions={definitions}
              />
            ) : null}
          </div>
        </section>

        <section className="mt-6 md:mt-8">
          <CatalogueTable
            orgId={primaryOrg.id}
            slug={slug}
            definitions={definitions}
            viewArchived={viewArchived}
            canAdmin={canAdmin}
            initialFirstPage={initialFirstPage}
            emptyTitle={
              viewArchived ? tItems("no_archived") : tItems("no_items")
            }
            emptyHint={
              viewArchived
                ? tItems("no_archived_hint")
                : tItems("no_items_hint")
            }
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
