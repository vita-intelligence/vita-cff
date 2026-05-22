import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { RDPipelineBoardView } from "./rd-pipeline-board-view";


/**
 * R&D kanban page.
 *
 * Mirrors :func:`PipelinePage` but for the R&D funnel: every column
 * is a lifecycle stage derived from the project's child-document
 * state (Builder → Spec drafting → Spec approved → Proposal →
 * Closed). Default "Mine" scope filters to
 * ``lead_scientist=request.user``; members with
 * ``formulations.view_all_rd_pipeline`` also see an "All" toggle so
 * R&D leads can watch the whole team's funnel.
 *
 * Gated by ``formulations.view`` — anyone who can see the Projects
 * list can land here. The scope toggle's visibility is governed by
 * the broader ``view_all_rd_pipeline`` cap, surfaced on the bundled
 * board's ``scope_capabilities`` payload.
 */
export default async function RDPipelinePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) redirect({ href: "/sign-in", locale });

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const organization = organizations[0];
  if (!organization) redirect({ href: "/home", locale });

  if (!hasFlatCapability(organization!, "formulations", "view")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1600px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="rd_pipeline" />

        <RDPipelineBoardView orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
