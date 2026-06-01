import { redirect } from "next/navigation";


/**
 * Legacy route. The old ``/sign/`` page surfaced acknowledgements
 * + an inline signature pad **before** the customer had seen the
 * proposal content — confusing UX that made it feel like ticking
 * boxes was the sign-off. The replacement lives on the proposal
 * detail page (``/portal/proposals/[id]``): read the proposal
 * inline, scroll to the bottom to enable the acks, tick them,
 * then a "Continue to signing" CTA opens the signature dialog.
 * This server component just forwards any deep-link to the new
 * surface so old emails / bookmarks still land the customer in
 * the right place.
 */
export default async function PortalProposalSignPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/portal/proposals/${id}`);
}
