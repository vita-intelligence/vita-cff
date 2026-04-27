import { Download, Info, PoundSterling } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { KioskCommentsPanel } from "@/components/comments/kiosk/kiosk-comments-panel";
import { getPublicRenderedSpecificationServer } from "@/lib/auth/server";
import { specificationsEndpoints } from "@/services/specifications";

import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";
import { KioskAcceptButton } from "./kiosk-accept-button";


/**
 * Public, token-gated spec sheet preview.
 *
 * Route lives at ``/<locale>/p/<token>`` — no authentication, no
 * navigation chrome. The server-side fetch deliberately omits any
 * cookies so a logged-in viewer sees the same output as a cold
 * client. Invalid or revoked tokens bubble up as 404.
 */
export default async function PublicSpecificationPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const rendered = await getPublicRenderedSpecificationServer(token);
  if (!rendered) {
    notFound();
  }

  const tSpecs = await getTranslations("specifications");
  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-4 py-6 sm:px-6 md:px-10 md:py-12 print:max-w-none print:p-6">
        {/*
          Public-viewer banner — subtle heads-up that the link is
          shareable and revocable, printed and visible to any client
          who opens the URL. Hidden on print so the rendered PDF
          matches the authenticated download byte-for-byte.
        */}
        <section className="flex items-center gap-2 rounded-xl bg-orange-50 px-4 py-2.5 text-sm text-orange-800 ring-1 ring-inset ring-orange-200 print:hidden">
          <Info className="h-4 w-4 shrink-0" />
          <span>{tSpecs("public.banner")}</span>
        </section>

        <div className="mt-6 flex items-center justify-end print:hidden">
          <a
            href={specificationsEndpoints.publicPdf(token, { download: true })}
            download
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 transition-colors hover:bg-orange-600"
          >
            <Download className="h-4 w-4" />
            {tSpecs("detail.download_pdf")}
          </a>
        </div>

        <div className="mt-6">
          <SpecSheetContent rendered={rendered} />
        </div>

        {rendered.sheet.has_proposal ? (
          <section className="mt-8 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8 print:hidden">
            <header className="flex items-center gap-2 border-b border-ink-100 pb-3">
              <PoundSterling className="h-4 w-4 text-orange-600" />
              <h2 className="text-base font-semibold text-ink-1000">
                {tSpecs("public.proposal_heading")}
              </h2>
            </header>
            <p className="mt-3 text-sm text-ink-500">
              {tSpecs("public.proposal_body")}
            </p>
            {/* Public endpoint — AllowAny, so we can point the
                iframe directly at the API origin without the
                cross-site cookie dance. ``NEXT_PUBLIC_API_URL`` is
                the same base used by the auth client. */}
            <iframe
              src={`${process.env.NEXT_PUBLIC_API_URL ?? ""}/api/public/specifications/${token}/proposal/`}
              title={tSpecs("public.proposal_heading")}
              className="mt-4 h-[900px] w-full rounded-xl bg-ink-0 ring-1 ring-ink-200"
            />
          </section>
        ) : null}

        <div className="mt-8 print:hidden">
          <KioskAcceptButton
            token={token}
            sheetStatus={rendered.sheet.status}
            customerName={rendered.signatures.customer.name}
            customerSignedAt={rendered.signatures.customer.signed_at}
            customerSignatureImage={rendered.signatures.customer.image}
            hasProposal={Boolean(rendered.sheet.has_proposal)}
          />
        </div>

        <div id="comments" className="mt-8 scroll-mt-6 print:hidden">
          <KioskCommentsPanel token={token} />
        </div>

        <footer className="mt-10 flex items-center justify-between border-t border-ink-200 pt-6 text-xs text-ink-500 print:hidden">
          <span>{tSpecs("public.footer")}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
