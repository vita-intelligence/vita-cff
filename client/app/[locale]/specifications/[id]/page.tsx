import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import {
  hasFlatCapability,
  resolveLegacyFlatLevel,
} from "@/lib/auth/capabilities";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getCurrentUserServer,
  getRenderedSpecificationServer,
  getSpecificationServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { SpecificationSheetView } from "./specification-sheet-view";

export default async function SpecificationDetailPage({
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
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = organizations[0]!;

  // Spec sheets piggy-back on the ``formulations`` module — there is
  // no standalone ``specifications`` entry in the capability registry.
  // Pulling the level from the right module keeps non-owner members
  // out of the "access denied → /formulations" redirect loop.
  const level = resolveLegacyFlatLevel(primaryOrg, "formulations");
  if (level === "none") {
    redirect({ href: "/formulations", locale });
  }

  const [sheet, rendered] = await Promise.all([
    getSpecificationServer(primaryOrg.id, id),
    getRenderedSpecificationServer(primaryOrg.id, id),
  ]);
  if (!sheet || !rendered) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";
  const canAdmin = level === "admin";
  // The visibility toggle sits on its own capability so commercial
  // leads can hide client-facing sections without needing edit or
  // admin rights on the sheet itself.
  const canManageVisibility = hasFlatCapability(
    primaryOrg,
    "formulations",
    "manage_spec_visibility",
  );
  // Director-grade transitions (in_review → approved, manual close
  // to rejected, revert from approved) require the ``approve`` cap.
  // Split from ``canWrite`` so a scientist with EDIT can draft and
  // send for review but can't flip their own work to approved.
  const canApprove = hasFlatCapability(
    primaryOrg,
    "formulations",
    "approve",
  );

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12 print:max-w-none print:p-6">
        <div className="print:hidden">
          <ProtectedHeader user={currentUser} active="formulations" />
        </div>

        <SpecificationSheetView
          orgId={primaryOrg.id}
          sheet={sheet}
          rendered={rendered}
          canWrite={canWrite}
          canApprove={canApprove}
          canAdmin={canAdmin}
          canManageVisibility={canManageVisibility}
          organization={primaryOrg}
          currentUserId={currentUser.id}
        />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500 print:hidden">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
