import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";

import { loadProjectForTab } from "./_shared/load-project";
import { ProjectOverview } from "./project-overview";
import { ProjectShell } from "./project-shell";
import { RTGCatalogPanel } from "./rtg-catalog-panel";
import { APP_VERSION } from "@/config/version";


export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const { user, organization, formulation, overview, canWrite } =
    await loadProjectForTab(locale, id);

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user} active="formulations" />

        <ProjectShell
          organization={organization}
          overview={overview}
          activeTab="overview"
        >
          <div className="flex flex-col gap-6">
            <ProjectOverview
              orgId={organization.id}
              formulationId={formulation.id}
              initialData={overview}
            />
            {/* RTG catalog publish panel — self-gates on
                ``project_type === 'ready_to_go'`` internally so the
                page stays untouched for Custom projects. */}
            <RTGCatalogPanel
              orgId={organization.id}
              formulation={formulation}
              canEdit={canWrite}
            />
          </div>
        </ProjectShell>

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
