import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import { resolveLegacyFlatLevel } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getFormulationServer,
  getTrialBatchServer,
  getUserOrganizationsServer,
  getValidationServer,
  getValidationStatsServer,
} from "@/lib/auth/server";

import { ValidationEditor } from "./validation-editor";


export default async function ProductValidationPage({
  params,
}: {
  params: Promise<{
    locale: string;
    id: string;
    batchId: string;
    validationId: string;
  }>;
}) {
  const { locale, id, batchId, validationId } = await params;
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

  const [formulation, batch, validation, stats] = await Promise.all([
    getFormulationServer(primaryOrg.id, id),
    getTrialBatchServer(primaryOrg.id, batchId),
    getValidationServer(primaryOrg.id, validationId),
    getValidationStatsServer(primaryOrg.id, validationId),
  ]);
  if (!formulation || !batch || !validation || !stats) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <ValidationEditor
          orgId={primaryOrg.id}
          formulationId={formulation.id}
          batchId={batch.id}
          initialValidation={validation}
          initialStats={stats}
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
