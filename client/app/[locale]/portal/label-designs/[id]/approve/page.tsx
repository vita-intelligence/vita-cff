"use client";

import { use, useState } from "react";
import { FileSignature } from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { useRouter } from "@/i18n/navigation";
import {
  usePortalApprove,
  usePortalLabelDesign,
} from "@/services/label-design";


export default function CustomerApprovePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { data } = usePortalLabelDesign(id);
  const approve = usePortalApprove(id);

  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);

  const pdfUrl = data?.current_revision_detail?.artwork_pdf_url || "";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!signature.trim()) {
      setError("Please type your name to sign.");
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

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="APPROVE LABEL"
        title="Review and sign off"
        subtitle="Our team’s scientist + director have approved the artwork. Once you sign, this label is locked in for production."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Eyebrow>FINAL ARTWORK</Eyebrow>
          {pdfUrl ? (
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 border-2 border-black bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-[0.18em] hover:bg-neutral-100"
            >
              Open artwork PDF
            </a>
          ) : (
            <p className="mt-3 text-sm text-neutral-500">
              No artwork attached yet.
            </p>
          )}
          {pdfUrl ? (
            <object
              data={pdfUrl}
              type="application/pdf"
              className="mt-4 h-[600px] w-full border-2 border-black"
            >
              <p className="p-4 text-sm text-neutral-500">
                Your browser can’t preview PDFs inline.{" "}
                <a href={pdfUrl} className="underline">
                  Open in a new tab
                </a>
                .
              </p>
            </object>
          ) : null}
        </Card>

        <Card>
          <Eyebrow>SIGN-OFF</Eyebrow>
          <form onSubmit={onSubmit} className="mt-3 space-y-3">
            <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
              Type your full name to sign
            </label>
            <input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder="Sign here"
              className="w-full border-2 border-black px-2 py-2 font-mono text-sm"
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
      </div>
    </PortalShell>
  );
}
