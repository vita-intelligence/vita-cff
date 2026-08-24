import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { getActiveOrganizationServer, getCurrentUserServer } from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { FinalSpecsShell } from "./final-specs-shell";
import { APP_VERSION } from "@/config/version";


/**
 * /final-specs — scientist surface for the FINAL-spec pipeline.
 *
 * Three-column kanban keyed on lifecycle stage:
 *   * Needs your click — spec approved internally, waiting for the
 *     team to hit Send-to-client.
 *   * In flight — customer's turn (spec sent, awaiting signature)
 *     OR finance's turn (customer signed, FINAL invoice pending
 *     approval).
 *   * Closed — accepted + paid, or rejected by customer.
 *
 * Mirrors ``/trial-batches/`` shape so the two scientist surfaces
 * feel like sibling views. Gated on ``formulations.edit`` because
 * every downstream click on a FINAL card (open detail, Send,
 * Regenerate) is a project-edit action.
 */
export default async function FinalSpecsPage({
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
        <ProtectedHeader user={user!} active="final-specs" />

        <FinalSpecsShell orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
