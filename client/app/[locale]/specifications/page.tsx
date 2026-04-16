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
        <div className="mx-auto flex min-h-dvh max-w-4xl flex-col items-center justify-center px-6 py-10">
          <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
            403
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase">
            {tSpecs("access_denied.title")}
          </h1>
          <p className="mt-3 text-sm text-ink-600">
            {tSpecs("access_denied.body")}
          </p>
          <Link
            href="/home"
            className="mt-6 font-mono text-[10px] tracking-widest uppercase text-ink-700 underline underline-offset-4"
          >
            ← {tNav("main.dashboard")}
          </Link>
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
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="specifications" />

        <section className="mt-10 flex items-end justify-between gap-6 md:mt-12">
          <div>
            <Breadcrumbs
              items={[
                { label: tNav("main.dashboard"), href: "/home" },
                { label: tNav("main.specifications") },
              ]}
            />
            <p className="mt-4 font-mono text-[11px] tracking-widest uppercase text-ink-500">
              {primaryOrg.name}
            </p>
            <h1 className="mt-3 text-4xl font-black tracking-tight uppercase md:text-6xl">
              {tSpecs("title")}
            </h1>
            <p className="mt-3 text-sm text-ink-600">
              {tSpecs("subtitle")}
            </p>
          </div>
        </section>

        <section className="mt-10 md:mt-12">
          <SpecificationsTable
            orgId={primaryOrg.id}
            initialFirstPage={initialFirstPage}
            emptyTitle={tSpecs("no_sheets")}
            emptyHint={tSpecs("no_sheets_hint")}
          />
        </section>

        <footer className="mt-auto flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
