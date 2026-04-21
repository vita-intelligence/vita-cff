import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import { resolveLegacyFlatLevel } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getFormulationServer,
  getTrialBatchRenderServer,
  getTrialBatchServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { TrialBatchDetail } from "./trial-batch-detail";


export default async function TrialBatchDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; batchId: string }>;
}) {
  const { locale, id, batchId } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = organizations[0]!;

  const level = resolveLegacyFlatLevel(primaryOrg, "formulations");
  if (level === "none") {
    redirect({ href: "/formulations", locale });
  }

  const [formulation, batch, bom] = await Promise.all([
    getFormulationServer(primaryOrg.id, id),
    getTrialBatchServer(primaryOrg.id, batchId),
    getTrialBatchRenderServer(primaryOrg.id, batchId),
  ]);
  if (!formulation || !batch || !bom) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <TrialBatchDetail
          orgId={primaryOrg.id}
          formulationId={formulation.id}
          initialBatch={batch}
          initialBom={bom}
          canWrite={canWrite}
        />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
