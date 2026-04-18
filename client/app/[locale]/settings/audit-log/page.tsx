import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { SettingsShell } from "../settings-shell";
import { computeAllowedSettingsTabs } from "../_shared/allowed-tabs";
import { AuditLogTab } from "./audit-log-tab";


/**
 * Settings > Audit log route.
 *
 * Server-side guards: unauthenticated users bounce to login; users
 * without an organisation go to the Organisation tab (fresh account
 * flow); users without the ``audit.view`` capability see a 404-like
 * "tab not available" because the link shouldn't have rendered at
 * all. Actual data loads client-side through the infinite-query
 * hook so filter changes stay interactive without round-tripping
 * the server.
 */
export default async function SettingsAuditLogPage({
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
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const primaryOrg = organizations[0] ?? null;
  if (!primaryOrg) {
    redirect({ href: "/settings/organization", locale });
  }
  const org = primaryOrg!;

  const allowedTabs = computeAllowedSettingsTabs(org);

  const tCommon = await getTranslations("common");
  const tAudit = await getTranslations("audit_log");

  const canView = hasFlatCapability(org, "audit", "view");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />
        <SettingsShell activeTab="audit-log" allowedTabs={allowedTabs}>
          {canView ? (
            <AuditLogTab orgId={org.id} />
          ) : (
            <div className="rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
              <p className="text-sm font-medium text-ink-1000">
                {tAudit("access_denied.title")}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                {tAudit("access_denied.hint")}
              </p>
            </div>
          )}
        </SettingsShell>
        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
