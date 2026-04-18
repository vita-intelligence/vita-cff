import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getFormulationServer,
  getProjectOverviewServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { FormulationBuilder } from "./formulation-builder";
import { ProjectOverview } from "./project-overview";
import { TrialBatchesPanelWrapper } from "./trial-batches-panel-wrapper";

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

export default async function FormulationDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
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
  if (level === "none") {
    redirect({ href: "/formulations", locale });
  }

  const [formulation, projectOverview] = await Promise.all([
    getFormulationServer(primaryOrg.id, id),
    getProjectOverviewServer(primaryOrg.id, id),
  ]);
  if (!formulation || !projectOverview) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";
  const canAdmin = level === "admin";

  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.formulations"), href: "/formulations" },
              { label: formulation.name },
            ]}
          />
        </section>

        <section className="mt-8">
          <ProjectOverview
            orgId={primaryOrg.id}
            formulationId={formulation.id}
            initialData={projectOverview}
          />
        </section>

        <FormulationBuilder
          orgId={primaryOrg.id}
          initialFormulation={formulation}
          canWrite={canWrite}
        />

        <TrialBatchesPanelWrapper
          orgId={primaryOrg.id}
          formulationId={formulation.id}
          formulationName={formulation.name}
          canWrite={canWrite}
          canDelete={canAdmin}
        />

        <footer className="mt-10 flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
