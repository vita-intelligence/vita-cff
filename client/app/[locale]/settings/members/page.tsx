import { getTranslations, setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { redirect } from "@/i18n/navigation";
import {
  getCataloguesServer,
  getCurrentUserServer,
  getInvitationsServer,
  getMembershipsServer,
  getModulesServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";

import { SettingsShell } from "../settings-shell";
import { computeAllowedSettingsTabs } from "../_shared/allowed-tabs";
import { MembersTab } from "./members-tab";
import { MembersTabAccessDenied } from "./members-tab-access-denied";


/**
 * Settings > Members route.
 *
 * SSR-fetches every piece of data the tab needs in parallel — members,
 * pending invitations, the capability registry, and the catalogue list
 * so the row-scoped picker knows which slugs to render. If the caller
 * doesn't have ``members.view`` the endpoints 403 and we swap in the
 * access-denied state rather than pushing them to another route.
 */
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

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const primaryOrg = organizations[0] ?? null;

  const tCommon = await getTranslations("common");

  // No org yet → send them to the Organization tab which shows the
  // create form. Avoids rendering an access-denied on their own
  // fresh account right after signup.
  if (!primaryOrg) {
    redirect({ href: "/settings/organization", locale });
  }
  const org = primaryOrg!;

  // Capability check derived from the ``permissions`` block already
  // on the organization payload. Owners bypass — their payload has
  // ``is_owner: true`` and an empty permissions dict, so we synthesise
  // the full capability set here.
  const callerCapabilities = derivedCallerCapabilities(org);
  const allowedTabs = computeAllowedSettingsTabs(org);

  // Fetch the four data surfaces in parallel — nothing here depends
  // on anything else.
  const [memberships, invitations, modules, catalogues] = await Promise.all([
    getMembershipsServer(org.id),
    getInvitationsServer(org.id),
    getModulesServer(),
    getCataloguesServer(org.id),
  ]);

  const shellWrapper = (content: React.ReactNode) => (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={currentUser} />
        <SettingsShell activeTab="members" allowedTabs={allowedTabs}>
          {content}
        </SettingsShell>
        <footer className="mt-auto flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>v0.1.0</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );

  // Either 403 on the memberships endpoint (caller lacks members.view)
  // or unreachable backend — both arrive here as ``null``.
  if (!memberships || !modules) {
    return shellWrapper(<MembersTabAccessDenied />);
  }

  const catalogueSlugs =
    (catalogues ?? []).map((c) => c.slug);

  return shellWrapper(
    <MembersTab
      orgId={org.id}
      currentUserId={currentUser.id}
      callerCapabilities={callerCapabilities}
      initialMemberships={memberships}
      initialInvitations={invitations ?? []}
      modules={modules}
      catalogueSlugs={catalogueSlugs}
    />,
  );
}


/**
 * Derive the caller's ``members`` capability list from the
 * organization payload. Owners synthesise the full set; non-owners
 * read whatever's under ``permissions.members``.
 */
function derivedCallerCapabilities(org: {
  is_owner: boolean;
  permissions: Record<string, unknown>;
}): readonly string[] {
  if (org.is_owner) {
    return ["view", "invite", "edit_permissions", "remove"];
  }
  const raw = org.permissions.members;
  return Array.isArray(raw) ? (raw as string[]) : [];
}
