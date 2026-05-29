import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getActiveOrganizationServer,
} from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { ProposalsOrgList } from "./proposals-org-list";
import { APP_VERSION } from "@/config/version";


/**
 * Top-level Proposals index. Lists every proposal in the user's
 * organization regardless of which project it pins to — a sales
 * user stitching a multi-project quote lands here rather than
 * drilling into a single project's "Proposals" tab.
 *
 * The per-project list at ``/formulations/<id>/proposals`` still
 * exists for scientists who want the project-scoped view; this
 * page is just a wider lens on the same data.
 */
export default async function OrgProposalsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) { await redirectToLogin(locale); }

  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  // Gate on the dedicated proposals module so commercial roles can
  // own this surface without inheriting broader formulations rights.
  if (!hasFlatCapability(organization!, "proposals", "view")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="proposals" />

        <ProposalsOrgList orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
