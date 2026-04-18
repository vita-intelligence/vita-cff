import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { getProjectValidationsServer } from "@/lib/auth/server";

import { loadProjectForTab } from "../_shared/load-project";
import { ProjectShell } from "../project-shell";
import { QCList } from "./qc-list";


export default async function ProjectQCPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const { user, organization, formulation, overview } =
    await loadProjectForTab(locale, id);

  const validations =
    (await getProjectValidationsServer(organization.id, formulation.id)) ?? [];

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user} active="formulations" />

        <ProjectShell
          organization={organization}
          overview={overview}
          rdStatus={formulation.status}
          activeTab="qc"
        >
          <QCList
            orgId={organization.id}
            formulationId={formulation.id}
            validations={validations}
          />
        </ProjectShell>

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
