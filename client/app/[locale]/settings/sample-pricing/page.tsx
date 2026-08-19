import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";
import { redirectToLogin } from "@/lib/auth/redirects";
import { redirect } from "@/i18n/navigation";

import { SettingsShell } from "../settings-shell";
import { computeAllowedSettingsTabs } from "../_shared/allowed-tabs";
import { APP_VERSION } from "@/config/version";
import { SamplePricingTab } from "./sample-pricing-tab";


export default async function SettingsSamplePricingPage({
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
  // Gate matches the FE tab visibility + backend RBAC. Anyone
  // landing here without ``sample_pricing.view`` bounces to the
  // safe default settings surface — the tab is already hidden for
  // them, this is defence-in-depth for hand-typed URLs.
  if (!hasFlatCapability(organization, "sample_pricing", "view")) {
    redirect({ href: "/settings", locale });
  }

  const allowedTabs = computeAllowedSettingsTabs(organization);
  const canEdit = hasFlatCapability(organization, "sample_pricing", "edit");
  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />

        <SettingsShell activeTab="sample-pricing" allowedTabs={allowedTabs}>
          <SamplePricingTab
            orgId={organization!.id}
            canEdit={canEdit}
          />
        </SettingsShell>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
