import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";

import { BuilderShell } from "./builder-shell";
import { loadProjectForTab } from "../_shared/load-project";
import { ProjectShell } from "../project-shell";
import { APP_VERSION } from "@/config/version";


export default async function ProjectBuilderPage({
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
          activeTab="builder"
        >
          {/* Client shell that pairs FormulationBuilder with the
              CostCalculator via a shared live-lines state. Extracted
              into its own component because ``page.tsx`` is a server
              component and can't hold reactive state itself. */}
          <BuilderShell
            orgId={organization.id}
            formulation={formulation}
            canWrite={canWrite}
            hasTrialBatches={(overview?.trial_batches?.total ?? 0) > 0}
          />
        </ProjectShell>

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
