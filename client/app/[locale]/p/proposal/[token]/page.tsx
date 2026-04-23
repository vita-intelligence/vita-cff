import { Info } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { getPublicProposalKioskServer } from "@/lib/auth/server";

import { ProposalKioskView } from "./proposal-kiosk-view";


/**
 * Public proposal kiosk — route ``/<locale>/p/proposal/<token>``.
 *
 * Shared by sales after the proposal hits ``approved``, which auto-
 * rotates the ``public_token``. The client sees the proposal's
 * cover + one signature pad per document (the proposal itself plus
 * each attached specification sheet). Signatures are captured as
 * they draw; nothing advances until the finalize call runs and
 * every document carries a signature.
 *
 * The server-side fetch is cookie-free so a logged-in viewer sees
 * the same payload a cold client would — lets a scientist preview
 * the kiosk link without needing an incognito window.
 */
export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const kiosk = await getPublicProposalKioskServer(token);
  if (!kiosk) {
    notFound();
  }

  const tProposals = await getTranslations("proposals");
  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1100px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12">
        <section className="flex items-center gap-2 rounded-xl bg-orange-50 px-4 py-2.5 text-sm text-orange-800 ring-1 ring-inset ring-orange-200">
          <Info className="h-4 w-4 shrink-0" />
          <span>{tProposals("public.banner")}</span>
        </section>

        <ProposalKioskView token={token} kiosk={kiosk} />

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500">
          <span>{tProposals("public.footer")}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
