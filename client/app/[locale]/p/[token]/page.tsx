import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { getPublicRenderedSpecificationServer } from "@/lib/auth/server";
import { specificationsEndpoints } from "@/services/specifications";

import { SpecSheetContent } from "../../specifications/[id]/specification-sheet-view";


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
      <div className="mx-auto flex min-h-dvh max-w-[1400px] flex-col px-6 py-8 md:px-10 md:py-12 print:max-w-none print:p-6">
        {/*
          Public-viewer banner — subtle heads-up that the link is
          shareable and revocable, printed and visible to any client
          who opens the URL. Hidden on print so the rendered PDF
          matches the authenticated download byte-for-byte.
        */}
        <section className="border-2 border-ink-500 bg-ink-100 px-4 py-2 font-mono text-[10px] tracking-widest uppercase text-ink-700 print:hidden">
          {tSpecs("public.banner")}
        </section>

        <div className="mt-8 flex items-center justify-end print:hidden">
          <a
            href={specificationsEndpoints.publicPdf(token, { download: true })}
            download
            className="inline-flex items-center justify-center rounded-none border-2 border-ink-1000 bg-ink-0 px-4 py-1.5 text-sm font-bold tracking-wider uppercase text-ink-1000 transition-colors hover:bg-ink-100"
          >
            {tSpecs("detail.download_pdf")}
          </a>
        </div>

        <div className="mt-6">
          <SpecSheetContent rendered={rendered} />
        </div>

        <footer className="mt-10 flex items-center justify-between border-t-2 border-ink-1000 pt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500 print:hidden">
          <span>{tSpecs("public.footer")}</span>
          <span>{tCommon("brand")}</span>
        </footer>
      </div>
    </main>
  );
}
