import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { getActiveOrganizationServer, getCurrentUserServer } from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { TrialCyclesShell } from "./cycles-shell";
import { APP_VERSION } from "@/config/version";


/**
 * /trial-batches — scientist surface for custom-formulation
 * trial-batch cycles.
 *
 * Dedicated page (moved out of /samples, where the module was
 * mixing the cycle workflow with the storefront sample-kit queue).
 * Server-side auth + org guard; the interactive table + attention
 * pane + modals all live in :module:`./cycles-shell`.
 *
 * Gated by ``formulations.edit`` — every action on this page
 * (create sample batch, open next slot, team-override close) is a
 * project-edit action. Anything narrower would leave the page
 * unclickable for legitimate viewers.
 */
export default async function TrialBatchesPage({
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

  if (!hasFlatCapability(organization!, "formulations", "edit")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="trial-batches" />

        <TrialCyclesShell orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
