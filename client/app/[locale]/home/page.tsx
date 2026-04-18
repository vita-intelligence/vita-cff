import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { CreateOrganizationCard } from "./create-organization-card";
import { InviteMemberCard } from "./invite-member-card";
import { OrganizationCard } from "./organization-card";
import { ProfileCard } from "./profile-card";

/**
 * ``/home`` — protected route.
 *
 * Server-side auth check runs before any HTML is shipped: missing or
 * invalid cookie redirects to ``/login``.
 */
export default async function HomePage({
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
  const primaryOrg = organizations[0];
  const hasOrg = Boolean(primaryOrg);
  const canInvite = Boolean(primaryOrg?.is_owner);

  const tCommon = await getTranslations("common");
  const tOrgs = await getTranslations("organizations");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} active="dashboard" />

        <section className="mt-10 md:mt-14">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tCommon("dashboard.eyebrow")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl md:text-4xl">
            {hasOrg
              ? tCommon("dashboard.welcome_back")
              : tCommon("dashboard.welcome_new")}
          </h1>
        </section>

        <section className="mt-8 grid grid-cols-1 gap-4 md:mt-10 md:grid-cols-2 md:gap-6">
          <ProfileCard user={currentUser} label={tOrgs("profile")} />
          {hasOrg ? (
            <OrganizationCard
              organization={primaryOrg!}
              label={tOrgs("your_organization")}
              roleLabel={
                primaryOrg!.is_owner
                  ? tOrgs("role.owner")
                  : tOrgs("role.member")
              }
            />
          ) : (
            <CreateOrganizationCard />
          )}
        </section>

        {canInvite ? (
          <section className="mt-4 md:mt-6">
            <InviteMemberCard orgId={primaryOrg!.id} />
          </section>
        ) : null}

        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
