import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { H1, P, PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { AvatarSection } from "./avatar-section";
import { EmailSection } from "./email-section";
import { PasswordSection } from "./password-section";
import { ProfileSection } from "./profile-section";


function initialsOf(profile: { name: string; company: string; email: string }): string {
  const source = (profile.name || profile.company || profile.email || "").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}


/**
 * Customer settings — Profile + Email + Password.
 *
 * Server component. Reads the portal cookie via ``next/headers``
 * and forwards it to the backend ``/api/portal/profile/`` so the
 * three section components mount already-populated and the
 * customer never sees an empty form flash on load.
 *
 * Layout is one column of cards — Profile (direct edit), Email
 * (two-step verification), Password (current + new). The
 * trailing caveat under Profile sets expectations about the
 * Dynamics sync overwriting fields; we'd rather state it up
 * front than let the customer wonder why their edit "didn't
 * stick" after the sales team's nightly import.
 */
export default async function PortalSettingsPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect("/portal/login");
  }

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/portal/profile/`, {
    cache: "no-store",
    headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
  }).catch(() => null);

  if (!res || res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  const initial = res && res.ok
    ? await res.json()
    : null;

  if (!initial) {
    redirect("/portal/login");
  }

  // Avatar lives on the auth/me payload (the ClientAccount row);
  // pull it alongside the profile so the section mounts already
  // populated.
  const meRes = await fetch(
    `${env.NEXT_PUBLIC_API_URL}/api/portal/auth/me/`,
    {
      cache: "no-store",
      headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
    },
  ).catch(() => null);
  const me = meRes && meRes.ok ? await meRes.json() : null;
  const avatarSrc: string = me?.avatar_image ?? "";

  return (
    <PortalShell>
      <H1>Settings</H1>
      <P>
        Update what we have on file for you, change the email we use to
        contact you, or rotate your password.
      </P>
      <div className="grid gap-6">
        <AvatarSection
          initialAvatar={avatarSrc}
          initialInitials={initialsOf(initial)}
        />
        <ProfileSection initial={initial} />
        <EmailSection initialEmail={initial.email} />
        <PasswordSection />
      </div>
    </PortalShell>
  );
}
