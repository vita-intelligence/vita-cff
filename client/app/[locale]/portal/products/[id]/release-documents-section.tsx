import { PackageCheck } from "lucide-react";
import { Eyebrow } from "@/components/portal/brutalist";

export interface ReleaseDocument {
  readonly uuid: string;
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly uploaded_at: string;
}

const RELEASE_DOC_KIND_LABEL: Record<string, string> = {
  coa: "Certificate of Analysis",
  bmr: "Batch Manufacturing Record",
  micro: "Microbiological report",
  label_proof: "Label proof",
  retain_sample: "Retain-sample photo",
  other: "Other release document",
};

/**
 * BRCGS § 5.6 evidence pack. Renders once PSP has attached at least
 * one release document to the CO's root MO. Files stream through
 * ``/api/portal/products/[id]/release-documents/[uuid]/`` — PDFs
 * render inline in a new tab, other formats suggest a filename
 * download (server-side Content-Disposition drives the browser).
 */
export function ReleaseDocumentsSection({
  documents,
  productId,
}: {
  documents: ReadonlyArray<ReleaseDocument>;
  productId: string;
}) {
  return (
    <section className="mb-10">
      <Eyebrow>Release documents</Eyebrow>
      <div className="mt-3 border border-black bg-white p-5">
        <div className="mb-3 flex items-center gap-2">
          <PackageCheck className="size-4" aria-hidden />
          <p className="text-sm font-semibold uppercase tracking-widest">
            Compliance evidence
          </p>
        </div>
        <p className="mb-3 text-xs text-black/60">
          Compliance evidence attached to this batch: CoA, batch record,
          micro report, label proof, retain-sample photos. Click any row
          to open.
        </p>
        <ul className="space-y-1.5">
          {documents.map((doc) => (
            <li
              key={doc.uuid}
              className="flex items-center justify-between gap-3 border border-black/60 bg-neutral-50 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">
                  {RELEASE_DOC_KIND_LABEL[doc.kind] ?? doc.kind}
                </p>
                <p className="truncate text-[11px] text-black/60">
                  {doc.filename}
                </p>
              </div>
              <a
                href={`/api/portal/products/${encodeURIComponent(productId)}/release-documents/${encodeURIComponent(doc.uuid)}/`}
                target="_blank"
                rel="noopener"
                className="shrink-0 border border-black bg-black px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white hover:bg-neutral-900"
              >
                Open
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
