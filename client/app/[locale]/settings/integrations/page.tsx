import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";

import { SettingsShell } from "../settings-shell";
import { computeAllowedSettingsTabs } from "../_shared/allowed-tabs";
import { IntegrationsTab } from "./integrations-tab";


export default async function SettingsIntegrationsPage({
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

  const primaryOrg = await getActiveOrganizationServer();
  const allowedTabs = computeAllowedSettingsTabs(primaryOrg);

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />

        <SettingsShell activeTab="integrations" allowedTabs={allowedTabs}>
          <IntegrationsTab organization={primaryOrg} />
        </SettingsShell>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
