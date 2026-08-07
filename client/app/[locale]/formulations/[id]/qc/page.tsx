import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { getProjectValidationsServer } from "@/lib/auth/server";

import { loadProjectForTab } from "../_shared/load-project";
import { ProjectShell } from "../project-shell";
import { AutoValidationHandler } from "./auto-validation-handler";
import { QCList } from "./qc-list";
import { APP_VERSION } from "@/config/version";


export default async function ProjectQCPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams?: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const { user, organization, formulation, overview } =
    await loadProjectForTab(locale, id);

  const validations =
    (await getProjectValidationsServer(organization.id, formulation.id)) ?? [];

  // Auto-open / auto-create flow triggered from PSP's Output QC page.
  // When the URL carries ``?auto=1&trial_batch=<uuid>``, delegate to
  // <AutoValidationHandler /> — a client component that either opens
  // the existing validation for that batch or creates a new one and
  // redirects into the editor. Rendered alongside the normal list so
  // the operator has something to look at during the redirect (and a
  // usable fallback if the auto-flow errors).
  const sp = (await searchParams) ?? {};
  const autoParam = readParam(sp, "auto");
  const trialBatchParam = readParam(sp, "trial_batch");
  const autoRequested = autoParam === "1" && !!trialBatchParam;

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user} active="formulations" />

        <ProjectShell
          organization={organization}
          overview={overview}
          activeTab="qc"
        >
          {autoRequested && trialBatchParam && (
            <AutoValidationHandler
              orgId={organization.id}
              formulationId={formulation.id}
              trialBatchId={trialBatchParam}
            />
          )}
          <QCList
            orgId={organization.id}
            formulationId={formulation.id}
            validations={validations}
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

function readParam(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const raw = sp[key];
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0].trim() || null;
  }
  return null;
}
