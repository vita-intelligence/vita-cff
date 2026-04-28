import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { ApprovalsInbox } from "./approvals-inbox";


/**
 * Director / approver inbox. Surfaces every document currently
 * sitting at ``in_review`` so a reviewer can sweep their queue
 * without trawling per-project pages. Each card deep-links into
 * the existing detail page with ``?action=approve``, which auto-
 * opens the canonical signature dialog so the audit trail stays
 * identical to the per-document flow.
 *
 * Server component: gates on the ``formulations:approve`` capability
 * before rendering — a member without it gets bounced to ``/home``
 * rather than landing on a 403 surface that exposes the route's
 * existence.
 */
export default async function ApprovalsPage({
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

  if (!hasFlatCapability(organization!, "formulations", "view_approvals")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="approvals" />

        <ApprovalsInbox orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
