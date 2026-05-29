import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { LabellingWorkspace } from "./labelling-workspace";
import { APP_VERSION } from "@/config/version";


export default async function LabellingWorkspacePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    await redirectToLogin(locale);
  }
  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  if (!hasFlatCapability(organization!, "labelling", "view")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");
  const canReviewScientist = hasFlatCapability(
    organization!,
    "labelling",
    "review_scientist",
  );
  const canReviewDirector = hasFlatCapability(
    organization!,
    "labelling",
    "review_director",
  );
  const canDesign = hasFlatCapability(organization!, "labelling", "design");
  const canManage = hasFlatCapability(organization!, "labelling", "manage");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="labelling" />

        <LabellingWorkspace
          orgId={organization!.id}
          labelDesignId={id}
          canDesign={canDesign}
          canReviewScientist={canReviewScientist}
          canReviewDirector={canReviewDirector}
          canManage={canManage}
        />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
