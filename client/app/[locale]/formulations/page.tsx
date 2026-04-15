import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { Link, redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getFormulationsFirstPageServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { FormulationsTable } from "./formulations-table";
import { NewFormulationButton } from "./new-formulation-button";

function resolveFormulationsPermission(
  isOwner: boolean,
  permissions: Record<string, unknown>,
): "admin" | "write" | "read" | "none" {
  if (isOwner) return "admin";
  const level = permissions.formulations;
  if (level === "admin" || level === "write" || level === "read") {
    return level;
  }
  return "none";
}

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

  const level = resolveFormulationsPermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
  );

  const tFormulations = await getTranslations("formulations");
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
            {tFormulations("access_denied.title")}
          </h1>
          <p className="mt-3 text-sm text-ink-600">
            {tFormulations("access_denied.body")}
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

  const initialFirstPage = await getFormulationsFirstPageServer(
    primaryOrg.id,
    { ordering: "-updated_at", pageSize: 50 },
  );
  const canWrite = level === "write" || level === "admin";

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <section className="mt-10 flex items-end justify-between gap-6 md:mt-12">
          <div>
            <Breadcrumbs
              items={[
                { label: tNav("main.dashboard"), href: "/home" },
                { label: tNav("main.formulations") },
              ]}
            />
            <p className="mt-4 font-mono text-[11px] tracking-widest uppercase text-ink-500">
              {primaryOrg.name}
            </p>
            <h1 className="mt-3 text-4xl font-black tracking-tight uppercase md:text-6xl">
              {tFormulations("title")}
            </h1>
            <p className="mt-3 text-sm text-ink-600">
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

        <footer className="mt-auto flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
