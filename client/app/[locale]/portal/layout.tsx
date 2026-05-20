import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";


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
  return <>{children}</>;
}
