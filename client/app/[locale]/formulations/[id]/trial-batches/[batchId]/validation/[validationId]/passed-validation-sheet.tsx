"use client";

import { Button } from "@heroui/react";
import { Download, Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

interface Props {
  orgId: string;
  validationId: string;
}

/**
 * Renders the WeasyPrint-templated validation sheet in an iframe
 * (browser preview) with Print + Download buttons. Shown in place of
 * the editor once the validation reaches ``passed`` — the record is
 * final, so QA sees the document form instead of editable fields.
 *
 * Print uses ``iframe.contentWindow.print()`` so the browser's print
 * dialog targets the sheet HTML directly (not the parent shell).
 * Download hits the same endpoint with ``?download=1`` — the BE
 * flips ``Content-Disposition`` to ``attachment``.
 */
export function PassedValidationSheet({ orgId, validationId }: Props) {
  const tV = useTranslations("product_validation");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loading, setLoading] = useState(true);

  // Same-origin path — the Next.js rewrite at `/api/*` forwards to
  // Django. Going through the rewrite (not a direct
  // `${NEXT_PUBLIC_API_URL}/api/...` URL) means the iframe request
  // carries the session cookie without a cross-origin dance.
  // Trailing slash matches Django's ``APPEND_SLASH = True`` route
  // convention — without it, Django 302s to the slashed variant
  // which the iframe can't follow cleanly.
  const htmlSrc =
    `/api/organizations/${encodeURIComponent(orgId)}` +
    `/product-validations/${encodeURIComponent(validationId)}/sheet.html/`;
  const pdfHref = `/api/organizations/${encodeURIComponent(orgId)}/product-validations/${encodeURIComponent(validationId)}/sheet.pdf/?download=1`;

  const handlePrint = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.focus();
      win.print();
    } catch {
      // Cross-origin protections (shouldn't hit us — same-origin
      // proxy) or a still-loading frame. Silently no-op; the
      // Download button is the escape hatch.
    }
  };

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-4 shadow-sm ring-1 ring-ink-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-ink-700">
          {tV("sheet_title")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            onClick={handlePrint}
          >
            <Printer className="h-3.5 w-3.5" />
            {tV("sheet_print")}
          </Button>
          <a
            href={pdfHref}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Download className="h-3.5 w-3.5" />
            {tV("sheet_download")}
          </a>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg bg-white">
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-xs text-ink-500">
            {tV("sheet_loading")}
          </div>
        ) : null}
        <iframe
          ref={iframeRef}
          src={htmlSrc}
          title={tV("sheet_title")}
          onLoad={() => setLoading(false)}
          onError={() => setLoading(false)}
          className="block h-[1200px] w-full border-0 bg-white"
        />
      </div>
    </section>
  );
}
