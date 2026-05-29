import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { PipelineBoardView } from "./pipeline-board-view";
import { APP_VERSION } from "@/config/version";


/**
 * CRM-style pipeline page.
 *
 * Renders a kanban-style funnel of every proposal in the user's
 * commercial pipeline. The default "Mine" scope shows only the
 * caller's own proposals (``sales_person=request.user``); members
 * with the ``proposals.view_all`` capability also see an "All"
 * toggle that drops the ownership filter so commercial leads can
 * watch the whole team's funnel.
 *
 * Gated by ``proposals.view`` — the same module that gates
 * ``/proposals`` and ``/customers`` — so a sales-only role lands
 * here without needing any project-edit rights.
 */
export default async function PipelinePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    await redirectToLogin(locale);
  }

  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  if (!hasFlatCapability(organization!, "proposals", "view")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1600px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="pipeline" />

        <PipelineBoardView orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
