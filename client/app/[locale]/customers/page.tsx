import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { redirectToLogin } from "@/lib/auth/redirects";
import {
  getActiveOrganizationServer,
  getCurrentUserServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { CustomersList } from "./customers-list";
import { APP_VERSION } from "@/config/version";


/**
 * Org-wide customer address-book. Sales adds a client here once and
 * the proposal picker reuses the record — avoids re-typing company
 * + email + addresses on every quote.
 */
export default async function CustomersPage({
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

  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  // Customers are the address book behind proposals — gated on the
  // same module so a sales role can manage the list.
  if (!hasFlatCapability(organization!, "proposals", "view")) {
    redirect({ href: "/home", locale });
  }

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="customers" />

        <CustomersList
          orgId={organization!.id}
          dynamicsManaged={Boolean(
            organization!.dynamics_customers_managed,
          )}
        />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v{APP_VERSION}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
