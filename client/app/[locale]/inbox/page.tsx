import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { InboxView } from "./inbox-view";


/**
 * Unified mailbox for every thread the staff member can see.
 *
 * The data already flows through ``/api/comments/inbox/`` — the
 * messenger-bell dropdown consumes the same endpoint to render its
 * 5-row preview. This page is the full-fat companion: a two-pane
 * mailbox layout that floats customer messages to the top so
 * support / sales never lose a "the customer just replied" signal
 * in the noise of internal chatter.
 *
 * No org-scoped capability gate: every authenticated org member
 * has a personal inbox, identical posture to the bell itself.
 * Single-org users see the same threads they see in the dropdown,
 * just with the structure / filter / customer-priority overlay.
 */
export default async function InboxPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    await redirectToLogin(locale);
  }
  const currentUser = user!;

  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1600px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />

        <InboxView />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
