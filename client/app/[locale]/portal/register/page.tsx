import { cookies } from "next/headers";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { PortalAlreadySignedIn } from "../login/portal-already-signed-in";
import { PortalRegisterForm } from "./portal-register-form";


/**
 * Portal self-registration surface.
 *
 * Same shell + already-signed-in probe as ``/portal/login`` — a
 * customer who's logged in shouldn't see the registration form,
 * just a sign-out CTA. The cookie probe happens server-side so
 * we don't flash the registration UI for a logged-in caller
 * before the client-side bootstrap catches up.
 */
export default async function PortalRegisterPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");

  let activeIdentity: { email: string; company: string } | null = null;
  if (portalCookie) {
    try {
      const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/portal/auth/me/`, {
        cache: "no-store",
        headers: { Cookie: `vita_portal_access=${portalCookie.value}` },
      });
      if (res.ok) {
        const me = await res.json();
        activeIdentity = {
          email: me.email ?? "",
          company: me.customer_company ?? "",
        };
      }
    } catch {
      // Network blip — fall through to the form.
    }
  }

  return (
    <PortalShell minimal>
      {activeIdentity ? (
        <PortalAlreadySignedIn
          email={activeIdentity.email}
          company={activeIdentity.company}
        />
      ) : (
        <PortalRegisterForm />
      )}
    </PortalShell>
  );
}
