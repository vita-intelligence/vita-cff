import { notFound } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { ActivationForm } from "./activation-form";


/**
 * Activation landing page.
 *
 * The token comes from the kiosk email link. We probe the preview
 * endpoint server-side so we can render either "set your password"
 * or "this account already exists — sign in" without making the
 * customer submit a blank form to find out. Fully fetched on the
 * server means anyone landing here with a bad / expired token sees
 * a clean 404 instead of a flicker of "loading…" then an error.
 */
export default async function ActivatePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { token } = await params;

  // We do the preview fetch from the server so the page can decide
  // its copy before any JS runs. Using ``fetch`` directly here
  // bypasses the axios client (which is browser-side) and reaches
  // the backend via the Next /api proxy.
  const res = await fetch(
    `${env.NEXT_PUBLIC_API_URL}/api/portal/activate/${token}/preview/`,
    { cache: "no-store" },
  ).catch(() => null);

  if (!res || res.status === 404) {
    // Unknown token — let Next render its 404 page so a brute-force
    // sweep can't tell a real token apart from a fake one based on
    // response shape.
    notFound();
  }
  if (res.status === 409) {
    // Token is valid but the customer side of the link is missing
    // an email (or the customer was never attached). Surface a
    // friendly "ask the team" message rather than a 404 — the
    // visitor IS the right person; the setup just isn't complete.
    return (
      <PortalShell minimal>
        <ActivationMissingState />
      </PortalShell>
    );
  }
  if (!res.ok) {
    // Unknown failure (500, network glitch). Render the same
    // "contact the team" surface so the visitor isn't stuck on a
    // bare 404. The error is logged in the backend by the time
    // they see this.
    return (
      <PortalShell minimal>
        <ActivationMissingState />
      </PortalShell>
    );
  }
  const preview = (await res.json()) as {
    customer_company: string;
    email_masked: string;
    already_activated: boolean;
    proposal_code: string;
  };

  return (
    <PortalShell minimal>
      <ActivationForm
        token={token}
        customerCompany={preview.customer_company}
        emailMasked={preview.email_masked}
        alreadyActivated={preview.already_activated}
        proposalCode={preview.proposal_code}
      />
    </PortalShell>
  );
}


function ActivationMissingState() {
  return (
    <div className="mx-auto max-w-xl border-2 border-black bg-white p-8 shadow-[6px_6px_0_#000]">
      <h1 className="mb-4 text-3xl font-black uppercase tracking-tight">
        We need a moment
      </h1>
      <p className="mb-4 text-sm leading-relaxed">
        Your link is valid, but your customer record at Vita NPD is
        still missing the email address we need to set up your portal
        account.
      </p>
      <p className="text-sm leading-relaxed">
        Please contact our customer service and we will sort it from
        our side, then re-send the link.
      </p>
    </div>
  );
}
