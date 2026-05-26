import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getActiveOrganizationServer,
} from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { CFFInbox } from "./cff-inbox";


/**
 * CFF intake page. Lists every Custom Formulation Request
 * submission mirrored from the org's Wix form, with a prominent
 * "Unassigned" filter so triage can route each request to a
 * project.
 *
 * Server component: gates on ``cff_submissions.view`` before
 * rendering — a member without it gets bounced to ``/home``
 * rather than landing on a 403 that would leak the route's
 * existence.
 */
export default async function CFFPage({
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

  const canView = hasFlatCapability(
    organization!,
    "cff_submissions",
    "view",
  );
  if (!canView) {
    redirect({ href: "/home", locale });
  }

  const canAssign = hasFlatCapability(
    organization!,
    "cff_submissions",
    "assign_project",
  );

  const tPage = await getTranslations("cff.page");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="cff" />

        <header className="mt-8 flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {tPage("title")}
          </h1>
          <p className="text-sm text-ink-600">{tPage("subtitle")}</p>
        </header>

        <CFFInbox
          orgId={organization!.id}
          canAssign={canAssign}
        />
      </div>
    </main>
  );
}
