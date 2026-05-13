import { setRequestLocale } from "next-intl/server";

import { ProjectCommentsBubble } from "@app/[locale]/formulations/[id]/project-comments-bubble";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getSpecificationServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";


/**
 * Layout for ``/specifications/[id]/**``.
 *
 * Mounts the same floating :class:`ProjectCommentsBubble` the
 * project workspace gets, pointed at the parent project's
 * formulation. That way a scientist reviewing a spec sheet can hop
 * straight into the team's internal chat about the project without
 * navigating away — same thread, same unread badge, same WS feed
 * as the project tabs.
 *
 * The existing inline ``CommentsPanel`` on the spec sheet stays put
 * — it's the client-facing kiosk thread (different audience), so we
 * deliberately render both surfaces side by side.
 *
 * Anonymous visitors and users in a different org silently get no
 * bubble — the page-level loader handles the auth + 404 flow.
 */
export default async function SpecificationLayout({
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

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const organization = organizations[0];
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

  // Cheap single-row fetch — the page-level loader hits the same
  // endpoint right after, so the SSR layer dedupes the request.
  // We only need the spec sheet's ``formulation_id`` +
  // ``formulation_name`` to scope the bubble at the parent project.
  const sheet = await getSpecificationServer(organization.id, id);
  if (!sheet) {
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
      <ProjectCommentsBubble
        orgId={organization.id}
        formulationId={sheet.formulation_id}
        currentUserId={user.id}
        projectName={sheet.formulation_name}
        canRead={canRead}
        canWrite={canWrite}
        canModerate={canModerate}
      />
    </>
  );
}
