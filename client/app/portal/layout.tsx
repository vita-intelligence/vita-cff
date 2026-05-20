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
 * Lives at ``app/portal/...`` rather than ``app/[locale]/portal/``
 * because ``[locale]`` would otherwise greedily match the URL
 * prefix ``api`` (and any other arbitrary first segment), so
 * ``POST /api/portal/...`` was hitting the page tree (and being
 * blocked by the parent locale layout's ``notFound()``) instead
 * of falling through to the Django proxy. Portal is English-only
 * for now anyway, so dropping the next-intl layer is fine.
 */
export default async function PortalLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
