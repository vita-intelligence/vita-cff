import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { getProjectSpecificationSheetsServer } from "@/lib/auth/server";

import { loadProjectForTab } from "../_shared/load-project";
import { ProjectShell } from "../project-shell";
import { SpecSheetsList } from "./spec-sheets-list";


export default async function ProjectSpecSheetsPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const { user, organization, formulation, overview, canWrite } =
    await loadProjectForTab(locale, id);

  const sheetsPage = await getProjectSpecificationSheetsServer(
    organization.id,
    formulation.id,
  );

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user} active="formulations" />

        <ProjectShell
          organization={organization}
          overview={overview}
          rdStatus={formulation.status}
          activeTab="spec-sheets"
        >
          {sheetsPage ? (
            <SpecSheetsList
              orgId={organization.id}
              formulationId={formulation.id}
              initialPage={sheetsPage}
              canWrite={canWrite}
            />
          ) : (
            <p className="text-sm text-ink-500">—</p>
          )}
        </ProjectShell>

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
