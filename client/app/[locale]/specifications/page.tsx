import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getSpecificationsFirstPageServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { SpecificationsTable } from "./specifications-table";

function resolveSpecificationsPermission(
  isOwner: boolean,
  permissions: Record<string, unknown>,
): "admin" | "write" | "read" | "none" {
  if (isOwner) return "admin";
  const level = permissions.specifications;
  if (level === "admin" || level === "write" || level === "read") return level;
  return "none";
}

export default async function SpecificationsListPage({
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

  const level = resolveSpecificationsPermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
  );

  const tSpecs = await getTranslations("specifications");
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  if (level === "none") {
    return (
      <main className="min-h-dvh bg-ink-0 text-ink-1000">
        <div className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center px-4 py-10 text-center sm:px-6">
          <div className="rounded-2xl bg-ink-0 p-10 shadow-sm ring-1 ring-ink-200">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              403
            </p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000">
              {tSpecs("access_denied.title")}
            </h1>
            <p className="mt-2 text-sm text-ink-500">
              {tSpecs("access_denied.body")}
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

  const initialFirstPage = await getSpecificationsFirstPageServer(
    primaryOrg.id,
    { pageSize: 50 },
  );

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="specifications" />

        <section className="mt-8 md:mt-10">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.specifications") },
            ]}
          />
        </section>

        <section className="mt-6 flex flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {primaryOrg.name}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {tSpecs("title")}
          </h1>
          <p className="mt-1 text-sm text-ink-500">{tSpecs("subtitle")}</p>
        </section>

        <section className="mt-6 md:mt-8">
          <SpecificationsTable
            orgId={primaryOrg.id}
            initialFirstPage={initialFirstPage}
            emptyTitle={tSpecs("no_sheets")}
            emptyHint={tSpecs("no_sheets_hint")}
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
