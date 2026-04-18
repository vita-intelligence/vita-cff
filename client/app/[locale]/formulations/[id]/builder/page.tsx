import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";

import { FormulationBuilder } from "../formulation-builder";
import { loadProjectForTab } from "../_shared/load-project";
import { ProjectShell } from "../project-shell";


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
  const tNav = await getTranslations("navigation");
  const tTabs = await getTranslations("project_tabs");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={user} active="formulations" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.formulations"), href: "/formulations" },
              {
                label: formulation.name,
                href: `/formulations/${formulation.id}`,
              },
              { label: tTabs("builder") },
            ]}
          />
        </section>

        <ProjectShell overview={overview} activeTab="builder">
          <FormulationBuilder
            orgId={organization.id}
            initialFormulation={formulation}
            canWrite={canWrite}
          />
        </ProjectShell>

        <footer className="mt-10 flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
