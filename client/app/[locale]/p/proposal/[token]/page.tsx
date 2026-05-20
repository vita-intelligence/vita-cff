import { permanentRedirect } from "next/navigation";


/**
 * Legacy kiosk URL — kept around only as a redirect to the new
 * customer portal activation page.
 *
 * The kiosk lived here while customers signed proposals
 * anonymously via a token-gated public page. That flow is gone:
 * everything is behind authenticated portal sessions now, and the
 * same ``public_token`` is repurposed as the one-shot activation
 * credential. We use a 308 permanent redirect (via
 * :func:`permanentRedirect`) rather than a 404 so any in-flight
 * email link from before the cutover resolves cleanly to the new
 * entry point.
 *
 * ``proposal-kiosk-view.tsx`` is intentionally left in the tree
 * as dead code for one release cycle; the next branch can delete
 * it once we're sure no one's bookmarked a deep link into it.
 */
export default async function LegacyKioskPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  permanentRedirect(`/${locale}/portal/activate/${token}`);
}
