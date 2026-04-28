import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { SignedDocuments } from "./signed-documents";


/**
 * Customer-facing document archive. Two tabs (Proposals,
 * Specifications), each carrying two sections — what's currently
 * out with the client awaiting signature (``status=sent``) and
 * what's already been signed on the kiosk (``status=accepted``).
 *
 * Every row deep-links to the existing detail page where the
 * signed PDF and signature stamps render — this page is purely a
 * sweep view, the canonical render still lives on the per-document
 * page.
 *
 * Server component: gates on the ``formulations:view`` capability.
 * Anyone who can see the project module gets the history surface;
 * the page is read-only so we don't tighten further.
 */
export default async function SignedPage({
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

  if (!hasFlatCapability(organization!, "formulations", "view_signed")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="signed" />

        <SignedDocuments orgId={organization!.id} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
