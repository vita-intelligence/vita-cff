import { setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getActiveOrganizationServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { CFFDetailView } from "./cff-detail-view";


/**
 * Standalone CFF detail page. The list page's modal is the
 * primary triage surface (quick, draggable, keeps the inbox
 * underneath visible); this page exists so the team has somewhere
 * to host the per-CFF chat thread — comments belong on a stable
 * URL the messenger inbox + bell notifications can deep-link to.
 *
 * The modal stays the action surface (Assign / Unassign / Create
 * project); this page is the discussion surface (read-only fields
 * + the comment thread). They share the same data so the two
 * complement each other rather than diverge.
 *
 * Server component: gates on ``cff_submissions.view`` before
 * rendering. A member without the capability is bounced to
 * ``/home`` rather than landing on a 403 that would leak the
 * route's existence — same posture the list page takes.
 */
export default async function CFFDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) redirect({ href: "/sign-in", locale });

  const organization = await getActiveOrganizationServer();
  if (!organization) redirect({ href: "/home", locale });

  const canView = hasFlatCapability(
    organization!,
    "cff_submissions",
    "view",
  );
  if (!canView) {
    redirect({ href: "/home", locale });
  }

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} active="cff" />
        <CFFDetailView
          orgId={organization!.id}
          submissionId={id}
          currentUserId={user!.id}
        />
      </div>
    </main>
  );
}
