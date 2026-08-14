import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { PortalFeedSubscriber } from "@/components/layout/portal-feed-subscriber";


/**
 * Portal layout — completely decoupled from staff chrome.
 *
 * No protected header, no formulations sidebar, no comments
 * bubble. The portal is a brutalist black-and-white surface for
 * customers; rendering the staff app's chrome here would betray
 * the design intent and leak staff-only navigation hints to
 * external visitors.
 *
 * Lives under ``[locale]`` like the staff app because Next's app
 * router requires a single root layout — moving portal out of
 * ``[locale]`` would orphan its routes (no ``<html>`` shell). To
 * stop ``[locale]`` greedily matching ``api`` and shadowing the
 * Django proxy, the ``next.config.ts`` ``beforeFiles`` bucket has
 * a rewrite for ``/api/portal/:path*`` that fires BEFORE any app
 * route can claim the URL.
 */
export default async function PortalLayout({
  params,
  children,
}: {
  params: Promise<{ locale: string }>;
  children: ReactNode;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return (
    <>
      {/*
        Live-feed subscription for the portal session. Mirror of
        the staff-side OrgFeedSubscriber slotted in ProtectedHeader.
        Mounted at layout level so every portal page inherits the
        subscription without per-page wiring — staff mutations on
        the customer's proposals / specs / label designs / payments
        reach the tab live. The socket is a client component under
        this server-component layout; that boundary is fine.
      */}
      <PortalFeedSubscriber />
      {children}
    </>
  );
}
