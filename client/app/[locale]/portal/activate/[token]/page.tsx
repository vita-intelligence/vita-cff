import { notFound } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";

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
    `${process.env.NEXT_PUBLIC_APP_BASE_URL || ""}/api/portal/activate/${token}/preview/`,
    { cache: "no-store" },
  ).catch(() => null);

  if (!res || res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    notFound();
  }
  const preview = (await res.json()) as {
    customer_company: string;
    email_masked: string;
    already_activated: boolean;
    proposal_code: string;
  };

  return (
    <PortalShell>
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
