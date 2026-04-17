import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getFormulationServer,
  getTrialBatchServer,
  getUserOrganizationsServer,
  getValidationServer,
  getValidationStatsServer,
} from "@/lib/auth/server";

import { ValidationEditor } from "./validation-editor";


function resolveFormulationsPermission(
  isOwner: boolean,
  permissions: Record<string, unknown>,
): "admin" | "write" | "read" | "none" {
  if (isOwner) return "admin";
  const level = permissions.formulations;
  if (level === "admin" || level === "write" || level === "read") {
    return level;
  }
  return "none";
}


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

  const level = resolveFormulationsPermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
  );
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
  const tNav = await getTranslations("navigation");
  const tV = await getTranslations("product_validation");
  const tBatches = await getTranslations("trial_batches");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="formulations" />

        <section className="mt-10 md:mt-12">
          <Breadcrumbs
            items={[
              { label: tNav("main.dashboard"), href: "/home" },
              { label: tNav("main.formulations"), href: "/formulations" },
              {
                label: formulation.name,
                href: `/formulations/${formulation.id}`,
              },
              {
                label: batch.label || tBatches("detail.breadcrumb_untitled"),
                href: `/formulations/${formulation.id}/trial-batches/${batch.id}`,
              },
              { label: tV("breadcrumb") },
            ]}
          />
        </section>

        <ValidationEditor
          orgId={primaryOrg.id}
          formulationId={formulation.id}
          batchId={batch.id}
          initialValidation={validation}
          initialStats={stats}
          canWrite={canWrite}
        />

        <footer className="mt-10 flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
