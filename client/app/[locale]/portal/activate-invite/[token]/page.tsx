import { notFound } from "next/navigation";

import { PortalShell } from "@/components/portal/brutalist";
import { env } from "@/config/env";

import { InviteActivationForm } from "./invite-activation-form";


/**
 * Customer-portal invite landing page.
 *
 * Sibling to the kiosk activate page (``/portal/activate/<token>``):
 * same two-step UX, same brutalist shell, but driven by a
 * :class:`apps.client_portal.models.CustomerPortalInvite` row
 * instead of a proposal's ``public_token``. Staff issues these from
 * the customers page when a client doesn't yet have a portal
 * account; the customer redeems here after the staff member shares
 * the link by any channel.
 *
 * The preview probe runs server-side so we can render the right
 * copy (set-password vs. already-activated vs. expired) before any
 * JS executes — a brute-force scanner gets the same shape an
 * intended recipient would, with no client-side flicker between
 * loading + final states.
 */
export default async function ActivateInvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { token } = await params;

  const res = await fetch(
    `${env.NEXT_PUBLIC_API_URL}/api/portal/invites/${token}/preview/`,
    { cache: "no-store" },
  ).catch(() => null);

  if (!res || res.status === 404) {
    notFound();
  }
  if (res.status === 409 || !res.ok) {
    // 409 = invite is bound to a customer with no email on file
    // (can't deliver the code). Anything else 5xx / network is the
    // same "we need a moment" surface so the visitor isn't stranded
    // on a bare 404.
    return (
      <PortalShell minimal>
        <InviteMissingState />
      </PortalShell>
    );
  }

  const preview = (await res.json()) as {
    customer_company: string;
    email_masked: string;
    already_activated: boolean;
    expired?: boolean;
  };

  return (
    <PortalShell minimal>
      <InviteActivationForm
        token={token}
        customerCompany={preview.customer_company}
        emailMasked={preview.email_masked}
        alreadyActivated={preview.already_activated}
        expired={preview.expired ?? false}
      />
    </PortalShell>
  );
}


function InviteMissingState() {
  return (
    <div className="mx-auto max-w-xl border-2 border-black bg-white p-8 shadow-[6px_6px_0_#000]">
      <h1 className="mb-4 text-3xl font-black uppercase tracking-tight">
        We need a moment
      </h1>
      <p className="mb-4 text-sm leading-relaxed">
        Your invite is valid, but your customer record at Vita NPD is
        still missing the email address we need to deliver the
        confirmation code.
      </p>
      <p className="text-sm leading-relaxed">
        Please contact our team and we will sort it on our side, then
        re-send the invite link.
      </p>
    </div>
  );
}
