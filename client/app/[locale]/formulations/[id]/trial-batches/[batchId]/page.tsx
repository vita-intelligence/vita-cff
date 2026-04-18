import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getFormulationServer,
  getTrialBatchRenderServer,
  getTrialBatchServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { TrialBatchDetail } from "./trial-batch-detail";


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

  const level = resolveFormulationsPermission(
    primaryOrg.is_owner,
    primaryOrg.permissions,
  );
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
  const tNav = await getTranslations("navigation");
  const tBatches = await getTranslations("trial_batches");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
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
                label:
                  batch.label || tBatches("detail.breadcrumb_untitled"),
              },
            ]}
          />
        </section>

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
