import { cookies } from "next/headers";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { PortalAlreadySignedIn } from "./portal-already-signed-in";
import { PortalLoginForm } from "./portal-login-form";


/**
 * Portal sign-in surface.
 *
 * Deliberately NOT redirecting away when the caller already holds
 * a portal cookie — the customer might be trying to switch
 * accounts. Instead we render an "already signed in as X" card
 * with a sign-out CTA, then fall back to the form once they've
 * cleared the session.
 *
 * The cookie probe happens server-side so we don't flash the
 * full sign-in form for a logged-in caller before the client-
 * side bootstrap catches up.
 */
export default async function PortalLoginPage() {
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");

  let activeIdentity: { email: string; company: string } | null = null;
  if (portalCookie) {
    // Probe ``/api/portal/auth/me/`` server-side to confirm the
    // cookie is still valid + grab a label for the "you are
    // logged in as …" banner. A 401 means the cookie is stale —
    // we treat that as "not logged in" and render the form
    // normally without making the customer manually clear an
    // already-dead session.
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
      // Network blip — fall through to the form. A real auth
      // problem will surface on the next API call anyway.
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
        <PortalLoginForm />
      )}
    </PortalShell>
  );
}
