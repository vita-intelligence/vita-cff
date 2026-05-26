import { setRequestLocale } from "next-intl/server";

import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getFormulationServer,
  getActiveOrganizationServer,
} from "@/lib/auth/server";

import { CFFQuickViewButton } from "@/components/cff/cff-quick-view-button";

import { ProjectCommentsBubble } from "./project-comments-bubble";


/**
 * Layout for the ``/formulations/[id]`` route subtree.
 *
 * Wraps every project tab (Overview, Builder, Spec sheets, Proposals,
 * Trial batches, QC) so the comment bubble stays mounted across tab
 * navigation. Without a layout the bubble would unmount on every tab
 * switch and lose its WebSocket subscription, unread count, and
 * scroll position.
 *
 * The layout only fetches the bare minimum needed to mount the
 * bubble — user, organization, formulation header. Heavy data
 * (overview aggregates, version lists) stays inside each page's own
 * loader so the layout-level fetch doesn't slow down navigation.
 *
 * Anonymous visitors / users in a different org silently get no
 * bubble — the page-level loaders handle the auth + 404 flow.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ locale: string; id: string }>;
  children: React.ReactNode;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    return <>{children}</>;
  }

  const organization = await getActiveOrganizationServer();
  if (!organization) {
    return <>{children}</>;
  }

  const canRead = hasFlatCapability(
    organization,
    "formulations",
    "comments_view",
  );
  if (!canRead) {
    return <>{children}</>;
  }

  // We need the project name for the bubble header. Cheap fetch
  // (single Formulation row, cached by the SSR layer) — the page
  // loaders re-use the same endpoint so this hit deduplicates.
  const formulation = await getFormulationServer(organization.id, id);
  if (!formulation) {
    // ID isn't valid or belongs to another org. Let the page render
    // its own 404 — no bubble.
    return <>{children}</>;
  }

  const canWrite = hasFlatCapability(
    organization,
    "formulations",
    "comments_write",
  );
  const canModerate = hasFlatCapability(
    organization,
    "formulations",
    "comments_moderate",
  );

  return (
    <>
      {children}
      {/* Floating CFF bubble (bottom-left). Self-hides for projects
          without an attached CFF or for members without the
          cff_submissions.view cap, so legacy projects show nothing. */}
      <CFFQuickViewButton organization={organization} projectId={id} />
      <ProjectCommentsBubble
        orgId={organization.id}
        formulationId={id}
        currentUserId={user.id}
        projectName={formulation.name}
        canRead={canRead}
        canWrite={canWrite}
        canModerate={canModerate}
      />
    </>
  );
}
