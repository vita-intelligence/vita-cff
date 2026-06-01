"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Brave's built-in PDF plugin refuses to render in embedded
// contexts (``<iframe>`` / ``<embed>`` / ``<object>`` all fail
// with ``ERR_CONNECTION_REFUSED`` even when the file fetches
// fine via curl). Rendering via PDF.js to a canvas bypasses the
// browser's PDF plugin entirely, so the page looks identical
// in every browser regardless of plugin-policy quirks.
//
// The worker is shipped as a side-bundle by ``react-pdf``;
// pointing at the matching version on jsdelivr keeps the dev
// experience zero-config (no extra public/ copies, no custom
// Webpack rule). For prod we could self-host the worker file,
// but the current PDF preview surface is fine on a CDN — it's
// a static asset, not user data.
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export function PdfPreview({
  url,
  heightClassName = "h-[680px]",
  compact = false,
}: {
  url: string;
  heightClassName?: string;
  /** Hides the paging footer + chrome — for thumbnails inside
   *  dense list rows where the parent is the size hint. */
  compact?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);
  const [page, setPage] = useState(1);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset paging when the URL flips (e.g. designer uploads a
    // new revision while the workspace is open).
    setPage(1);
    setPageCount(0);
    setError(null);
  }, [url]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    // Measure the PARENT, not this element. If we observe the
    // element that hosts the PDF and the PDF renders even
    // slightly wider than expected, the host grows → RO fires
    // with the bigger width → Page re-renders bigger → host
    // grows again → the feedback loop diverges, dragging the
    // whole page wider than the viewport. The parent's width
    // is fixed by the surrounding layout (grid cell / card),
    // so observing it gives us a stable size hint that the PDF
    // can never escape.
    const parent = el.parentElement ?? el;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      // Inset a touch so the canvas doesn't kiss the borders.
      setContainerWidth(Math.max(0, w - 16));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const onLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setPageCount(numPages);
  }, []);

  const onLoadError = useCallback((err: Error) => {
    setError(err?.message ?? "Failed to load PDF.");
  }, []);

  return (
    // ``min-w-0`` is the load-bearing class here. Flex children
    // inherit ``min-width: auto`` which lets a canvas-rendered PDF
    // page punch through every ancestor's width constraint when
    // the file's intrinsic page width is bigger than the
    // viewport. Setting ``min-w-0`` (and ``overflow-hidden`` as a
    // belt-and-braces guard for the rare browser that still
    // miscalculates) keeps the preview boxed inside its column on
    // 360px phones.
    <div
      ref={containerRef}
      className={`flex ${heightClassName} w-full min-w-0 max-w-full flex-col items-stretch overflow-hidden bg-ink-50`}
    >
      <div className="flex min-w-0 flex-1 items-start justify-center overflow-auto p-2">
        <Document
          file={url}
          onLoadSuccess={onLoadSuccess}
          onLoadError={onLoadError}
          loading={
            <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading PDF…
            </div>
          }
          error={
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-rose-600">
              {error ?? "Couldn't render this PDF."}
            </div>
          }
        >
          {pageCount > 0 && containerWidth > 0 ? (
            <Page
              pageNumber={page}
              width={containerWidth}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          ) : null}
        </Document>
      </div>
      {pageCount > 1 && !compact ? (
        <div className="flex items-center justify-between gap-2 border-t border-ink-100 bg-ink-0 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-ink-50 px-2 text-[11px] text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft className="h-3 w-3" /> Prev
          </button>
          <span className="text-[11px] text-ink-600">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-ink-50 px-2 text-[11px] text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next <ChevronRight className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
