import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import { getCurrentUserServer } from "@/lib/auth/server";

import { SettingsShell } from "../settings-shell";
import { MembersTab } from "./members-tab";


export default async function SettingsMembersPage({
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

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />

        <SettingsShell activeTab="members">
          <MembersTab />
        </SettingsShell>

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
