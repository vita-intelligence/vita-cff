import { setRequestLocale } from "next-intl/server";

import { ProtectedHeader } from "@/components/layout/protected-header";
import {
  getCurrentUserServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { ProposalSheetView } from "./proposal-sheet-view";


export default async function ProposalDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) redirect({ href: "/sign-in", locale });

  const organizations = (await getUserOrganizationsServer()) ?? [];
  const organization = organizations[0];
  if (!organization) redirect({ href: "/home", locale });

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <ProtectedHeader user={user!} />
        <ProposalSheetView orgId={organization!.id} proposalId={id} />
      </div>
    </main>
  );
}
