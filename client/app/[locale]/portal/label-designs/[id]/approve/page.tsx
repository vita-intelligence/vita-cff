"use client";

import { use, useState } from "react";
import {
  ExternalLink,
  FileSignature,
  MessageSquareWarning,
} from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { useRouter } from "@/i18n/navigation";
import dynamic from "next/dynamic";

import { SignatureField } from "@/components/ui/signature-field";
import {
  usePortalApprove,
  usePortalLabelDesign,
  usePortalReject,
} from "@/services/label-design";

// PDF.js can't SSR — see ``pdf-preview.tsx`` header.
const PdfPreview = dynamic(
  () => import("@/components/pdf-preview").then((m) => m.PdfPreview),
  { ssr: false },
);


export default function CustomerApprovePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data } = usePortalLabelDesign(id);
  const approve = usePortalApprove(id);
  const reject = usePortalReject(id);

  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  const pdfUrl = data?.current_revision_detail?.artwork_pdf_url || "";
  // Artwork can be PDF, PNG, or JPG — pick the right inline render
  // by extension. The same backend FileField stores all three.
  const isImage = /\.(png|jpe?g|gif|webp|avif)(?:\?|#|$)/i.test(pdfUrl);
  const isPdf = /\.pdf(?:\?|#|$)/i.test(pdfUrl);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!signature) {
      setError("Please draw your signature to sign.");
      return;
    }
    try {
      await approve.mutateAsync(signature);
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Approval failed.";
      setError(detail);
    }
  };

  const onReject = async (e: React.FormEvent) => {
    e.preventDefault();
    setRejectError(null);
    if (!rejectReason.trim()) {
      setRejectError("Please tell us what to change.");
      return;
    }
    try {
      await reject.mutateAsync(rejectReason);
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Could not submit your request.";
      setRejectError(detail);
    }
  };

  // Route the back link at the parent project. While the label
  // design detail is fetching we fall back to the products index so
  // the arrow never points at a dead URL.
  const projectHref = data?.formulation
    ? `/portal/products/${data.formulation}`
    : "/portal/products";

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="APPROVE LABEL"
        title="Review and sign off"
        subtitle="Our team’s scientist + director have approved the artwork. Once you sign, this label is locked in for production."
        back={{ href: projectHref, label: "Back to project" }}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden lg:col-span-2">
          {/* Header row — eyebrow on the left, "open in new tab"
              action on the right. ``Eyebrow`` renders as an inline
              span so we need an explicit flex wrapper here; without
              it the button collapsed onto the same line as the
              label and read as a stuck-on suffix. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Eyebrow>FINAL ARTWORK</Eyebrow>
            {pdfUrl ? (
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 border-2 border-black bg-white px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.15em] hover:bg-neutral-100"
              >
                <ExternalLink className="h-3 w-3" />
                Open in new tab
              </a>
            ) : null}
          </div>
          {!pdfUrl ? (
            <p className="mt-3 text-sm text-neutral-500">
              No artwork attached yet.
            </p>
          ) : null}
          {pdfUrl && isImage ? (
            <div className="mt-4 flex h-[420px] w-full min-w-0 max-w-full items-center justify-center overflow-hidden border-2 border-black bg-neutral-50 p-4 sm:h-[520px] lg:h-[600px]">
              <img
                src={pdfUrl}
                alt="Final artwork"
                className="max-h-full max-w-full object-contain"
              />
            </div>
          ) : pdfUrl && isPdf ? (
            <div className="mt-4 min-w-0 max-w-full overflow-hidden border-2 border-black">
              <PdfPreview
                url={pdfUrl}
                heightClassName="h-[420px] sm:h-[520px] lg:h-[600px]"
              />
            </div>
          ) : null}
        </Card>

        <div className="space-y-4">
          <Card>
            <Eyebrow>SIGN-OFF</Eyebrow>
            <form onSubmit={onSubmit} className="mt-3 space-y-3">
              <SignatureField
                label="Your signature"
                value={signature}
                onChange={setSignature}
                ariaLabel="Customer signature"
                required
                tone="portal"
              />
              <p className="text-[11px] text-neutral-500">
                By signing, you accept this artwork as the final label for
                production. We’ll keep a tamper-evident record of this sign-off.
              </p>
              {error ? (
                <p className="text-sm text-red-700">{error}</p>
              ) : null}
              <button
                type="submit"
                disabled={approve.isPending}
                className="inline-flex w-full items-center justify-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                <FileSignature className="h-4 w-4" />
                {approve.isPending ? "Signing…" : "Approve & sign"}
              </button>
            </form>
          </Card>

          {/* Reject path — sits right under the sign-off card so a
              customer who's not happy doesn't have to back-navigate
              to the detail page hunting for the reject link. Same
              page, two clear paths. */}
          <Card>
            <Eyebrow>NOT QUITE RIGHT?</Eyebrow>
            <p className="mt-1 text-sm text-neutral-700">
              Request changes instead. Our team will revise the artwork and
              re-submit it for your approval.
            </p>
            <form onSubmit={onReject} className="mt-3 space-y-3">
              <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
                What needs to change?
              </label>
              <textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={5}
                placeholder="Be as specific as you can — colours, copy, layout, icons…"
                className="w-full border-2 border-black px-2 py-1.5 text-sm"
              />
              {rejectError ? (
                <p className="text-sm text-red-700">{rejectError}</p>
              ) : null}
              <button
                type="submit"
                disabled={reject.isPending}
                className="inline-flex w-full items-center justify-center gap-2 border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black hover:bg-neutral-100 disabled:opacity-50"
              >
                <MessageSquareWarning className="h-4 w-4" />
                {reject.isPending ? "Sending…" : "Request changes"}
              </button>
            </form>
          </Card>
        </div>
      </div>
    </PortalShell>
  );
}
