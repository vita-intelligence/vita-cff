import { setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { DesignPreview } from "./design-preview";


/**
 * Hidden ``/design-preview`` route — shows the proposed Project
 * Overview tab in two stylistic treatments (brutalist vs modern)
 * side-by-side so a stakeholder can flip between them and pick one.
 * Uses hard-coded mock data that mirrors the real Valley Low Fat
 * Burner project so the comparison is realistic without wiring up
 * the real overview endpoint (which doesn't exist yet). Deleted
 * after the design decision lands.
 */
export default async function DesignPreviewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }

  const orgs = (await getUserOrganizationsServer()) ?? [];
  if (orgs.length === 0) {
    redirect({ href: "/home", locale });
  }

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-6 py-8 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="formulations" />
        <DesignPreview />
      </div>
    </main>
  );
}
