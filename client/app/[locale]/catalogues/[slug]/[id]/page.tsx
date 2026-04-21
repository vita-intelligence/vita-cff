import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Chip } from "@/components/ui/chip";
import { Link, redirect } from "@/i18n/navigation";
import { resolveLegacyRowScopedLevel } from "@/lib/auth/capabilities";
import {
  getAttributeDefinitionsServer,
  getCatalogueItemServer,
  getCataloguesServer,
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { EditItemForm } from "./edit-form";

export default async function CatalogueItemDetailPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string; id: string }>;
}) {
  const { locale, slug, id } = await params;
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

  const level = resolveLegacyRowScopedLevel(
    primaryOrg,
    "catalogues",
    slug,
  );
  if (level === "none") {
    redirect({ href: "/home", locale });
  }

  const item = await getCatalogueItemServer(primaryOrg.id, slug, id);
  if (!item) {
    notFound();
  }

  const definitions =
    (await getAttributeDefinitionsServer(primaryOrg.id, slug)) ?? [];

  const canWrite = level === "write" || level === "admin";
  const canAdmin = level === "admin";

  const tItems = await getTranslations("items");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="catalogues" />

        <section className="mt-8 md:mt-10">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.catalogues"), href: "/catalogues" },
              { label: catalogue.name, href: `/catalogues/${slug}` },
              { label: item.name },
            ]}
          />
        </section>

        <section className="mt-6 flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col">
            <Link
              href={`/catalogues/${slug}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-1000"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {tItems("detail.back")}
            </Link>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
              {item.name}
            </h1>
            <p className="mt-1 text-sm text-ink-500">
              {item.internal_code ? `${item.internal_code} · ` : ""}
              {item.unit || "—"}
            </p>
          </div>
          {item.is_archived ? (
            <Chip tone="neutral">{tItems("status.archived")}</Chip>
          ) : (
            <Chip tone="success">{tItems("status.active")}</Chip>
          )}
        </section>

        <section className="mt-6 md:mt-8">
          {canWrite ? (
            <EditItemForm
              orgId={primaryOrg.id}
              slug={slug}
              item={item}
              canAdmin={canAdmin}
              definitions={definitions}
            />
          ) : (
            <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tItems("columns.status")}
              </p>
              <p className="mt-2 text-sm text-ink-700">
                {item.is_archived
                  ? tItems("status.archived")
                  : tItems("status.active")}
              </p>
            </div>
          )}
        </section>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
