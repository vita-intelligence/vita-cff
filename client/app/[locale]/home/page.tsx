import { getTranslations, setRequestLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { CreateOrganizationCard } from "./create-organization-card";
import { HomeHeader } from "./home-header";
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
  // ``redirect`` throws at runtime, but its return type is not ``never``
  // in the current next-intl typings. Narrow explicitly for TypeScript.
  const currentUser = user!;

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const primaryOrg = organizations[0];
  const hasOrg = Boolean(primaryOrg);
  const canInvite = Boolean(primaryOrg?.is_owner);

  const tCommon = await getTranslations("common");
  const tOrgs = await getTranslations("organizations");

  const initials =
    (currentUser.first_name[0] ?? "") + (currentUser.last_name[0] ?? "");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6 py-8 md:px-10 md:py-12">
        <HomeHeader
          brand={tCommon("brand")}
          userFullName={currentUser.full_name}
          userInitials={initials.toUpperCase() || "··"}
        />

        <section className="mt-12 md:mt-16">
          <p className="font-mono text-[11px] tracking-widest uppercase text-ink-500">
            {tCommon("dashboard.eyebrow")}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase md:text-6xl">
            {hasOrg
              ? tCommon("dashboard.welcome_back")
              : tCommon("dashboard.welcome_new")}
          </h1>
        </section>

        <section className="mt-10 grid grid-cols-1 gap-6 md:mt-14 md:grid-cols-2 md:gap-8">
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
          <section className="mt-6 md:mt-8">
            <InviteMemberCard orgId={primaryOrg!.id} />
          </section>
        ) : null}

        <footer className="mt-auto flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
