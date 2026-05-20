import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import {
  Card,
  H1,
  H2,
  PortalButton,
  PortalShell,
  StatusPill,
} from "@/components/portal/brutalist";
import { MessagesPanel } from "@/components/portal/messages-panel";


/**
 * Proposal view — the customer-facing read-and-sign surface.
 *
 * The full proposal HTML is iframed in from the portal PDF
 * endpoint (which returns HTML, despite the legacy URL fragment).
 * Iframing keeps the visual fidelity of the existing render
 * pipeline — same Django template, same WeasyPrint-friendly CSS,
 * same look as the staff preview and the email PDF — without
 * forcing the portal to re-implement table-of-lines layouts.
 *
 * Sign / reject UI is intentionally minimal in this first cut
 * (just a "Sign" CTA that opens a follow-up route). The signature
 * canvas + acknowledgement checkboxes will land in the next slice.
 */
export default async function PortalProposalPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { id } = await params;
  const jar = await cookies();
  const portalCookie = jar.get("vita_portal_access");
  if (!portalCookie) {
    redirect(`/portal/login`);
  }

  const base = process.env.NEXT_PUBLIC_APP_BASE_URL || "";
  const headers = { Cookie: `vita_portal_access=${portalCookie.value}` };
  const res = await fetch(`${base}/api/portal/proposals/${id}/`, {
    cache: "no-store",
    headers,
  }).catch(() => null);

  if (!res) {
    notFound();
  }
  if (res.status === 401 || res.status === 403) {
    redirect("/portal/login");
  }
  if (res.status === 404) {
    notFound();
  }
  if (!res.ok) {
    notFound();
  }
  const proposal = await res.json();
  const status = proposal?.status || "unknown";
  const code = proposal?.code || "Proposal";

  return (
    <PortalShell>
      <div className="mb-6 flex items-center justify-between">
        <H1>{code}</H1>
        <StatusPill status={status} />
      </div>
      <Card className="mb-6">
        <H2>Document</H2>
        <p className="mb-4 text-sm">
          The full proposal is shown below. Use the buttons at the bottom
          to download a PDF copy or to sign.
        </p>
        <div className="border-2 border-black">
          <iframe
            src={`/api/portal/proposals/${id}/pdf/`}
            title={`Proposal ${code}`}
            className="block h-[900px] w-full bg-white"
          />
        </div>
      </Card>
      <div className="mb-8 flex flex-wrap gap-4">
        <a href={`/api/portal/proposals/${id}/download/`} target="_blank">
          <PortalButton variant="secondary">Download PDF</PortalButton>
        </a>
        {/* Only show the sign / decline CTAs while the proposal is in
            a state that accepts customer action. Signed / rejected /
            accepted proposals render read-only here; the backend
            still 400s on a stale request, but hiding the buttons
            keeps the surface honest. */}
        {status === "sent" ? (
          <>
            <a href={`/portal/proposals/${id}/sign`}>
              <PortalButton>Sign proposal →</PortalButton>
            </a>
            <a href={`/portal/proposals/${id}/reject`}>
              <PortalButton variant="secondary">Decline</PortalButton>
            </a>
          </>
        ) : null}
      </div>
      <MessagesPanel proposalId={id} />
    </PortalShell>
  );
}
